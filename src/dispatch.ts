import { AsyncLocalStorage } from 'node:async_hooks';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

import { createFile, type DispatchedFile } from './file';
import { onAbort, positiveInteger, resolveWatchOptions, type WatchOptions } from './options';
import { DirectoryWatcher, toError, type ReadyFile } from './watcher';

const rename = promisify(fs.rename);
const unlink = promisify(fs.unlink);
const copyFile = promisify(fs.copyFile);
const mkdir = promisify(fs.mkdir);

// A failed done/failed action is retried with backoff until it succeeds or the dispatcher closes.
const ACTION_RETRY_MIN_MS = 1000;
const ACTION_RETRY_MAX_MS = 30_000;

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

/** The `done` or `failed` action could not be applied. It is retried until it succeeds or the dispatcher closes. */
export class ActionError extends Error {
  override readonly name = 'ActionError';
  /** Which action failed. */
  readonly action: 'done' | 'failed';
  /** The handler's error when `action` is `'failed'`. */
  readonly handlerError: Error | undefined;

  constructor(action: 'done' | 'failed', cause: Error, handlerError: Error | undefined) {
    super(`Could not apply the ${action} action: ${cause.message}`, { cause });
    this.action = action;
    this.handlerError = handlerError;
  }
}

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

export interface Dispatcher {
  /** The handler succeeded and `done` was applied. `movedTo` is the file's new path when `done` moved it. */
  on(event: 'processed', listener: (file: DispatchedFile, movedTo: string | undefined) => void): this;
  /**
   * The handler failed and `failed` was applied, or an action failed with an {@link ActionError}.
   * `movedTo` is the file's new path when `failed` moved it.
   */
  on(event: 'failed', listener: (error: Error, file: DispatchedFile, movedTo: string | undefined) => void): this;
  /** The directory could not be watched or listed. Dispatching resumes once it can be listed again. */
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: string | symbol, listener: (...args: any[]) => void): this;
  once(event: 'processed', listener: (file: DispatchedFile, movedTo: string | undefined) => void): this;
  once(event: 'failed', listener: (error: Error, file: DispatchedFile, movedTo: string | undefined) => void): this;
  once(event: 'error', listener: (error: Error) => void): this;
  once(event: string | symbol, listener: (...args: any[]) => void): this;
  off(event: 'processed', listener: (file: DispatchedFile, movedTo: string | undefined) => void): this;
  off(event: 'failed', listener: (error: Error, file: DispatchedFile, movedTo: string | undefined) => void): this;
  off(event: 'error', listener: (error: Error) => void): this;
  off(event: string | symbol, listener: (...args: any[]) => void): this;
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
  private stopListening: () => void = () => {};
  private closing: Promise<void> | undefined;

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
    if (!this.closing) {
      this.watcher.stop();
      this.stopListening();
      this.abort.abort();
      const caller = this.currentTask.getStore();
      const others = [...this.tasks].filter(([id]) => id !== caller).map(([, task]) => task);
      this.closing = Promise.all(others).then(() => undefined);
    }
    return this.closing;
  }

  private pump(): void {
    while (!this.closing && this.tasks.size < this.concurrency) {
      const ready = this.watcher.take();
      if (!ready) {
        return;
      }

      const id = Symbol(ready.name);
      const task = this.currentTask
        .run(id, () => this.process(ready))
        .then((removed) => {
          this.tasks.delete(id);
          this.watcher.release(ready, removed);
          this.pump();
        });
      this.tasks.set(id, task);
    }
  }

  /** Handles one file and resolves whether it left the directory. Never rejects. */
  private async process(ready: ReadyFile): Promise<boolean> {
    const file = createFile(ready);

    let handlerError: Error | undefined;
    try {
      await this.handler(file, { signal: this.abort.signal });
    } catch (error) {
      handlerError = toError(error);
    }

    const actionName = handlerError ? 'failed' : 'done';
    const action = handlerError ? this.failed : this.done;
    for (let attempt = 0; ; attempt += 1) {
      let movedTo: string | undefined;
      try {
        movedTo = await applyAction(action, file);
      } catch (error) {
        this.emitSafely('failed', new ActionError(actionName, toError(error), handlerError), file, undefined);
        const wait = Math.min(ACTION_RETRY_MAX_MS, ACTION_RETRY_MIN_MS * 2 ** attempt);
        if (this.closing || !(await sleep(wait, this.abort.signal))) {
          // Left in place; the file is handled again on the next start when `existing` is on.
          return false;
        }
        continue;
      }

      if (handlerError) {
        this.emitSafely('failed', handlerError, file, movedTo);
      } else {
        this.emitSafely('processed', file, movedTo);
      }
      return action.type !== 'keep';
    }
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
  private emitSafely(event: 'processed' | 'failed', ...args: unknown[]): void {
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

/** Applies an action and resolves the file's new path when it was moved. */
async function applyAction(action: ResolvedAction, file: DispatchedFile): Promise<string | undefined> {
  if (action.type === 'keep') {
    return undefined;
  }

  try {
    if (action.type === 'delete') {
      await unlink(file.path);
      return undefined;
    }

    await mkdir(action.directory, { recursive: true });
    return await moveWithoutOverwriting(file.path, action.directory, file.name);
  } catch (error) {
    // The handler already removed or moved the file itself.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !fs.existsSync(file.path)) {
      return undefined;
    }
    throw error;
  }
}

// rename replaces an existing file, so pick a free name: report.json, report-1.json, report-2.json, ...
async function moveWithoutOverwriting(source: string, directory: string, name: string): Promise<string> {
  const extension = path.extname(name);
  const stem = name.slice(0, name.length - extension.length);
  for (let index = 0; ; index += 1) {
    const target = path.join(directory, index === 0 ? name : `${stem}-${index}${extension}`);
    if (fs.existsSync(target)) {
      continue;
    }

    try {
      await rename(source, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') {
        throw error;
      }
      // rename cannot cross file systems; COPYFILE_EXCL never overwrites.
      try {
        await copyFile(source, target, fs.constants.COPYFILE_EXCL);
      } catch (copyError) {
        if ((copyError as NodeJS.ErrnoException).code === 'EEXIST') {
          continue;
        }
        // Do not leave a partial copy behind.
        await unlink(target).catch(() => undefined);
        throw copyError;
      }
      try {
        await unlink(source);
      } catch (unlinkError) {
        // Keep exactly one copy: the retry moves the source again.
        await unlink(target).catch(() => undefined);
        throw unlinkError;
      }
    }
    return target;
  }
}
