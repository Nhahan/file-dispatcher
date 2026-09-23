import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

export interface ReadyFile {
  readonly name: string;
  readonly path: string;
  readonly size: number;
  readonly createdMs: number;
}

export interface WatcherOptions {
  directory: string;
  filter: (name: string) => boolean;
  /** Treat files present at start as new. */
  existing: boolean;
  /** Hand out files strictly in creation order. */
  ordered: boolean;
  stabilityThreshold: number;
  rescanInterval: number;
  /** Called when take() may return a file. */
  onAvailable: () => void;
  /** Called when the directory cannot be watched or listed. */
  onError: (error: Error) => void;
}

interface Candidate extends ReadyFile {
  seq: number;
  mtimeMs: number;
  size: number;
  due: number;
  // ordered mode hands a file out only after this scan completes: a full listing taken after the
  // file was found reveals any older file whose watch event was dropped.
  confirmedByScan: number;
  state: 'settling' | 'checking' | 'ready' | 'taken';
}

// Watch events add their file right away; rescans only recover dropped events, so they can wait.
const SCAN_DEBOUNCE_MS = 100;
// Bounds concurrent fs.stat calls while files settle.
const STAT_CONCURRENCY = 32;
// The callback API is several times faster than fs.promises for many small files.
const stat = promisify(fs.stat);

/**
 * Finds every regular file created in a directory, once, after it has finished being written.
 *
 * fs.watch drops events when the kernel buffer overflows (Windows under almost any burst, Linux when
 * the event loop is busy) and reports a file before its content is written. Here watch events only
 * add their file early and trigger a rescan; new files are found by diffing directory listings, so a
 * dropped event cannot lose a file, and a file is handed out only after its size and mtime settle.
 *
 * Consumers pull files with take() and hand them back with release(), which gives natural
 * backpressure: nothing is read or buffered beyond file metadata.
 */
export class DirectoryWatcher {
  private readonly options: WatcherOptions;
  private watcher: fs.FSWatcher | undefined;
  private rescanTimer: NodeJS.Timeout | undefined;
  private scanTimer: NodeJS.Timeout | undefined;
  private settleTimer: NodeJS.Timeout | undefined;
  private eventFlush: NodeJS.Immediate | undefined;
  private stopped = false;
  private scanning = false;
  private scanRequested = false;
  private lastScanError: string | undefined;
  private nextSeq = 0;
  private scansStarted = 0;
  private scansCompleted = 0;
  private pendingNames: string[] = [];
  // Names in the directory, mapped to the number of scans started when each was added.
  private readonly known = new Map<string, number>();
  private readonly candidates = new Map<string, Candidate>();
  // Every candidate waits the same threshold, so due times grow in insertion order and a FIFO suffices.
  private readonly settling = new Queue<Candidate>();
  private readonly ready = new Queue<Candidate>();
  private readonly ordered = new Heap<Candidate>(
    (a, b) => a.createdMs - b.createdMs || a.name.localeCompare(b.name) || a.seq - b.seq,
  );

  constructor(options: WatcherOptions) {
    this.options = options;
  }

  /** Starts watching. Throws if the directory cannot be read. */
  start(): void {
    const { directory } = this.options;
    // libuv on Windows aborts when a watched 8.3 short path (C:\Users\RUNNER~1) differs from the long
    // path it reports, so watch the real path. Handed-out paths keep the directory as given.
    const watchPath = fs.realpathSync.native(directory);
    // Watch first so files created while the baseline is read still trigger a scan.
    const watcher = fs.watch(watchPath, { persistent: true }, (_, name) => {
      if (name) {
        this.addEventName(name.toString());
      }
      this.requestScan();
    });
    watcher.on('error', (error) => this.options.onError(error));

    let names: string[];
    try {
      names = fs.readdirSync(directory);
    } catch (error) {
      watcher.close();
      throw error;
    }

    this.watcher = watcher;
    for (const name of names) {
      this.known.set(name, 0);
    }
    if (this.options.existing) {
      // The baseline is a full listing, which counts as scan 0 for ordering.
      this.track(this.addCandidates(names.filter(this.options.filter), 0));
    }
    if (this.options.rescanInterval > 0) {
      this.rescanTimer = setInterval(() => this.requestScan(), this.options.rescanInterval);
    }
  }

  /** Stops watching. Files not yet taken are discarded. */
  stop(): void {
    this.stopped = true;
    this.watcher?.close();
    clearInterval(this.rescanTimer);
    clearTimeout(this.scanTimer);
    clearTimeout(this.settleTimer);
    clearImmediate(this.eventFlush);
    this.known.clear();
    this.candidates.clear();
    this.settling.clear();
    this.ready.clear();
    this.ordered.clear();
  }

  /** Returns the next file ready to be processed, if any. */
  take(): ReadyFile | undefined {
    if (this.stopped) {
      return undefined;
    }

    let next: Candidate | undefined;
    if (this.options.ordered) {
      // Wait for the oldest pending file even if newer ones are ready.
      const oldest = this.ordered.peek((candidate) => this.isCurrent(candidate) && candidate.state !== 'taken');
      if (oldest?.state === 'ready' && oldest.confirmedByScan <= this.scansCompleted) {
        next = this.ordered.pop();
      }
    } else {
      next = this.ready.shift((candidate) => this.isCurrent(candidate) && candidate.state === 'ready');
    }

    if (!next) {
      return undefined;
    }
    next.state = 'taken';
    return { name: next.name, path: next.path, size: next.size, createdMs: next.createdMs };
  }

  /**
   * Marks a taken file as finished. Pass `removed` when the consumer deleted or moved it, so a file
   * created again under the same name is found without waiting for a rescan to notice the removal.
   */
  release(file: ReadyFile, removed = false): void {
    const candidate = this.candidates.get(file.name);
    if (candidate?.state === 'taken') {
      this.candidates.delete(file.name);
      if (removed) {
        this.known.delete(file.name);
      }
    }
  }

  // Fast path: take new names straight from watch events instead of waiting for the next rescan.
  private addEventName(name: string): void {
    if (this.stopped || this.known.has(name) || !this.options.filter(name)) {
      return;
    }

    this.known.set(name, this.scansStarted);
    this.pendingNames.push(name);
    this.eventFlush ??= setImmediate(() => {
      this.eventFlush = undefined;
      const names = this.pendingNames;
      this.pendingNames = [];
      this.track(this.addCandidates(names, this.scansStarted + 1));
    });
  }

  private requestScan(): void {
    if (this.stopped) {
      return;
    }

    if (this.scanning) {
      this.scanRequested = true;
      return;
    }

    this.scanTimer ??= setTimeout(() => {
      this.scanTimer = undefined;
      this.track(this.scan());
    }, SCAN_DEBOUNCE_MS);
  }

  private async scan(): Promise<void> {
    const scanId = ++this.scansStarted;
    this.scanning = true;
    this.scanRequested = false;

    try {
      const entries = await fsp.readdir(this.options.directory, { withFileTypes: true });
      if (this.stopped) {
        return;
      }

      this.lastScanError = undefined;
      const present = new Set<string>();
      const added: string[] = [];
      for (const entry of entries) {
        present.add(entry.name);
        if (!this.known.has(entry.name)) {
          this.known.set(entry.name, scanId);
          if (!entry.isDirectory() && this.options.filter(entry.name)) {
            added.push(entry.name);
          }
        }
      }

      // Forget deleted names so a file created again under the same name is found again. Names
      // added after this scan started may postdate its listing, so they are kept until a later scan.
      for (const [name, addedAtScan] of this.known) {
        if (addedAtScan < scanId && !present.has(name) && !this.candidates.has(name)) {
          this.known.delete(name);
        }
      }

      await this.addCandidates(added, scanId);
      if (!this.stopped) {
        this.scansCompleted = scanId;
        this.options.onAvailable();
      }
    } catch (error) {
      if (!this.stopped) {
        const reason = toError(error);
        // A missing or unreadable directory fails every scan; report it once until a scan succeeds.
        if (reason.message !== this.lastScanError) {
          this.lastScanError = reason.message;
          this.options.onError(reason);
        }
      }
    } finally {
      if (!this.stopped) {
        this.scanning = false;
        if (this.scanRequested) {
          this.requestScan();
        }
      }
    }
  }

  private async addCandidates(names: string[], confirmedByScan: number): Promise<void> {
    const observed = await mapLimit(names, STAT_CONCURRENCY, async (name) => {
      try {
        return { name, stats: await stat(path.join(this.options.directory, name)) };
      } catch {
        return { name, stats: undefined };
      }
    });
    if (this.stopped) {
      return;
    }

    for (const entry of observed) {
      // The event was for a removal (often of a file just handled). Forget the name so a file created
      // under it later is found; if one already exists, the rescan its event requested finds it.
      if (!entry.stats && !this.candidates.has(entry.name)) {
        this.known.delete(entry.name);
      }
    }

    const due = Date.now() + this.options.stabilityThreshold;
    for (const entry of observed) {
      if (!entry.stats?.isFile() || this.candidates.has(entry.name)) {
        continue;
      }

      const candidate: Candidate = {
        name: entry.name,
        path: path.join(this.options.directory, entry.name),
        seq: this.nextSeq++,
        createdMs: entry.stats.birthtimeMs > 0 ? entry.stats.birthtimeMs : entry.stats.mtimeMs,
        size: entry.stats.size,
        mtimeMs: entry.stats.mtimeMs,
        due,
        confirmedByScan,
        state: 'settling',
      };
      this.candidates.set(candidate.name, candidate);
      this.settling.push(candidate);
      if (this.options.ordered) {
        this.ordered.push(candidate);
      }
    }

    this.scheduleSettle();
  }

  private scheduleSettle(): void {
    if (this.stopped || this.settleTimer) {
      return;
    }

    const next = this.settling.peek((candidate) => this.isCurrent(candidate) && candidate.state === 'settling');
    if (!next) {
      return;
    }

    this.settleTimer = setTimeout(() => {
      this.settleTimer = undefined;
      this.track(this.settle());
    }, Math.max(0, next.due - Date.now()));
  }

  private async settle(): Promise<void> {
    const now = Date.now();
    const due: Candidate[] = [];
    for (;;) {
      const next = this.settling.peek((candidate) => this.isCurrent(candidate) && candidate.state === 'settling');
      if (!next || next.due > now) {
        break;
      }
      this.settling.shift();
      next.state = 'checking';
      due.push(next);
    }

    let becameReady = false;
    await mapLimit(due, STAT_CONCURRENCY, async (candidate) => {
      let stats: fs.Stats | undefined;
      try {
        stats = await stat(candidate.path);
      } catch {
        stats = undefined;
      }

      if (this.stopped) {
        return;
      }

      if (!stats?.isFile()) {
        // Deleted or replaced before it settled.
        this.candidates.delete(candidate.name);
        this.known.delete(candidate.name);
      } else if (
        this.options.stabilityThreshold > 0 &&
        (stats.size !== candidate.size || stats.mtimeMs !== candidate.mtimeMs)
      ) {
        candidate.size = stats.size;
        candidate.mtimeMs = stats.mtimeMs;
        candidate.due = Date.now() + this.options.stabilityThreshold;
        candidate.state = 'settling';
        this.settling.push(candidate);
      } else {
        candidate.state = 'ready';
        becameReady = true;
        if (!this.options.ordered) {
          this.ready.push(candidate);
        }
      }
    });

    if (!this.stopped) {
      if (becameReady) {
        this.options.onAvailable();
      }
      this.scheduleSettle();
    }
  }

  private isCurrent(candidate: Candidate): boolean {
    return this.candidates.get(candidate.name) === candidate;
  }

  private track(task: Promise<void>): void {
    task.catch((error: unknown) => {
      if (!this.stopped) {
        this.options.onError(toError(error));
      }
    });
  }
}

export function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const current = index++;
      results[current] = await fn(items[current] as T);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Binary min-heap; entries rejected by `keep` are dropped when they reach the top. */
class Heap<T> {
  private items: T[] = [];

  constructor(private readonly compare: (a: T, b: T) => number) {}

  push(item: T): void {
    const items = this.items;
    items.push(item);
    let index = items.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.compare(items[index] as T, items[parent] as T) >= 0) {
        break;
      }
      [items[index], items[parent]] = [items[parent] as T, items[index] as T];
      index = parent;
    }
  }

  peek(keep: (item: T) => boolean = () => true): T | undefined {
    while (this.items.length > 0 && !keep(this.items[0] as T)) {
      this.pop();
    }
    return this.items[0];
  }

  pop(): T | undefined {
    const items = this.items;
    const top = items[0];
    const last = items.pop();
    if (items.length > 0 && last !== undefined) {
      items[0] = last;
      let index = 0;
      for (;;) {
        const left = index * 2 + 1;
        const right = left + 1;
        let smallest = index;
        if (left < items.length && this.compare(items[left] as T, items[smallest] as T) < 0) smallest = left;
        if (right < items.length && this.compare(items[right] as T, items[smallest] as T) < 0) smallest = right;
        if (smallest === index) break;
        [items[index], items[smallest]] = [items[smallest] as T, items[index] as T];
        index = smallest;
      }
    }
    return top;
  }

  clear(): void {
    this.items = [];
  }
}

/** FIFO queue with O(1) shift; entries rejected by `keep` are dropped when they reach the front. */
class Queue<T> {
  private items: T[] = [];
  private head = 0;

  push(item: T): void {
    this.items.push(item);
  }

  peek(keep: (item: T) => boolean = () => true): T | undefined {
    while (this.head < this.items.length) {
      const item = this.items[this.head] as T;
      if (keep(item)) {
        return item;
      }
      this.head += 1;
    }
    this.compact();
    return undefined;
  }

  shift(keep?: (item: T) => boolean): T | undefined {
    const item = this.peek(keep);
    if (item !== undefined) {
      this.head += 1;
      this.compact();
    }
    return item;
  }

  clear(): void {
    this.items = [];
    this.head = 0;
  }

  private compact(): void {
    if (this.head > 1024 && this.head * 2 > this.items.length) {
      this.items = this.items.slice(this.head);
      this.head = 0;
    }
  }
}
