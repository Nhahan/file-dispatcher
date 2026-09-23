import { AsyncLocalStorage } from 'node:async_hooks';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

import { createFile, type DispatchedFile } from './file';
import { onAbort, positiveInteger, resolveWatchOptions, type WatchOptions } from './options';
import { DirectoryWatcher, statIdentity, toError, type ReadyFile } from './watcher';

// Looked up on each call rather than bound once, so the file system functions stay replaceable.
const link = (existing: string, target: string) => promisify(fs.link)(existing, target);
const unlink = (file: string) => promisify(fs.unlink)(file);
const copyFile = (source: string, target: string, mode: number) => promisify(fs.copyFile)(source, target, mode);
const mkdir = (directory: string) => promisify(fs.mkdir)(directory, { recursive: true });

// A failed done/failed action is retried with backoff; afterwards the file stays where it is.
const ACTION_ATTEMPTS = 5;
const ACTION_RETRY_MS = 250;

/** What happens to a file after its handler: leave it, delete it, or move it into another directory. */
export type FileAction = 'keep' | 'delete' | { moveTo: string };

export interface HandlerContext {
  /** Aborted when the dispatcher closes, so long-running handlers can stop early. */
  readonly signal: AbortSignal;
}

export type FileHandler = (file: DispatchedFile, context: HandlerContext) => unknown;

export interface DispatchOptions extends WatchOptions {
  /**
   * Handlers running at once. With `1`, files are handled one at a time, oldest first, and each
   * handler finishes before the next file starts. Default: `1`.
   */
  concurrency?: number | undefined;
  /** Applied after the handler succeeds. Default: `'keep'`. */
  done?: FileAction | undefined;
  /** Applied after the handler throws or rejects. Default: `'keep'`. */
  failed?: FileAction | undefined;
  /**
   * Also handle files that are already in the directory at start. Default: `true` when `done` removes
   * files, since anything left over has not been handled; `false` when `done` is `'keep'`.
   */
  existing?: boolean | undefined;
}

/** The `done` or `failed` action could not be applied after several attempts. The file is left in place. */
export class ActionError extends Error {
  override readonly name = 'ActionError';
  /** Which action failed. */
  readonly action: 'done' | 'failed';
  /** The last file system error. */
  override readonly cause: Error;
  /** The handler's error when `action` is `'failed'`. */
  readonly handlerError: Error | undefined;

  constructor(action: 'done' | 'failed', cause: Error, handlerError: Error | undefined) {
    super(`Could not apply the ${action} action: ${cause.message}`, { cause });
    this.action = action;
    this.cause = cause;
    this.handlerError = handlerError;
  }
}

export interface DispatcherEvents {
  /** The handler succeeded and `done` was applied. `movedTo` is the file's new path when `done` moved it. */
  processed: [file: DispatchedFile, movedTo: string | undefined];
  /**
   * The handler failed and `failed` was applied, or an action kept failing ({@link ActionError}).
   * `movedTo` is the file's new path when `failed` moved it.
   */
  failed: [error: Error, file: DispatchedFile, movedTo: string | undefined];
  /** The directory could not be watched or listed. Dispatching resumes once it can be listed again. */
  error: [error: Error];
}

type Listener<K extends keyof DispatcherEvents> = (...args: DispatcherEvents[K]) => void;
type MetaEvent = 'newListener' | 'removeListener';
type MetaListener = (event: string | symbol, listener: (...args: any[]) => void) => void;

/**
 * Calls `handler` once for every file created in `directory`, after the file has finished being
 * written, and never loses a file when fs.watch drops events.
 *
 * Throws if `directory` cannot be read. Listen for `'error'`: like any EventEmitter, an `'error'`
 * without a listener is thrown.
 */
export function dispatch(directory: string, handler: FileHandler, options: DispatchOptions = {}): Dispatcher {
  return new Dispatcher(directory, handler, options);
}

type ResolvedAction = { type: 'keep' } | { type: 'delete' } | { type: 'move'; directory: string };

/** Where the file ended up after its action. */
type Outcome = { removed: true; movedTo: string | undefined } | { removed: false; replaced: boolean };

export interface Dispatcher {
  on<K extends keyof DispatcherEvents>(event: K, listener: Listener<K>): this;
  on(event: MetaEvent, listener: MetaListener): this;
  on(event: symbol, listener: (...args: any[]) => void): this;
  once<K extends keyof DispatcherEvents>(event: K, listener: Listener<K>): this;
  once(event: MetaEvent, listener: MetaListener): this;
  once(event: symbol, listener: (...args: any[]) => void): this;
  off<K extends keyof DispatcherEvents>(event: K, listener: Listener<K>): this;
  off(event: MetaEvent, listener: MetaListener): this;
  off(event: symbol, listener: (...args: any[]) => void): this;
  addListener<K extends keyof DispatcherEvents>(event: K, listener: Listener<K>): this;
  addListener(event: MetaEvent, listener: MetaListener): this;
  addListener(event: symbol, listener: (...args: any[]) => void): this;
  removeListener<K extends keyof DispatcherEvents>(event: K, listener: Listener<K>): this;
  removeListener(event: MetaEvent, listener: MetaListener): this;
  removeListener(event: symbol, listener: (...args: any[]) => void): this;
  prependListener<K extends keyof DispatcherEvents>(event: K, listener: Listener<K>): this;
  prependListener(event: MetaEvent, listener: MetaListener): this;
  prependListener(event: symbol, listener: (...args: any[]) => void): this;
  prependOnceListener<K extends keyof DispatcherEvents>(event: K, listener: Listener<K>): this;
  prependOnceListener(event: MetaEvent, listener: MetaListener): this;
  prependOnceListener(event: symbol, listener: (...args: any[]) => void): this;
  emit<K extends keyof DispatcherEvents>(event: K, ...args: DispatcherEvents[K]): boolean;
  emit(event: MetaEvent | symbol, ...args: any[]): boolean;
}

export class Dispatcher extends EventEmitter {
  /** Absolute path of the watched directory. */
  readonly directory: string;

  private readonly watcher: DirectoryWatcher;
  private readonly handler: FileHandler;
  private readonly concurrency: number;
  private readonly done: ResolvedAction;
  private readonly failed: ResolvedAction;
  private readonly abort = new AbortController();
  // Identifies the task a handler runs in, so close() called from a handler does not wait for itself.
  private readonly currentTask = new AsyncLocalStorage<symbol>();
  private readonly tasks = new Map<symbol, Promise<void>>();
  // Tasks whose handler is waiting in close(); they do not wait for each other.
  private readonly closingTasks = new Set<symbol>();
  private stopListening: () => void = () => {};
  private closed = false;

  constructor(directory: string, handler: FileHandler, options: DispatchOptions) {
    super();
    if (typeof handler !== 'function') {
      throw new TypeError('handler must be a function.');
    }

    const resolved = resolveWatchOptions(directory, options);
    this.directory = resolved.directory;
    this.handler = handler;
    this.concurrency = positiveInteger(options.concurrency ?? 1, 'concurrency');
    const done = parseAction(options.done, 'done');
    const failed = parseAction(options.failed, 'failed');

    this.watcher = new DirectoryWatcher({
      ...resolved,
      existing: options.existing ?? done.type !== 'keep',
      ordered: this.concurrency === 1,
      onAvailable: () => this.pump(),
      onError: (error) => this.reportError(error),
    });
    this.watcher.start();

    try {
      this.done = prepareAction(done, 'done', resolved.directory);
      this.failed = prepareAction(failed, 'failed', resolved.directory);
    } catch (error) {
      this.watcher.stop();
      throw error;
    }

    this.stopListening = onAbort(resolved.signal, () => void this.close());
  }

  /**
   * Stops watching and resolves once running handlers and their actions finish. Pending files are
   * left in place. Handlers see their `signal` abort. Called from a handler, it does not wait for
   * that handler.
   */
  close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      this.watcher.stop();
      this.stopListening();
      this.abort.abort();
    }
    const caller = this.currentTask.getStore();
    if (caller) {
      this.closingTasks.add(caller);
    }
    const others = [...this.tasks].filter(([id]) => !this.closingTasks.has(id)).map(([, task]) => task);
    return Promise.all(others).then(() => undefined);
  }

  private pump(): void {
    while (!this.closed && this.tasks.size < this.concurrency) {
      const ready = this.watcher.take();
      if (!ready) {
        return;
      }

      const id = Symbol(ready.name);
      const task = this.currentTask
        .run(id, () => this.process(ready))
        .then((outcome) => {
          this.tasks.delete(id);
          if (outcome.removed) {
            this.watcher.release(ready, true);
          } else {
            this.watcher.release(ready, false, outcome.replaced);
          }
          this.pump();
        });
      this.tasks.set(id, task);
    }
  }

  /** Handles one file. Never rejects. */
  private async process(ready: ReadyFile): Promise<Outcome> {
    const file = createFile(ready);

    let handlerError: Error | undefined;
    try {
      await this.handler(file, { signal: this.abort.signal });
    } catch (error) {
      handlerError = toError(error);
    }

    const actionName = handlerError ? 'failed' : 'done';
    const action = handlerError ? this.failed : this.done;
    let result: ActionResult | undefined;
    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= ACTION_ATTEMPTS; attempt += 1) {
      try {
        result = await applyAction(action, ready);
        break;
      } catch (error) {
        lastError = toError(error);
        if (attempt === ACTION_ATTEMPTS || this.closed || !(await sleep(ACTION_RETRY_MS * 2 ** (attempt - 1), this.abort.signal))) {
          break;
        }
      }
    }

    if (!result) {
      this.emitSafely('failed', new ActionError(actionName, lastError ?? new Error('closed'), handlerError), file, undefined);
      // Left in place; handled again on the next start when `existing` is on.
      return { removed: false, replaced: false };
    }

    const movedTo = result.type === 'moved' ? result.to : undefined;
    if (handlerError) {
      this.emitSafely('failed', handlerError, file, movedTo);
    } else {
      this.emitSafely('processed', file, movedTo);
    }

    if (result.type === 'replaced') {
      // Another file took the name while the handler ran; it is new and was left alone.
      return { removed: false, replaced: true };
    }
    return result.type === 'kept' ? { removed: false, replaced: false } : { removed: true, movedTo };
  }

  private reportError(error: Error): void {
    if (this.listenerCount('error') > 0) {
      this.emit('error', error);
    } else {
      // Same as EventEmitter without an 'error' listener, but thrown outside the watcher's promises.
      process.nextTick(() => {
        throw error;
      });
    }
  }

  // A throwing listener must not stall the queue; surface it as an uncaught exception instead.
  private emitSafely<K extends 'processed' | 'failed'>(event: K, ...args: DispatcherEvents[K]): void {
    try {
      this.emit(event, ...args);
    } catch (error) {
      process.nextTick(() => {
        throw error;
      });
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<boolean> {
  return delay(ms, true, { signal }).catch(() => false);
}

function parseAction(action: FileAction | undefined, name: string): ResolvedAction {
  if (action === undefined || action === 'keep') {
    return { type: 'keep' };
  }
  if (action === 'delete') {
    return { type: 'delete' };
  }
  if (typeof action === 'object' && action !== null && typeof action.moveTo === 'string' && action.moveTo.length > 0) {
    return { type: 'move', directory: path.resolve(action.moveTo) };
  }
  throw new TypeError(`${name} must be 'keep', 'delete', or { moveTo: string }.`);
}

function prepareAction(action: ResolvedAction, name: string, watched: string): ResolvedAction {
  if (action.type !== 'move') {
    return action;
  }

  fs.mkdirSync(action.directory, { recursive: true });
  // Compare identities, not strings: another letter case or a symlink can name the watched directory,
  // and moving files into it would hand them out again forever.
  const target = fs.statSync(action.directory, { bigint: true });
  const source = fs.statSync(watched, { bigint: true });
  if (target.dev === source.dev && target.ino === source.ino) {
    throw new TypeError(`${name}.moveTo must differ from the watched directory.`);
  }
  return action;
}

type ActionResult = { type: 'kept' } | { type: 'removed' } | { type: 'moved'; to: string } | { type: 'replaced' };

/** Applies an action to the handled file, leaving alone a different file that took its name. */
async function applyAction(action: ResolvedAction, file: ReadyFile): Promise<ActionResult> {
  if (action.type === 'keep') {
    return { type: 'kept' };
  }

  const identity = await statIdentity(file.path);
  if (identity === undefined) {
    // The handler removed or moved the file itself.
    return { type: 'removed' };
  }
  if (identity !== file.identity) {
    return { type: 'replaced' };
  }

  if (action.type === 'delete') {
    await unlink(file.path).catch(ignoreMissing);
    return { type: 'removed' };
  }

  await mkdir(action.directory);
  return moveWithoutOverwriting(file, action.directory);
}

// Next suffix to try per target name, so repeated names do not rescan -1, -2, ... from the start.
const nextSuffix = new Map<string, number>();

/**
 * Moves the file into `directory` under its name, or name-1, name-2, ... when taken. A hard link fails
 * atomically when the name is taken, so concurrent movers never overwrite each other.
 */
async function moveWithoutOverwriting(file: ReadyFile, directory: string): Promise<ActionResult> {
  const extension = path.extname(file.name);
  const stem = file.name.slice(0, file.name.length - extension.length);
  const key = path.join(directory, file.name);
  for (let index = 0; ; index += 1) {
    if (index === 1) {
      index = Math.max(1, nextSuffix.get(key) ?? 1);
    }
    const target = path.join(directory, index === 0 ? file.name : `${stem}-${index}${extension}`);

    try {
      await link(file.path, target);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') {
        continue;
      }
      if (code === 'EXDEV' || code === 'EPERM' || code === 'ENOTSUP' || code === 'ENOSYS' || code === 'EOPNOTSUPP') {
        // No hard link across file systems or on this one: copy without overwriting instead.
        const copied = await copyWithoutOverwriting(file, target);
        if (copied === 'taken') {
          continue;
        }
        return copied;
      }
      throw error;
    }

    if (index > 0) {
      if (nextSuffix.size > 10_000) {
        nextSuffix.clear();
      }
      nextSuffix.set(key, index + 1);
    }
    // The link names whatever file held the name at that moment; keep it only if it is the handled one.
    if ((await statIdentity(target)) !== file.identity) {
      await unlink(target).catch(ignoreMissing);
      return { type: 'replaced' };
    }
    await unlink(file.path).catch(ignoreMissing);
    return { type: 'moved', to: target };
  }
}

async function copyWithoutOverwriting(file: ReadyFile, target: string): Promise<ActionResult | 'taken'> {
  try {
    await copyFile(file.path, target, fs.constants.COPYFILE_EXCL);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return 'taken';
    }
    // Do not leave a partial copy behind.
    await unlink(target).catch(() => undefined);
    throw error;
  }

  const identity = await statIdentity(file.path);
  if (identity !== undefined && identity !== file.identity) {
    await unlink(target).catch(ignoreMissing);
    return { type: 'replaced' };
  }
  try {
    await unlink(file.path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      // Keep exactly one copy: the retry moves the source again.
      await unlink(target).catch(() => undefined);
      throw error;
    }
  }
  return { type: 'moved', to: target };
}

function ignoreMissing(error: NodeJS.ErrnoException): void {
  if (error.code !== 'ENOENT') {
    throw error;
  }
}
