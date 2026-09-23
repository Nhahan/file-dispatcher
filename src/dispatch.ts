import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { DispatchedFile } from './file';
import { positiveInteger, resolveWatchOptions, type WatchOptions } from './options';
import { DirectoryWatcher, toError, type ReadyFile } from './watcher';

const rename = promisify(fs.rename);
const unlink = promisify(fs.unlink);
const copyFile = promisify(fs.copyFile);

/** What happens to a file after its handler: leave it, delete it, or move it into another directory. */
export type FileAction = 'keep' | 'delete' | { moveTo: string };

export type FileHandler = (file: DispatchedFile) => unknown;

export interface DispatchOptions extends WatchOptions {
  /**
   * Handlers running at once. With `1`, files are handled one at a time in creation order, and each
   * handler finishes before the next file starts. Default: `1`.
   */
  concurrency?: number;
  /** Applied after the handler succeeds. Default: `'keep'`. */
  done?: FileAction;
  /** Applied after the handler throws or rejects. Default: `'keep'`. */
  failed?: FileAction;
  /**
   * Also handle files that are already in the directory at start. Default: `true` when `done` removes
   * files, since anything left over has not been handled; `false` when `done` is `'keep'`.
   */
  existing?: boolean;
}

export interface DispatcherEvents {
  /** The handler succeeded and the `done` action was applied. */
  processed: [file: DispatchedFile];
  /** The handler failed, or the `done` or `failed` action could not be applied. */
  failed: [error: Error, file: DispatchedFile];
  /** The directory could not be watched or listed. */
  error: [error: Error];
}

type ResolvedAction = { type: 'keep' } | { type: 'delete' } | { type: 'move'; directory: string };

/**
 * Calls `handler` once for every file created in `directory`, after the file has finished being
 * written, and never loses a file when fs.watch drops events.
 *
 * Throws if `directory` cannot be read. Listen for `'error'`, which reports directory failures.
 */
export function dispatch(directory: string, handler: FileHandler, options: DispatchOptions = {}): Dispatcher {
  return new Dispatcher(directory, handler, options);
}

export class Dispatcher extends EventEmitter<DispatcherEvents> {
  /** Absolute path of the watched directory. */
  readonly directory: string;

  private readonly watcher: DirectoryWatcher;
  private readonly handler: FileHandler;
  private readonly concurrency: number;
  private readonly done: ResolvedAction;
  private readonly failed: ResolvedAction;
  private readonly inFlight = new Set<Promise<void>>();
  private active = 0;
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
    this.done = resolveAction(options.done, 'done', resolved.directory);
    this.failed = resolveAction(options.failed, 'failed', resolved.directory);

    this.watcher = new DirectoryWatcher({
      ...resolved,
      existing: options.existing ?? this.done.type !== 'keep',
      ordered: this.concurrency === 1,
      onAvailable: () => this.pump(),
      onError: (error) => this.emit('error', error),
    });
    this.watcher.start();

    if (resolved.signal) {
      if (resolved.signal.aborted) {
        void this.close();
      } else {
        resolved.signal.addEventListener('abort', () => void this.close(), { once: true });
      }
    }
  }

  /** Stops watching and resolves once running handlers and their actions finish. Pending files are left in place. */
  close(): Promise<void> {
    this.closing ??= (async () => {
      this.watcher.stop();
      await Promise.all(this.inFlight);
    })();
    return this.closing;
  }

  private pump(): void {
    while (!this.closing && this.active < this.concurrency) {
      const ready = this.watcher.take();
      if (!ready) {
        return;
      }

      this.active += 1;
      const task: Promise<void> = this.process(ready).then((removed) => {
        this.inFlight.delete(task);
        this.active -= 1;
        this.watcher.release(ready, removed);
        this.pump();
      });
      this.inFlight.add(task);
    }
  }

  /** Handles one file and resolves whether it was removed from the directory. Never rejects. */
  private async process(ready: ReadyFile): Promise<boolean> {
    const file = new DispatchedFile(ready);

    let handlerError: Error | undefined;
    try {
      await this.handler(file);
    } catch (error) {
      handlerError = toError(error);
    }

    const action = handlerError ? this.failed : this.done;
    try {
      await applyAction(action, file);
    } catch (error) {
      this.emitSafely('failed', toError(error), file);
      return false;
    }

    if (handlerError) {
      this.emitSafely('failed', handlerError, file);
    } else {
      this.emitSafely('processed', file);
    }
    return action.type !== 'keep';
  }

  // A throwing listener must not stall the queue; surface it as an uncaught exception instead.
  private emitSafely<K extends 'processed' | 'failed'>(event: K, ...args: DispatcherEvents[K]): void {
    try {
      (this.emit as (event: K, ...args: DispatcherEvents[K]) => boolean)(event, ...args);
    } catch (error) {
      queueMicrotask(() => {
        throw error;
      });
    }
  }
}

function resolveAction(action: FileAction | undefined, name: string, watched: string): ResolvedAction {
  if (action === undefined || action === 'keep') {
    return { type: 'keep' };
  }
  if (action === 'delete') {
    return { type: 'delete' };
  }
  if (typeof action === 'object' && action !== null && typeof action.moveTo === 'string' && action.moveTo.length > 0) {
    const directory = path.resolve(action.moveTo);
    if (directory === watched) {
      throw new TypeError(`${name}.moveTo must differ from the watched directory.`);
    }
    fs.mkdirSync(directory, { recursive: true });
    return { type: 'move', directory };
  }
  throw new TypeError(`${name} must be 'keep', 'delete', or { moveTo: string }.`);
}

async function applyAction(action: ResolvedAction, file: DispatchedFile): Promise<void> {
  if (action.type === 'keep') {
    return;
  }

  if (action.type === 'delete') {
    await unlink(file.path).catch(ignoreMissing);
    return;
  }

  const target = path.join(action.directory, file.name);
  try {
    await rename(file.path, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') {
      throw error;
    }
    // rename cannot cross file systems.
    await copyFile(file.path, target);
    await unlink(file.path);
  }
}

function ignoreMissing(error: NodeJS.ErrnoException): void {
  if (error.code !== 'ENOENT') {
    throw error;
  }
}
