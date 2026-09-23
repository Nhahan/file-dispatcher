import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
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
  /** Hand out ready files oldest first, after a scan confirms no older file was missed. */
  ordered: boolean;
  stabilityThreshold: number;
  rescanInterval: number;
  /** Called when take() may return a file. */
  onAvailable: () => void;
  /** Called when the directory cannot be watched or listed. */
  onError: (error: Error) => void;
}

interface KnownEntry {
  // Scans started when the name was added; a scan only forgets names added before it started.
  addedAtScan: number;
  // Identity of the file last seen under this name, used to tell a replacement from a modification.
  identity: string | undefined;
}

interface Candidate {
  name: string;
  path: string;
  seq: number;
  identity: string;
  size: bigint;
  mtimeNs: bigint;
  createdMs: number;
  discoveredAt: number;
  due: number;
  // Ordered mode hands a file out only after this scan completes: a full listing taken after the
  // file was found reveals any older file whose watch event was dropped.
  confirmedByScan: number;
  // A watch event arrived while the file was being handled; check it again once released.
  recheck: boolean;
  state: 'settling' | 'checking' | 'ready' | 'taken';
}

// Rescans recover dropped events, so they can wait for a burst to pass.
const SCAN_DEBOUNCE_MS = 100;
// Periodic rescans may use at most about 1/SCAN_BUDGET of the time, so huge directories rescan less often.
const SCAN_BUDGET = 20;
const MIN_RETRY_MS = 500;
const MAX_RETRY_MS = 30_000;
// In ordered mode an older file still being written holds back newer ready files, but only for
// max(HOLD_MIN_MS, HOLD_THRESHOLDS × stabilityThreshold): a file appended forever must not stall the queue.
const HOLD_MIN_MS = 1000;
const HOLD_THRESHOLDS = 20;
// Bounds concurrent fs.stat calls.
const STAT_CONCURRENCY = 32;
// The callback API is several times faster than fs.promises for many small files.
const statBigInt = promisify((file: string, callback: (error: NodeJS.ErrnoException | null, stats: fs.BigIntStats) => void) =>
  fs.stat(file, { bigint: true }, callback),
);

/**
 * Finds every regular file created in a directory, once, after it has finished being written.
 *
 * fs.watch drops events when the kernel buffer overflows (Windows under almost any burst, Linux when
 * the event loop is busy) and reports a file before its content is written. Here a watch event only
 * points at a name to check; new files are also found by diffing directory listings, so a dropped
 * event cannot lose a file, and a file is handed out only after its size and mtime settle. Files are
 * identified by device, inode, and birth time, so a file replaced under a known name is new.
 *
 * Consumers pull files with take() and hand them back with release(), which gives natural
 * backpressure: nothing is read or buffered beyond file metadata.
 */
export class DirectoryWatcher {
  private readonly options: WatcherOptions;
  private watcher: fs.FSWatcher | undefined;
  private periodicTimer: NodeJS.Timeout | undefined;
  private scanTimer: NodeJS.Timeout | undefined;
  private settleTimer: NodeJS.Timeout | undefined;
  private eventFlush: NodeJS.Immediate | undefined;
  private holdTimer: NodeJS.Timeout | undefined;
  private stopped = false;
  private scanning = false;
  private scanRequested = false;
  private lastScanError: string | undefined;
  private scanFailures = 0;
  private lastScanMs = 0;
  private nextSeq = 0;
  private scansStarted = 0;
  private scansCompleted = 0;
  private newNames = new Set<string>();
  private changedNames = new Set<string>();
  private readonly known = new Map<string, KnownEntry>();
  private readonly candidates = new Map<string, Candidate>();
  // Every candidate waits the same threshold, so due times grow in insertion order and a FIFO suffices.
  private readonly settling = new Queue<Candidate>();
  private readonly ready = new Queue<Candidate>();
  // Ordered mode: ready files, and files not yet ready that may hold them back, both oldest first.
  private readonly ordered = new Heap<Candidate>(byCreation);
  private readonly pending = new Heap<Candidate>(byCreation);
  private readonly holdMs: number;

  constructor(options: WatcherOptions) {
    this.options = options;
    this.holdMs = Math.max(HOLD_MIN_MS, HOLD_THRESHOLDS * options.stabilityThreshold);
  }

  /** Starts watching. Throws if the directory cannot be read. */
  start(): void {
    // Watch first so files created while the baseline is read still produce events.
    this.watch(true);

    let names: string[];
    try {
      names = fs.readdirSync(this.options.directory);
    } catch (error) {
      this.watcher?.close();
      throw error;
    }

    for (const name of names) {
      this.known.set(name, { addedAtScan: 0, identity: undefined });
    }
    const matching = names.filter((name) => this.options.filter(name));
    if (this.options.existing) {
      // The baseline is a full listing, which counts as scan 0 for ordering.
      this.track(this.addCandidates(matching, 0));
    } else {
      // Record identities so a file later replaced under one of these names is recognized as new.
      this.track(this.recordIdentities(matching));
    }
    this.schedulePeriodic();
  }

  /** Stops watching. Files not yet taken are discarded. */
  stop(): void {
    this.stopped = true;
    this.watcher?.close();
    this.watcher = undefined;
    clearTimeout(this.periodicTimer);
    clearTimeout(this.scanTimer);
    clearTimeout(this.settleTimer);
    clearImmediate(this.eventFlush);
    clearTimeout(this.holdTimer);
    this.known.clear();
    this.candidates.clear();
    this.settling.clear();
    this.ready.clear();
    this.ordered.clear();
    this.pending.clear();
  }

  /** Returns the next file ready to be processed, if any. */
  take(): ReadyFile | undefined {
    if (this.stopped) {
      return undefined;
    }

    let next: Candidate | undefined;
    if (this.options.ordered) {
      const oldest = this.ordered.peek((candidate) => this.isCurrent(candidate, 'ready'));
      if (!oldest) {
        return undefined;
      }

      // An older file that was found but is still being written goes first, within the hold limit.
      const now = performance.now();
      const holding = this.pending.peek(
        (candidate) =>
          (this.isCurrent(candidate, 'settling') || this.isCurrent(candidate, 'checking')) &&
          now - candidate.discoveredAt < this.holdMs,
      );
      if (holding && byCreation(holding, oldest) < 0) {
        this.wakeAfter(holding.discoveredAt + this.holdMs - now);
        return undefined;
      }
      if (oldest.confirmedByScan <= this.scansCompleted) {
        next = this.ordered.pop();
      }
    } else {
      next = this.ready.shift((candidate) => this.isCurrent(candidate, 'ready'));
    }

    if (!next) {
      return undefined;
    }
    next.state = 'taken';
    return { name: next.name, path: next.path, size: Number(next.size), createdMs: next.createdMs };
  }

  /**
   * Marks a taken file as finished. Pass `removed` when the consumer deleted or moved it, so a file
   * created again under the same name is found without waiting for a rescan to notice the removal.
   */
  release(file: ReadyFile, removed = false): void {
    const candidate = this.candidates.get(file.name);
    if (candidate?.state !== 'taken') {
      return;
    }

    this.candidates.delete(file.name);
    if (removed) {
      this.known.delete(file.name);
    } else if (candidate.recheck) {
      this.queueName(file.name);
    }
  }

  private wakeAfter(ms: number): void {
    clearTimeout(this.holdTimer);
    this.holdTimer = setTimeout(() => this.options.onAvailable(), Math.max(0, ms));
  }

  private watch(initial: boolean): void {
    // libuv on Windows aborts when a watched 8.3 short path (C:\Users\RUNNER~1) differs from the long
    // path it reports, so watch the real path. Handed-out paths keep the directory as given.
    let watcher: fs.FSWatcher;
    try {
      watcher = fs.watch(fs.realpathSync.native(this.options.directory), { persistent: true }, (_, name) =>
        name ? this.queueName(name.toString()) : this.requestScan(),
      );
    } catch (error) {
      if (initial) {
        throw error;
      }
      return;
    }

    watcher.on('error', (error) => {
      // The watcher is unusable after an error; rescans keep running and re-watch once the directory lists again.
      watcher.close();
      if (this.watcher === watcher) {
        this.watcher = undefined;
      }
      if (!this.stopped) {
        this.options.onError(error);
        this.requestScan();
      }
    });
    this.watcher = watcher;
  }

  // Watch events name a file to check; new names also trigger a rescan in case other events were dropped.
  private queueName(name: string): void {
    if (this.stopped) {
      return;
    }

    const entry = this.known.get(name);
    if (!entry) {
      this.known.set(name, { addedAtScan: this.scansStarted, identity: undefined });
      if (this.options.filter(name)) {
        this.newNames.add(name);
      }
      this.requestScan();
    } else if (this.options.filter(name)) {
      const candidate = this.candidates.get(name);
      if (candidate?.state === 'taken') {
        candidate.recheck = true;
        return;
      }
      if (candidate) {
        // Settling already checks it again.
        return;
      }
      this.changedNames.add(name);
    } else {
      return;
    }

    this.eventFlush ??= setImmediate(() => {
      this.eventFlush = undefined;
      const added = [...this.newNames];
      const changed = [...this.changedNames];
      this.newNames.clear();
      this.changedNames.clear();
      this.track(this.addCandidates(added, this.scansStarted + 1));
      this.track(this.checkChanged(changed));
    });
  }

  // A known name changed: forget it if removed, and treat it as new if a different file replaced it.
  private async checkChanged(names: string[]): Promise<void> {
    if (names.length === 0) {
      return;
    }

    const observed = await this.statAll(names);
    if (this.stopped) {
      return;
    }

    const replaced: string[] = [];
    for (const { name, stats } of observed) {
      const entry = this.known.get(name);
      if (!entry || this.candidates.has(name)) {
        continue;
      }
      if (!stats) {
        this.known.delete(name);
      } else if (stats.isFile()) {
        const identity = identityOf(stats);
        if (entry.identity === undefined) {
          entry.identity = identity;
        } else if (entry.identity !== identity) {
          entry.addedAtScan = this.scansStarted;
          replaced.push(name);
        }
      }
    }

    if (replaced.length > 0) {
      await this.addCandidates(replaced, this.scansStarted + 1);
      this.requestScan();
    }
  }

  private async recordIdentities(names: string[]): Promise<void> {
    const observed = await this.statAll(names);
    for (const { name, stats } of observed) {
      const entry = this.known.get(name);
      if (entry && entry.identity === undefined && stats?.isFile()) {
        entry.identity = identityOf(stats);
      }
    }
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

  private schedulePeriodic(): void {
    if (this.stopped || this.options.rescanInterval === 0) {
      return;
    }

    clearTimeout(this.periodicTimer);
    const delay = Math.max(this.options.rescanInterval, this.lastScanMs * SCAN_BUDGET);
    this.periodicTimer = setTimeout(() => this.requestScan(), delay);
  }

  private async scan(): Promise<void> {
    const scanId = ++this.scansStarted;
    const startedAt = performance.now();
    this.scanning = true;
    this.scanRequested = false;

    try {
      const entries = await fsp.readdir(this.options.directory, { withFileTypes: true });
      if (this.stopped) {
        return;
      }

      const present = new Set<string>();
      const added: string[] = [];
      for (const entry of entries) {
        present.add(entry.name);
        if (!this.known.has(entry.name)) {
          this.known.set(entry.name, { addedAtScan: scanId, identity: undefined });
          if (!entry.isDirectory() && this.options.filter(entry.name)) {
            added.push(entry.name);
          }
        }
      }

      // Forget deleted names so a file created again under the same name is found again. Names
      // added after this scan started may postdate its listing, so they are kept until a later scan.
      for (const [name, entry] of this.known) {
        if (entry.addedAtScan < scanId && !present.has(name) && !this.candidates.has(name)) {
          this.known.delete(name);
        }
      }

      await this.addCandidates(added, scanId);
      if (this.stopped) {
        return;
      }

      this.scansCompleted = scanId;
      this.scanFailures = 0;
      this.lastScanError = undefined;
      this.lastScanMs = performance.now() - startedAt;
      if (!this.watcher) {
        this.watch(false);
      }
      this.options.onAvailable();
      this.schedulePeriodic();
    } catch (error) {
      if (this.stopped) {
        return;
      }

      const reason = toError(error);
      // A missing or unreadable directory fails every scan; report it once until a scan succeeds.
      if (reason.message !== this.lastScanError) {
        this.lastScanError = reason.message;
        this.options.onError(reason);
      }
      // Retry even with periodic rescans disabled: ordered mode waits for a completed scan.
      const delay = Math.min(MAX_RETRY_MS, MIN_RETRY_MS * 2 ** this.scanFailures++);
      clearTimeout(this.periodicTimer);
      this.periodicTimer = setTimeout(() => this.requestScan(), delay);
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
    if (names.length === 0) {
      return;
    }

    const observed = await this.statAll(names);
    if (this.stopped) {
      return;
    }

    const now = performance.now();
    const due = now + this.options.stabilityThreshold;
    for (const { name, stats } of observed) {
      if (this.candidates.has(name)) {
        continue;
      }
      if (!stats) {
        // The event was for a removal (often of a file just handled). Forget the name so a file
        // created under it later is found; if one already exists, a rescan finds it.
        this.known.delete(name);
        continue;
      }
      if (!stats.isFile()) {
        continue;
      }

      const identity = identityOf(stats);
      const entry = this.known.get(name);
      if (entry) {
        entry.identity = identity;
      }
      const candidate: Candidate = {
        name,
        path: path.join(this.options.directory, name),
        seq: this.nextSeq++,
        identity,
        size: stats.size,
        mtimeNs: stats.mtimeNs,
        createdMs: Number(stats.birthtimeNs > 0n ? stats.birthtimeNs : stats.mtimeNs) / 1e6,
        discoveredAt: now,
        due,
        confirmedByScan,
        recheck: false,
        state: 'settling',
      };
      this.candidates.set(name, candidate);
      this.settling.push(candidate);
      if (this.options.ordered) {
        this.pending.push(candidate);
      }
    }

    this.scheduleSettle();
  }

  private scheduleSettle(): void {
    if (this.stopped || this.settleTimer) {
      return;
    }

    const next = this.settling.peek((candidate) => this.isCurrent(candidate, 'settling'));
    if (!next) {
      return;
    }

    this.settleTimer = setTimeout(() => {
      this.settleTimer = undefined;
      this.track(this.settle());
    }, Math.max(0, next.due - performance.now()));
  }

  private async settle(): Promise<void> {
    const now = performance.now();
    const due: Candidate[] = [];
    for (;;) {
      const next = this.settling.peek((candidate) => this.isCurrent(candidate, 'settling'));
      if (!next || next.due > now) {
        break;
      }
      this.settling.shift();
      next.state = 'checking';
      due.push(next);
    }

    const observed = await this.statAll(due.map((candidate) => candidate.name));
    if (this.stopped) {
      return;
    }

    let changed = false;
    observed.forEach(({ stats }, index) => {
      const candidate = due[index] as Candidate;
      if (!stats?.isFile()) {
        // Deleted or replaced by a non-file before it settled.
        this.candidates.delete(candidate.name);
        this.known.delete(candidate.name);
        changed = true;
        return;
      }

      const identity = identityOf(stats);
      if (
        this.options.stabilityThreshold > 0 &&
        (identity !== candidate.identity || stats.size !== candidate.size || stats.mtimeNs !== candidate.mtimeNs)
      ) {
        candidate.identity = identity;
        candidate.size = stats.size;
        candidate.mtimeNs = stats.mtimeNs;
        candidate.due = performance.now() + this.options.stabilityThreshold;
        candidate.state = 'settling';
        this.settling.push(candidate);
        return;
      }

      candidate.identity = identity;
      candidate.size = stats.size;
      candidate.state = 'ready';
      const entry = this.known.get(candidate.name);
      if (entry) {
        entry.identity = identity;
      }
      (this.options.ordered ? this.ordered : this.ready).push(candidate);
      changed = true;
    });

    if (changed) {
      this.options.onAvailable();
    }
    this.scheduleSettle();
  }

  private async statAll(names: string[]): Promise<{ name: string; stats: fs.BigIntStats | undefined }[]> {
    return mapLimit(names, STAT_CONCURRENCY, async (name) => {
      try {
        return { name, stats: await statBigInt(path.join(this.options.directory, name)) };
      } catch {
        return { name, stats: undefined };
      }
    });
  }

  private isCurrent(candidate: Candidate, state: Candidate['state']): boolean {
    return candidate.state === state && this.candidates.get(candidate.name) === candidate;
  }

  private track(task: Promise<void>): void {
    task.catch((error: unknown) => {
      if (!this.stopped) {
        this.options.onError(toError(error));
      }
    });
  }
}

function byCreation(a: Candidate, b: Candidate): number {
  return a.createdMs - b.createdMs || a.name.localeCompare(b.name) || a.seq - b.seq;
}

function identityOf(stats: fs.BigIntStats): string {
  return `${stats.dev}:${stats.ino}:${stats.birthtimeNs}`;
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
