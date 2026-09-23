import path from 'node:path';

/** Selects files by name: a pattern tested against the name, or a predicate. */
export type FileFilter = RegExp | ((name: string) => boolean);

export interface WatchOptions {
  /** Only files whose names pass this filter are handled. Default: every file. */
  filter?: FileFilter | undefined;
  /** Also handle files that are already in the directory at start. */
  existing?: boolean | undefined;
  /** Milliseconds a file's size and mtime must stay unchanged before it is handled. Default: `50`. */
  stabilityThreshold?: number | undefined;
  /**
   * Minimum milliseconds between full rescans that run even without watch events. Very large
   * directories rescan less often. `0` disables them. Default: `1000`.
   */
  rescanInterval?: number | undefined;
  /** Stops watching when aborted. */
  signal?: AbortSignal | undefined;
}

export interface ResolvedWatchOptions {
  directory: string;
  filter: (name: string) => boolean;
  stabilityThreshold: number;
  rescanInterval: number;
  signal: AbortSignal | undefined;
}

export function resolveWatchOptions(directory: string, options: WatchOptions): ResolvedWatchOptions {
  if (typeof directory !== 'string' || directory.length === 0) {
    throw new TypeError('directory must be a non-empty string.');
  }

  return {
    directory: path.resolve(directory),
    filter: toPredicate(options.filter),
    stabilityThreshold: nonNegativeNumber(options.stabilityThreshold ?? 50, 'stabilityThreshold'),
    rescanInterval: nonNegativeNumber(options.rescanInterval ?? 1000, 'rescanInterval'),
    signal: options.signal,
  };
}

/** Runs `onAbort` once when `signal` aborts, and returns a function that stops listening. */
export function onAbort(signal: AbortSignal | undefined, onAbort: () => void): () => void {
  if (!signal) {
    return () => {};
  }
  if (signal.aborted) {
    onAbort();
    return () => {};
  }
  signal.addEventListener('abort', onAbort, { once: true });
  return () => signal.removeEventListener('abort', onAbort);
}

function toPredicate(filter: FileFilter | undefined): (name: string) => boolean {
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

export function positiveInteger(value: number, name: string): number {
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
