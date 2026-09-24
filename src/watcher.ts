import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';

export interface ReadyFile {
  readonly name: string;
  readonly path: string;
  readonly size: number;
  readonly createdMs: number;
  /** Device, inode, and birth time when the file was handed out. */
  readonly identity: string;
  /** Inode and birth time (or modification time without one): the same for the same file across restarts. */
  readonly id: string;
}

/** Names with this prefix are the library's own temporary names and are never handed out. */
export const RESERVED_PREFIX = '.file-dispatcher-';

/** Internal timing that tests shorten or turn off. */
export const timing = {
  /** Minimum milliseconds between full rescans that run even without watch events; `0` disables them. */
  rescanInterval: 1000,
};

export interface WatcherOptions {
  directory: string;
  filter: (name: string) => boolean;
  /** Treat files present at start as new. */
  existing: boolean;
  /** Hand out ready files oldest first, after a scan confirms no older file was missed. */
  ordered: boolean;
  stabilityThreshold: number;
  /** Called when take() may return a file. */
  onAvailable: () => void;
  /** Called when the directory cannot be watched or listed. */
  onError: (error: Error) => void;
}

interface KnownEntry {
  // Scans started when the name was added; a scan only forgets names added before it started.
  addedAtScan: number;
  // Identity of the regular file last seen under this name, used to tell a replacement from a
  // modification. Undefined until one is seen.
  identity: string | undefined;
  // Its modification time: a file created again within one timestamp tick can reuse the inode and
  // birth time, but not the modification time of a file that had already settled.
  mtimeNs: bigint | undefined;
  // Present when watching started; such a name is not new when its identity is first recorded.
  baseline: boolean;
}

interface Candidate {
  name: string;
  path: string;
  seq: number;
  identity: string;
  id: string;
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

// Rescans recover dropped events, so they wait for a burst to pass.
const SCAN_DEBOUNCE_MS = 100;
// Rescans may use at most about 1/SCAN_BUDGET of the time, so huge directories rescan less often.
const SCAN_BUDGET = 20;
// The cost of a scan is the fastest of the last few. A scan stalled by a busy process says nothing about
// the directory, and would otherwise delay the next scan, and the files it confirms, by SCAN_BUDGET times.
const SCAN_COST_SAMPLES = 4;
const MIN_RETRY_MS = 500;
const MAX_RETRY_MS = 30_000;
// In ordered mode an older file still being written holds back newer ready files, but only for
// max(HOLD_MIN_MS, HOLD_THRESHOLDS × stabilityThreshold): a file appended forever must not stall the queue.
const HOLD_MIN_MS = 1000;
const HOLD_THRESHOLDS = 20;
// Handled (and pre-existing) files remembered by identity, modification time, and size, so that
// another name for the same unchanged file, from a rename or a hard link, is not handed out again.
const SEEN_LIMIT = 100_000;
// Handled files checked per rescan for replacements whose watch events were all dropped.
const VERIFY_BATCH = 256;
// Bounds concurrent fs.stat calls.
const STAT_CONCURRENCY = 32;
// Only these file systems report one entry under another spelling (8.3 names, letter case).
const CASE_INSENSITIVE = process.platform === 'darwin' || process.platform === 'win32';
// A 'rename' event means an entry was created or removed, except on macOS, which reports the flags of
// recent changes together: a file created a moment ago and then modified is reported as renamed too.
const EXACT_RENAME_EVENTS = process.platform !== 'darwin';
// The callback API is several times faster than fs.promises for many small files.
const statBigInt = promisify((file: string, callback: (error: NodeJS.ErrnoException | null, stats: fs.BigIntStats) => void) =>
  fs.stat(file, { bigint: true }, callback),
);
const lstat = promisify(fs.lstat);
const realpathNative = promisify(fs.realpath.native);

/**
 * Finds every regular file created in a directory, once, after it has finished being written.
 *
 * fs.watch drops events when the kernel buffer overflows (Windows under almost any burst, Linux when
 * the event loop is busy) and reports a file before its content is written. Here a watch event only
 * points at a name to check; new names are also found by diffing directory listings, so a dropped
 * event cannot lose a file, and a file is handed out only after its size and mtime settle. A known
 * name is new again when the file behind it is replaced.
 *
 * Consumers pull files with take() and hand them back with release(), which gives natural
 * backpressure: nothing is read or buffered beyond file metadata.
 */
export class DirectoryWatcher {
  private readonly options: WatcherOptions;
  private readonly holdMs: number;
  private watcher: fs.FSWatcher | undefined;
  private watchedIdentity: string | undefined;
  private watchedName: string | undefined;
  private periodicTimer: NodeJS.Timeout | undefined;
  private scanTimer: NodeJS.Timeout | undefined;
  private settleTimer: NodeJS.Timeout | undefined;
  private holdTimer: NodeJS.Timeout | undefined;
  private eventFlush: NodeJS.Immediate | undefined;
  private stopped = false;
  private scanning = false;
  private scanRequested = false;
  private lastScanError: string | undefined;
  private scanFailures = 0;
  private scanTimes: number[] = [];
  private nextSeq = 0;
  private scansStarted = 0;
  private scansCompleted = 0;
  private newNames = new Set<string>();
  // Known names with events to check, and whether an event was a 'rename' (an entry created or removed).
  private changedNames = new Map<string, boolean>();
  private verifyQueue: string[] = [];
  private readonly known = new Map<string, KnownEntry>();
  private readonly seen = new Map<string, string>();
  private readonly candidates = new Map<string, Candidate>();
  // Every candidate waits the same threshold, so due times grow in insertion order and a FIFO suffices.
  private readonly settling = new Queue<Candidate>();
  private readonly ready = new Queue<Candidate>();
  // Ordered mode: ready files, and files not yet ready that may hold them back, both oldest first.
  private readonly ordered = new Heap<Candidate>(byCreation);
  private readonly pending = new Heap<Candidate>(byCreation);

  constructor(options: WatcherOptions) {
    this.options = options;
    this.holdMs = Math.max(HOLD_MIN_MS, HOLD_THRESHOLDS * options.stabilityThreshold);
  }

  /** Starts watching. Throws if the directory cannot be read. */
  start(): void {
    // Watch first so files created while the baseline is read still produce events.
    this.watch(true);

    let entries: fs.Dirent[];
    const startedAt = performance.now();
    try {
      entries = fs.readdirSync(this.options.directory, { withFileTypes: true });
    } catch (error) {
      this.closeWatcher();
      throw error;
    }
    // A synchronous listing is not slowed by anything else the process does.
    this.scanTimes.push(performance.now() - startedAt);

    for (const entry of entries) {
      if (entry.name.startsWith(RESERVED_PREFIX)) {
        continue;
      }
      // Only files count as already there: a file later created under a directory's name is new.
      this.known.set(entry.name, { addedAtScan: 0, identity: undefined, mtimeNs: undefined, baseline: !entry.isDirectory() });
    }
    const matching = entries.map((entry) => entry.name).filter((name) => this.options.filter(name));
    if (this.options.existing) {
      // The baseline is a full listing, which counts as scan 0 for ordering.
      this.track(this.addCandidates(matching, 0, false));
    } else {
      // Record identities so a file later replaced under one of these names is recognized as new.
      this.track(this.checkChanged(matching.map((name) => [name, false])));
    }
    this.schedulePeriodic();
  }

  /** Stops watching. Files not yet taken are discarded. */
  stop(): void {
    this.stopped = true;
    this.closeWatcher();
    clearTimeout(this.periodicTimer);
    clearTimeout(this.scanTimer);
    clearTimeout(this.settleTimer);
    clearTimeout(this.holdTimer);
    clearImmediate(this.eventFlush);
    this.known.clear();
    this.candidates.clear();
    this.settling.clear();
    this.ready.clear();
    this.ordered.clear();
    this.pending.clear();
    this.seen.clear();
    this.verifyQueue = [];
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
      const holding = this.pending.peek((candidate) => this.isPending(candidate, now));
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
    return {
      name: next.name,
      path: next.path,
      size: Number(next.size),
      createdMs: next.createdMs,
      identity: next.identity,
      id: next.id,
    };
  }

  /**
   * Marks a taken file as finished. `removed` means the consumer deleted or moved it, so a file
   * created again under the same name is found without waiting for a rescan. `recheck` means the
   * consumer saw another file under the name, which is then treated as new.
   */
  release(file: ReadyFile, removed: boolean, recheck = false): void {
    const candidate = this.candidates.get(file.name);
    if (candidate?.state !== 'taken') {
      return;
    }

    this.candidates.delete(file.name);
    this.markSeen(candidate.identity, candidate.mtimeNs, candidate.size);
    if (removed) {
      this.known.delete(file.name);
      if (candidate.recheck) {
        this.queueName(file.name, true);
      }
    } else if (recheck) {
      const entry = this.known.get(file.name);
      if (entry) {
        entry.identity = candidate.identity;
        entry.mtimeNs = candidate.mtimeNs;
      }
      this.queueName(file.name, true);
    } else if (candidate.recheck) {
      this.queueName(file.name, true);
    }
  }

  private markSeen(identity: string, mtimeNs: bigint, size: bigint): void {
    this.seen.delete(identity);
    this.seen.set(identity, `${mtimeNs}:${size}`);
    if (this.seen.size > SEEN_LIMIT) {
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) {
        this.seen.delete(oldest);
      }
    }
  }

  // The same file under another name keeps its modification time and size; a new file that happens
  // to reuse an inode and birth time does not.
  private wasSeen(identity: string, stats: fs.BigIntStats): boolean {
    return this.seen.get(identity) === `${stats.mtimeNs}:${stats.size}`;
  }

  private isPending(candidate: Candidate, now: number): boolean {
    return (
      (this.isCurrent(candidate, 'settling') || this.isCurrent(candidate, 'checking')) &&
      now - candidate.discoveredAt < this.holdMs
    );
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
      const real = fs.realpathSync.native(this.options.directory);
      this.watchedIdentity = identityOf(fs.statSync(real, { bigint: true }));
      this.watchedName = path.basename(real);
      watcher = fs.watch(real, { persistent: true }, (event, name) =>
        name ? this.queueName(name.toString(), event === 'rename' && EXACT_RENAME_EVENTS) : this.requestScan(),
      );
    } catch (error) {
      if (initial) {
        throw error;
      }
      return;
    }

    watcher.on('error', (error) => {
      // The watcher is unusable after an error; rescans keep running and re-watch once the directory lists again.
      if (this.watcher === watcher) {
        this.closeWatcher();
      }
      if (!this.stopped) {
        this.options.onError(error);
        this.requestScan();
      }
    });
    this.watcher = watcher;
  }

  private closeWatcher(): void {
    this.watcher?.close();
    this.watcher = undefined;
    this.watchedIdentity = undefined;
    this.watchedName = undefined;
  }

  // Watch events name a file to check; rescans find anything the events missed.
  private queueName(name: string, renamed: boolean): void {
    if (this.stopped) {
      return;
    }
    if (renamed && name === this.watchedName) {
      // An event under the directory's own name usually means it was deleted or moved, which leaves
      // the watch handle silent: watch again after a rescan, which finds anything missed meanwhile.
      this.closeWatcher();
      this.requestScan();
    }
    if (name.startsWith(RESERVED_PREFIX) || !this.options.filter(name)) {
      return;
    }

    const entry = this.known.get(name);
    if (!entry) {
      this.known.set(name, { addedAtScan: this.scansStarted, identity: undefined, mtimeNs: undefined, baseline: false });
      this.newNames.add(name);
      // Events for names it did not know may be the few that got through; rescan (on a budget) in
      // case others were dropped. This also notices a watched directory that was deleted.
      this.requestScan();
    } else {
      const candidate = this.candidates.get(name);
      if (candidate?.state === 'taken') {
        candidate.recheck = true;
        return;
      }
      if (candidate) {
        // Settling already checks it again.
        return;
      }
      this.changedNames.set(name, renamed || this.changedNames.get(name) === true);
    }

    this.eventFlush ??= setImmediate(() => {
      this.eventFlush = undefined;
      const added = [...this.newNames];
      const changed = [...this.changedNames];
      this.newNames.clear();
      this.changedNames.clear();
      this.track(this.addCandidates(added, this.scansStarted + 1, true));
      this.track(this.checkChanged(changed));
    });
  }

  // A known name changed: forget it if removed, and treat it as new if a different file is behind it.
  private async checkChanged(changed: [name: string, renamed: boolean][]): Promise<void> {
    if (changed.length === 0) {
      return;
    }

    const observed = await this.statAll(changed.map(([name]) => name));
    if (this.stopped) {
      return;
    }

    const replaced: string[] = [];
    observed.forEach(({ name, stats }, index) => {
      const entry = this.known.get(name);
      if (!entry || this.candidates.has(name)) {
        return;
      }
      if (!stats) {
        this.known.delete(name);
        return;
      }
      if (!stats.isFile()) {
        entry.baseline = false;
        return;
      }

      const identity = identityOf(stats);
      const renamed = changed[index]?.[1] === true;
      const isNew =
        entry.identity === undefined
          ? !entry.baseline
          : entry.identity !== identity ||
            // A file created again within one timestamp tick can reuse the inode and birth time; a
            // 'rename' event on the name with a new modification time means the entry was replaced.
            (renamed && entry.mtimeNs !== undefined && stats.mtimeNs !== entry.mtimeNs);
      if (isNew) {
        entry.addedAtScan = this.scansStarted;
        replaced.push(name);
      } else {
        entry.identity = identity;
        entry.mtimeNs = stats.mtimeNs;
        if (entry.baseline) {
          // A file that was already there counts as seen when another name for it appears later.
          this.markSeen(identity, stats.mtimeNs, stats.size);
        }
      }
    });

    if (replaced.length > 0) {
      await this.addCandidates(replaced, this.scansStarted + 1, false);
      this.requestScan();
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

    this.scanTimer ??= setTimeout(
      () => {
        this.scanTimer = undefined;
        this.track(this.scan());
      },
      Math.max(SCAN_DEBOUNCE_MS, this.scanCost() * SCAN_BUDGET),
    );
  }

  private scanCost(): number {
    return Math.min(...this.scanTimes);
  }

  private schedulePeriodic(): void {
    if (this.stopped || timing.rescanInterval === 0) {
      return;
    }

    clearTimeout(this.periodicTimer);
    const delay = Math.max(timing.rescanInterval, this.scanCost() * SCAN_BUDGET);
    this.periodicTimer = setTimeout(() => this.requestScan(), delay);
  }

  private async scan(): Promise<void> {
    const scanId = ++this.scansStarted;
    const startedAt = performance.now();
    this.scanning = true;
    this.scanRequested = false;

    try {
      const [entries, directory] = await Promise.all([
        fsp.readdir(this.options.directory, { withFileTypes: true }),
        statBigInt(this.options.directory),
      ]);
      if (this.stopped) {
        return;
      }

      // A directory deleted and created again leaves the old watcher silent on some platforms.
      if (this.watcher && this.watchedIdentity !== identityOf(directory)) {
        this.closeWatcher();
      }

      const present = new Set<string>();
      const added: string[] = [];
      for (const entry of entries) {
        if (entry.name.startsWith(RESERVED_PREFIX)) {
          continue;
        }
        present.add(entry.name);
        if (!this.known.has(entry.name)) {
          this.known.set(entry.name, { addedAtScan: scanId, identity: undefined, mtimeNs: undefined, baseline: false });
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
      this.scanTimes.push(performance.now() - startedAt);
      if (this.scanTimes.length > SCAN_COST_SAMPLES) {
        this.scanTimes.shift();
      }

      await this.addCandidates(added, scanId, false);
      if (this.stopped) {
        return;
      }

      this.scansCompleted = scanId;
      this.scanFailures = 0;
      this.lastScanError = undefined;
      if (!this.watcher) {
        this.watch(false);
      }
      this.options.onAvailable();
      this.schedulePeriodic();
      this.track(this.verifySome());
    } catch (error) {
      if (this.stopped) {
        return;
      }

      // The watch handle may belong to a directory that no longer exists; watch again once it lists.
      this.closeWatcher();
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

  private async addCandidates(names: string[], confirmedByScan: number, fromEvents: boolean): Promise<void> {
    if (names.length === 0) {
      return;
    }

    let observed = await this.statAll(names);
    if (this.stopped) {
      return;
    }
    if (fromEvents && CASE_INSENSITIVE) {
      observed = await this.dropOtherSpellings(observed);
      if (this.stopped) {
        return;
      }
    }

    const now = performance.now();
    const due = now + this.options.stabilityThreshold;
    for (const { name, stats } of observed) {
      const entry = this.known.get(name);
      if (!entry || this.candidates.has(name)) {
        continue;
      }
      if (!stats) {
        // The event was for a removal (often of a file just handled). Forget the name so a file
        // created under it later is found.
        this.known.delete(name);
        continue;
      }
      if (!stats.isFile()) {
        entry.baseline = false;
        continue;
      }

      const identity = identityOf(stats);
      entry.identity = identity;
      entry.mtimeNs = stats.mtimeNs;
      if (this.wasSeen(identity, stats)) {
        // A rename or hard link of a file that was already handled (or already there): not new.
        continue;
      }
      const candidate: Candidate = {
        name,
        path: path.join(this.options.directory, name),
        seq: this.nextSeq++,
        identity,
        id: fileId(stats),
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

  // Case-insensitive file systems can report an existing entry under another spelling (an 8.3 short
  // name or other letter case). The real path names the entry the directory actually holds.
  private async dropOtherSpellings(
    observed: { name: string; stats: fs.BigIntStats | undefined }[],
  ): Promise<{ name: string; stats: fs.BigIntStats | undefined }[]> {
    const directory = await realpathNative(this.options.directory).catch(() => undefined);
    if (directory === undefined) {
      return observed;
    }

    const kept: { name: string; stats: fs.BigIntStats | undefined }[] = [];
    await mapLimit(observed, STAT_CONCURRENCY, async (entry) => {
      if (!entry.stats) {
        kept.push(entry);
        return;
      }
      const file = path.join(this.options.directory, entry.name);
      const link = await lstat(file).catch(() => undefined);
      const real = link?.isSymbolicLink() ? undefined : await realpathNative(file).catch(() => undefined);
      if (real === undefined || path.dirname(real) !== directory || path.basename(real) === entry.name) {
        kept.push(entry);
        return;
      }

      // Another spelling: forget it and check the real entry instead.
      this.known.delete(entry.name);
      this.queueName(path.basename(real), false);
    });
    return kept;
  }

  // Watch events can all be dropped, so each rescan also checks a batch of known files for replacements.
  private async verifySome(): Promise<void> {
    if (this.verifyQueue.length === 0) {
      this.verifyQueue = [...this.known.keys()].filter((name) => this.options.filter(name));
    }
    const batch = this.verifyQueue
      .splice(-VERIFY_BATCH)
      .filter((name) => this.known.has(name) && !this.candidates.has(name));
    await this.checkChanged(batch.map((name) => [name, false]));
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
        candidate.id = fileId(stats);
        candidate.size = stats.size;
        candidate.mtimeNs = stats.mtimeNs;
        candidate.due = performance.now() + this.options.stabilityThreshold;
        candidate.state = 'settling';
        this.settling.push(candidate);
        return;
      }

      candidate.identity = identity;
      candidate.id = fileId(stats);
      candidate.size = stats.size;
      candidate.state = 'ready';
      const entry = this.known.get(candidate.name);
      if (entry) {
        entry.identity = identity;
        entry.mtimeNs = stats.mtimeNs;
      }
      (this.options.ordered ? this.ordered : this.ready).push(candidate);
      changed = true;
    });

    // Removed and settled candidates stay in the pending heap until they reach its top; rebuild it
    // when they would otherwise pile up.
    if (this.pending.size > 1024 && this.pending.size > 2 * this.candidates.size) {
      this.pending.rebuild((candidate) => this.isCurrent(candidate, 'settling') || this.isCurrent(candidate, 'checking'));
    }
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

/** A key for a file that stays the same across restarts, for handlers that must be idempotent. */
function fileId(stats: fs.BigIntStats): string {
  return `${stats.ino}-${stats.birthtimeNs > 0n ? stats.birthtimeNs : `m${stats.mtimeNs}`}`;
}

/** Identifies a file by device, inode, and birth time. */
export function identityOf(stats: fs.BigIntStats): string {
  return `${stats.dev}:${stats.ino}:${stats.birthtimeNs}`;
}

/** Stats a path with bigint precision, or resolves undefined when it does not exist. */
export function statIdentity(file: string): Promise<string | undefined> {
  return statBigInt(file).then(
    (stats) => (stats.isFile() ? identityOf(stats) : undefined),
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        return undefined;
      }
      throw error;
    },
  );
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

  get size(): number {
    return this.items.length;
  }

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
      this.siftDown(0);
    }
    return top;
  }

  /** Keeps only the entries that pass `keep`. */
  rebuild(keep: (item: T) => boolean): void {
    this.items = this.items.filter(keep);
    for (let index = (this.items.length >> 1) - 1; index >= 0; index -= 1) {
      this.siftDown(index);
    }
  }

  clear(): void {
    this.items = [];
  }

  private siftDown(start: number): void {
    const items = this.items;
    let index = start;
    for (;;) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;
      if (left < items.length && this.compare(items[left] as T, items[smallest] as T) < 0) smallest = left;
      if (right < items.length && this.compare(items[right] as T, items[smallest] as T) < 0) smallest = right;
      if (smallest === index) return;
      [items[index], items[smallest]] = [items[smallest] as T, items[index] as T];
      index = smallest;
    }
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
