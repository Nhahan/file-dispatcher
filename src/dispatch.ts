import { AsyncLocalStorage } from 'node:async_hooks';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { applyAction, parseAction, prepareAction, type ActionResult, type DoneAction, type ResolvedAction } from './actions';
import { DirectoryWatcher, toError, type ReadyFile } from './watcher';

// A failed done action is retried with backoff; afterwards the file stays where it is.
const ACTION_ATTEMPTS = 5;
const ACTION_RETRY_MS = 250;

/** A file that was created in the watched directory and has finished being written. */
export interface DispatchedFile {
  /** Stays the same for the same file across restarts; use it to make handlers idempotent. */
  readonly id: string;
  /** File name within the watched directory. */
  readonly name: string;
  /** Absolute path where the file was found. */
  readonly path: string;
  /** Size in bytes once the file stopped changing. */
  readonly size: number;
  /** Birth time, or modification time where the file system does not record it. */
  readonly createdAt: Date;
}

export type FileHandler = (file: DispatchedFile) => unknown;

export interface DispatchOptions {
  /** Only files whose names match are handled. Default: every file. */
  filter?: RegExp | ((name: string) => boolean) | undefined;
  /**
   * Handlers running at once. With `1`, files are handled one at a time, oldest first, and each
   * handler finishes before the next file starts. Default: `1`.
   */
  concurrency?: number | undefined;
  /**
   * Applied after the handler succeeds. When it removes files, files already in the directory at
   * start are handled too, since they are left over from an earlier run. Default: `'keep'`.
   */
  done?: DoneAction | undefined;
  /** Milliseconds a file's size and modification time must stay unchanged before it is handled. Default: `50`. */
  stabilityThreshold?: number | undefined;
}

type ErrorListener = (error: Error, file: DispatchedFile | undefined) => void;

export interface Dispatcher {
  /**
   * `file` is the file whose handler threw, or whose `done` action kept failing; it is left in place.
   * Without it, the directory could not be watched or listed, and dispatching resumes once it can.
   */
  on(event: 'error', listener: ErrorListener): this;
  once(event: 'error', listener: ErrorListener): this;
  off(event: 'error', listener: ErrorListener): this;
  addListener(event: 'error', listener: ErrorListener): this;
  removeListener(event: 'error', listener: ErrorListener): this;
  prependListener(event: 'error', listener: ErrorListener): this;
  prependOnceListener(event: 'error', listener: ErrorListener): this;
  emit(event: 'error', error: Error, file: DispatchedFile | undefined): boolean;
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

export class Dispatcher extends EventEmitter {
  private readonly watcher: DirectoryWatcher;
  private readonly handler: FileHandler;
  private readonly concurrency: number;
  private readonly done: ResolvedAction;
  // Cuts short the waits between action retries once closed.
  private readonly closing = new AbortController();
  // Identifies the task a handler runs in, so close() called from a handler does not wait for itself.
  private readonly currentTask = new AsyncLocalStorage<symbol>();
  private readonly tasks = new Map<symbol, Promise<void>>();
  // Tasks whose handler is waiting in close(); they do not wait for each other.
  private readonly closingTasks = new Set<symbol>();
  private closed = false;

  constructor(directory: string, handler: FileHandler, options: DispatchOptions) {
    super();
    if (typeof directory !== 'string' || directory.length === 0) {
      throw new TypeError('directory must be a non-empty string.');
    }
    if (typeof handler !== 'function') {
      throw new TypeError('handler must be a function.');
    }

    const resolved = path.resolve(directory);
    this.handler = handler;
    this.concurrency = positiveInteger(options.concurrency ?? 1, 'concurrency');
    this.done = parseAction(options.done);

    this.watcher = new DirectoryWatcher({
      directory: resolved,
      filter: toPredicate(options.filter),
      stabilityThreshold: nonNegativeNumber(options.stabilityThreshold ?? 50, 'stabilityThreshold'),
      // When done removes handled files, whatever is in the directory at start has not been handled.
      existing: this.done.type !== 'keep',
      ordered: this.concurrency === 1,
      onAvailable: () => this.pump(),
      onError: (error) => this.report(error, undefined),
    });
    this.watcher.start();

    try {
      prepareAction(this.done, resolved);
    } catch (error) {
      this.watcher.stop();
      throw error;
    }
  }

  /**
   * Stops watching and resolves once running handlers and their actions finish. Files not yet
   * handled are left in place. Called from a handler, it does not wait for that handler.
   */
  close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      this.watcher.stop();
      this.closing.abort();
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
        .then((result) => {
          this.tasks.delete(id);
          const removed = result.type === 'removed' || result.type === 'moved';
          this.watcher.release(ready, removed, result.type === 'replaced');
          this.pump();
        });
      this.tasks.set(id, task);
    }
  }

  /** Handles one file. Never rejects. */
  private async process(ready: ReadyFile): Promise<ActionResult> {
    const file: DispatchedFile = {
      id: ready.id,
      name: ready.name,
      path: ready.path,
      size: ready.size,
      createdAt: new Date(ready.createdMs),
    };

    try {
      await this.handler(file);
    } catch (error) {
      this.report(toError(error), file);
      return { type: 'kept' };
    }

    for (let attempt = 1; ; attempt += 1) {
      try {
        return await applyAction(this.done, ready);
      } catch (error) {
        if (attempt === ACTION_ATTEMPTS || !(await this.wait(ACTION_RETRY_MS * 2 ** (attempt - 1)))) {
          this.report(toError(error), file);
          return { type: 'kept' };
        }
      }
    }
  }

  /** Resolves false when the dispatcher closes first. */
  private wait(ms: number): Promise<boolean> {
    return delay(ms, true, { signal: this.closing.signal }).catch(() => false);
  }

  // Like EventEmitter without an 'error' listener, errors are thrown, but outside the dispatcher's own
  // promises, so a throwing listener cannot stall the queue either.
  private report(error: Error, file: DispatchedFile | undefined): void {
    try {
      this.emit('error', error, file);
    } catch (thrown) {
      process.nextTick(() => {
        throw thrown;
      });
    }
  }
}

function toPredicate(filter: DispatchOptions['filter']): (name: string) => boolean {
  if (filter === undefined) {
    return () => true;
  }
  if (typeof filter === 'function') {
    return filter;
  }
  if (filter instanceof RegExp) {
    // Global and sticky patterns keep state between test() calls.
    return (name) => {
      filter.lastIndex = 0;
      return filter.test(name);
    };
  }
  throw new TypeError('filter must be a RegExp or a function.');
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
