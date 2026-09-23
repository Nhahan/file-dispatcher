import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

export enum FdMode {
  Async = 'FdMode.Async',
  Sync = 'FdMode.Sync',
}

export enum FdEventType {
  Success = 'FdEventType.Success',
  Fail = 'FdEventType.Fail',
}

export type FdEncoding = BufferEncoding | null;

/** File content type for an encoding: `string` for text encodings, `Buffer` for `null`. */
export type FdContent<E extends FdEncoding = 'utf8'> = E extends null ? Buffer : string;

export type FdInterceptor<E extends FdEncoding = 'utf8'> = (
  filePath: string,
  content: FdContent<E>,
) => FdContent<E> | Promise<FdContent<E>>;

export interface FileDispatcherOptions<E extends FdEncoding = 'utf8'> {
  /** Directory to watch. Default: `process.cwd()`. */
  path?: string;
  /** `FdMode.Async` reads files concurrently; `FdMode.Sync` dispatches one at a time in creation order. Default: `FdMode.Async`. */
  mode?: FdMode;
  /** Transforms content before it is dispatched. May be async. */
  interceptor?: FdInterceptor<E>;
  /** Only file names matching this pattern are dispatched. */
  pattern?: RegExp;
  /** Encoding used to read files, or `null` for a `Buffer`. Default: `'utf8'`. */
  encoding?: E;
  /** Maximum files read at once in `FdMode.Async`. Default: `16`. */
  concurrency?: number;
  /** Milliseconds a file's size and mtime must stay unchanged before it is read. Default: `50`. */
  stabilityThreshold?: number;
  /** Milliseconds between full directory rescans that run even without events. `0` disables them. Default: `1000`. */
  rescanInterval?: number;
}

interface Candidate {
  name: string;
  seq: number;
  createdMs: number;
  // FdMode.Sync dispatches a file only after this scan completes; a full listing taken after the
  // file was found reveals any older file whose watch event was dropped.
  confirmedByScan: number;
  size: number;
  mtimeMs: number;
  due: number;
  state: 'settling' | 'checking' | 'ready' | 'reading';
}

// Watch events add their file right away; rescans only recover dropped events, so they can wait.
const SCAN_DEBOUNCE_MS = 100;
// Bounds concurrent fs.stat calls while files settle.
const STAT_CONCURRENCY = 32;
// The callback APIs are several times faster than fs.promises for many small files.
const readFile = promisify(fs.readFile);
const stat = promisify(fs.stat);

/**
 * Emits every regular file created in a directory, once, after it has finished being written.
 *
 * fs.watch drops events when the kernel buffer overflows (Windows under almost any burst, Linux when
 * the event loop is busy) and reports a file before its content is written. Watch events here only
 * trigger a rescan; new files are found by diffing directory listings, so dropped events cannot lose
 * files, and each file is read only after its size and mtime stop changing.
 */
export class FileDispatcher<E extends FdEncoding = 'utf8'> extends EventEmitter {
  private readonly directory: string;
  private readonly mode: FdMode;
  private readonly interceptor: FdInterceptor<E> | undefined;
  private readonly pattern: RegExp | undefined;
  private readonly encoding: FdEncoding;
  private readonly concurrency: number;
  private readonly stabilityThreshold: number;
  private readonly rescanInterval: number;

  private watcher: fs.FSWatcher | undefined;
  private rescanTimer: NodeJS.Timeout | undefined;
  private scanTimer: NodeJS.Timeout | undefined;
  private settleTimer: NodeJS.Timeout | undefined;
  private running = false;
  private generation = 0;
  private scanning = false;
  private scanRequested = false;
  private lastScanError: string | undefined;
  private nextSeq = 0;
  private scansStarted = 0;
  private scansCompleted = 0;
  private active = 0;
  // Names in the directory, mapped to the number of scans started when each was added.
  private readonly known = new Map<string, number>();
  private readonly candidates = new Map<string, Candidate>();
  // Every candidate waits the same threshold, so due times grow in insertion order and a FIFO suffices.
  private readonly settling = new Queue<Candidate>();
  // FdMode.Async: files in the order they became ready.
  private readonly ready = new Queue<Candidate>();
  // FdMode.Sync: files by creation time.
  private readonly ordered = new Heap<Candidate>(
    (a, b) => a.createdMs - b.createdMs || a.name.localeCompare(b.name) || a.seq - b.seq,
  );
  private readonly inFlight = new Set<Promise<void>>();
  private pendingNames: string[] = [];
  private eventFlush: NodeJS.Immediate | undefined;

  constructor(options: FileDispatcherOptions<E> = {}) {
    super();

    const mode = options.mode ?? FdMode.Async;
    if (!Object.values(FdMode).includes(mode)) {
      throw new TypeError(`Invalid mode: ${String(mode)}`);
    }

    this.directory = path.resolve(options.path ?? process.cwd());
    this.mode = mode;
    this.interceptor = options.interceptor;
    this.pattern = options.pattern;
    this.encoding = options.encoding === undefined ? 'utf8' : options.encoding;
    this.concurrency = mode === FdMode.Sync ? 1 : positiveInteger(options.concurrency ?? 16, 'concurrency');
    this.stabilityThreshold = nonNegativeNumber(options.stabilityThreshold ?? 50, 'stabilityThreshold');
    this.rescanInterval = nonNegativeNumber(options.rescanInterval ?? 1000, 'rescanInterval');
  }

  /** Starts watching. Files that already exist are not dispatched. Throws if the directory cannot be read. */
  start(): void {
    if (this.running) {
      return;
    }

    // libuv on Windows aborts when a watched 8.3 short path (C:\Users\RUNNER~1) differs from the long
    // path it reports, so watch the real path. Dispatched paths keep the directory as given.
    const watchPath = fs.realpathSync.native(this.directory);
    // Watch first so files created while the baseline is read still trigger a scan.
    const watcher = fs.watch(watchPath, { persistent: true }, (_, name) => {
      if (name) {
        this.addEventName(name.toString());
      }
      this.requestScan();
    });
    watcher.on('error', (error) => this.fail(error));

    let names: string[];
    try {
      names = fs.readdirSync(this.directory);
    } catch (error) {
      watcher.close();
      throw error;
    }

    this.running = true;
    this.generation += 1;
    this.watcher = watcher;
    for (const name of names) {
      this.known.set(name, 0);
    }

    if (this.rescanInterval > 0) {
      this.rescanTimer = setInterval(() => this.requestScan(), this.rescanInterval);
    }
  }

  /** Stops watching and resolves once in-flight dispatches finish. Pending files are discarded. */
  async stop(): Promise<void> {
    if (this.running) {
      this.running = false;
      this.generation += 1;
      this.watcher?.close();
      this.watcher = undefined;
      clearInterval(this.rescanTimer);
      clearTimeout(this.scanTimer);
      clearTimeout(this.settleTimer);
      clearImmediate(this.eventFlush);
      this.eventFlush = undefined;
      this.pendingNames = [];
      this.rescanTimer = undefined;
      this.scanTimer = undefined;
      this.settleTimer = undefined;
      this.scanning = false;
      this.scanRequested = false;
      this.lastScanError = undefined;
      this.scansStarted = 0;
      this.scansCompleted = 0;
      this.active = 0;
      this.known.clear();
      this.candidates.clear();
      this.settling.clear();
      this.ready.clear();
      this.ordered.clear();
    }

    await Promise.all(this.inFlight);
  }

  override on(event: FdEventType.Success, listener: (filePath: string, content: FdContent<E>) => void): this;
  override on(event: FdEventType.Fail, listener: (error: Error, filePath?: string) => void): this;
  override on(event: string | symbol, listener: (...args: any[]) => void): this;
  override on(event: string | symbol, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }

  override once(event: FdEventType.Success, listener: (filePath: string, content: FdContent<E>) => void): this;
  override once(event: FdEventType.Fail, listener: (error: Error, filePath?: string) => void): this;
  override once(event: string | symbol, listener: (...args: any[]) => void): this;
  override once(event: string | symbol, listener: (...args: any[]) => void): this {
    return super.once(event, listener);
  }

  // Fast path: take new names straight from watch events instead of waiting for the next rescan.
  private addEventName(name: string): void {
    if (!this.running || this.known.has(name) || !this.matches(name)) {
      return;
    }

    this.known.set(name, this.scansStarted);
    this.pendingNames.push(name);
    this.eventFlush ??= setImmediate(() => {
      this.eventFlush = undefined;
      const names = this.pendingNames;
      this.pendingNames = [];
      this.track(this.addCandidates(names, this.generation, this.scansStarted + 1));
    });
  }

  private requestScan(): void {
    if (!this.running) {
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
    const generation = this.generation;
    const scanId = ++this.scansStarted;
    this.scanning = true;
    this.scanRequested = false;

    try {
      const entries = await fsp.readdir(this.directory, { withFileTypes: true });
      if (generation !== this.generation) {
        return;
      }

      this.lastScanError = undefined;
      const present = new Set<string>();
      const added: fs.Dirent[] = [];
      for (const entry of entries) {
        present.add(entry.name);
        if (!this.known.has(entry.name)) {
          this.known.set(entry.name, scanId);
          added.push(entry);
        }
      }

      // Forget deleted names so a file created again under the same name is dispatched again. Names
      // added after this scan started may postdate its listing, so they are kept until a later scan.
      for (const [name, addedAtScan] of this.known) {
        if (addedAtScan < scanId && !present.has(name) && !this.candidates.has(name)) {
          this.known.delete(name);
        }
      }

      const names = added
        .filter((entry) => !entry.isDirectory() && this.matches(entry.name))
        .map((entry) => entry.name);
      await this.addCandidates(names, generation, scanId);
      if (generation === this.generation) {
        this.scansCompleted = scanId;
        this.pump();
      }
    } catch (error) {
      if (generation === this.generation) {
        const message = error instanceof Error ? error.message : String(error);
        // A missing or unreadable directory fails every scan; report it once until a scan succeeds.
        if (message !== this.lastScanError) {
          this.lastScanError = message;
          this.fail(error);
        }
      }
    } finally {
      if (generation === this.generation) {
        this.scanning = false;
        if (this.scanRequested) {
          this.requestScan();
        }
      }
    }
  }

  private async addCandidates(names: string[], generation: number, confirmedByScan: number): Promise<void> {
    const observed = await mapLimit(names, STAT_CONCURRENCY, async (name) => {
      try {
        return { name, stats: await stat(path.join(this.directory, name)) };
      } catch {
        return undefined;
      }
    });
    if (generation !== this.generation) {
      return;
    }

    const files = observed.filter(
      (entry): entry is { name: string; stats: fs.Stats } => entry !== undefined && entry.stats.isFile(),
    );

    const now = Date.now();
    for (const { name, stats } of files) {
      const candidate: Candidate = {
        name,
        seq: this.nextSeq++,
        createdMs: creationTime(stats),
        confirmedByScan,
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        due: now + this.stabilityThreshold,
        state: 'settling',
      };
      this.candidates.set(name, candidate);
      this.settling.push(candidate);
      if (this.mode === FdMode.Sync) {
        this.ordered.push(candidate);
      }
    }

    this.scheduleSettle();
  }

  private scheduleSettle(): void {
    if (!this.running || this.settleTimer) {
      return;
    }

    const next = this.settling.peek((candidate) => this.isCurrent(candidate, 'settling'));
    if (!next) {
      return;
    }

    this.settleTimer = setTimeout(() => {
      this.settleTimer = undefined;
      this.track(this.settle());
    }, Math.max(0, next.due - Date.now()));
  }

  private async settle(): Promise<void> {
    const generation = this.generation;
    const now = Date.now();
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

    await mapLimit(due, STAT_CONCURRENCY, async (candidate) => {
      let stats: fs.Stats | undefined;
      try {
        stats = await stat(path.join(this.directory, candidate.name));
      } catch {
        stats = undefined;
      }

      if (generation !== this.generation) {
        return;
      }

      if (!stats?.isFile()) {
        // Deleted or replaced before it settled.
        this.candidates.delete(candidate.name);
        this.known.delete(candidate.name);
      } else if (this.stabilityThreshold > 0 && (stats.size !== candidate.size || stats.mtimeMs !== candidate.mtimeMs)) {
        candidate.size = stats.size;
        candidate.mtimeMs = stats.mtimeMs;
        candidate.due = Date.now() + this.stabilityThreshold;
        candidate.state = 'settling';
        this.settling.push(candidate);
      } else {
        candidate.state = 'ready';
        if (this.mode === FdMode.Async) {
          this.ready.push(candidate);
        }
      }
    });

    if (generation === this.generation) {
      this.pump();
      this.scheduleSettle();
    }
  }

  private pump(): void {
    while (this.running && this.active < this.concurrency) {
      const next = this.nextReady();
      if (!next) {
        return;
      }

      next.state = 'reading';
      this.active += 1;
      this.track(this.dispatch(next, this.generation));
    }
  }

  private nextReady(): Candidate | undefined {
    if (this.mode === FdMode.Async) {
      return this.ready.shift((candidate) => this.isCurrent(candidate, 'ready'));
    }

    // Keep creation order: wait for the oldest pending file even if newer ones are ready.
    const oldest = this.ordered.peek((candidate) => this.candidates.get(candidate.name) === candidate);
    if (oldest?.state !== 'ready' || oldest.confirmedByScan > this.scansCompleted) {
      return undefined;
    }
    return this.ordered.pop();
  }

  private isCurrent(candidate: Candidate, state: Candidate['state']): boolean {
    return candidate.state === state && this.candidates.get(candidate.name) === candidate;
  }

  private async dispatch(candidate: Candidate, generation: number): Promise<void> {
    const filePath = path.join(this.directory, candidate.name);

    try {
      const raw = await readFile(filePath, this.encoding === null ? {} : { encoding: this.encoding });
      const content = raw as FdContent<E>;
      const result = this.interceptor ? await this.interceptor(filePath, content) : content;
      if (generation === this.generation) {
        this.emit(FdEventType.Success, filePath, result);
      }
    } catch (error) {
      if (generation === this.generation) {
        this.fail(error, filePath);
      }
    } finally {
      if (generation === this.generation) {
        this.candidates.delete(candidate.name);
        this.active -= 1;
        this.pump();
      }
    }
  }

  private matches(name: string): boolean {
    if (!this.pattern) {
      return true;
    }

    // Global and sticky patterns keep state between test() calls.
    this.pattern.lastIndex = 0;
    return this.pattern.test(name);
  }

  private fail(error: unknown, filePath?: string): void {
    const reason = error instanceof Error ? error : new Error(String(error));
    if (filePath === undefined) {
      this.emit(FdEventType.Fail, reason);
    } else {
      this.emit(FdEventType.Fail, reason, filePath);
    }
  }

  private track(task: Promise<void>): void {
    const tracked: Promise<void> = task
      .catch((error: unknown) => this.fail(error))
      .finally(() => this.inFlight.delete(tracked));
    this.inFlight.add(tracked);
  }
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

function creationTime(stats: fs.Stats): number {
  return stats.birthtimeMs > 0 ? stats.birthtimeMs : stats.mtimeMs;
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

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive integer.`);
  }
  return value;
}

function nonNegativeNumber(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative number.`);
  }
  return value;
}
