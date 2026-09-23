import { createFile, type DispatchedFile } from './file';
import { onAbort, resolveWatchOptions, type WatchOptions } from './options';
import { DirectoryWatcher, type ReadyFile } from './watcher';

/**
 * Yields every file created in `directory`, oldest first, after it has finished being written.
 * The next file is found only after the loop body for the previous one completes, and the directory
 * is never modified. Breaking out of the loop stops watching.
 *
 * Throws if `directory` cannot be read. A directory failure while watching is thrown from the loop
 * once and ends the iteration.
 */
export function watch(directory: string, options: WatchOptions = {}): FileWatcher {
  return new FileWatcher(directory, options);
}

export class FileWatcher implements AsyncIterableIterator<DispatchedFile> {
  /** Absolute path of the watched directory. */
  readonly directory: string;

  private readonly watcher: DirectoryWatcher;
  private stopListening: () => void = () => {};
  private current: ReadyFile | undefined;
  private wake: (() => void) | undefined;
  private error: Error | undefined;
  private closed = false;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(directory: string, options: WatchOptions) {
    const resolved = resolveWatchOptions(directory, options);
    this.directory = resolved.directory;
    this.watcher = new DirectoryWatcher({
      ...resolved,
      existing: options.existing ?? false,
      ordered: true,
      onAvailable: () => this.notify(),
      onError: (error) => {
        this.error ??= error;
        this.notify();
      },
    });
    this.watcher.start();
    this.stopListening = onAbort(resolved.signal, () => void this.close());
  }

  next(): Promise<IteratorResult<DispatchedFile, undefined>> {
    // Calls are serialized so concurrent next() calls each get their own file.
    const result = this.queue.then(() => this.pull());
    this.queue = result.catch(() => undefined);
    return result;
  }

  async return(): Promise<IteratorResult<DispatchedFile, undefined>> {
    await this.close();
    return { done: true, value: undefined };
  }

  [Symbol.asyncIterator](): FileWatcher {
    return this;
  }

  /** Stops watching. A pending `next()` resolves as done. */
  async close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      this.watcher.stop();
      this.stopListening();
      this.notify();
    }
  }

  private async pull(): Promise<IteratorResult<DispatchedFile, undefined>> {
    if (this.current) {
      this.watcher.release(this.current, false);
      this.current = undefined;
    }

    for (;;) {
      if (this.closed) {
        return { done: true, value: undefined };
      }
      if (this.error) {
        const error = this.error;
        await this.close();
        throw error;
      }

      const ready = this.watcher.take();
      if (ready) {
        this.current = ready;
        return { done: false, value: createFile(ready) };
      }

      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }

  private notify(): void {
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }
}
