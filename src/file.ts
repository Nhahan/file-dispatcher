import { createReadStream, readFile, type ReadStream } from 'node:fs';
import { promisify } from 'node:util';

import type { ReadyFile } from './watcher';

const read = promisify(readFile);

/** A file that was created in the watched directory and has finished being written. Content is read on demand. */
export interface DispatchedFile {
  /** Stays the same for the same file across restarts; use it to make handlers idempotent. */
  readonly id: string;
  /** Absolute path where the file was found. */
  readonly path: string;
  /** File name within the watched directory. */
  readonly name: string;
  /** Size in bytes once the file stopped changing. */
  readonly size: number;
  /** Birth time, or modification time where the file system does not record it. */
  readonly createdAt: Date;
  /** Reads the whole file as text. */
  text(encoding?: BufferEncoding): Promise<string>;
  /** Reads the whole file as bytes. */
  buffer(): Promise<Buffer>;
  /** Streams the file, for content too large to hold in memory. */
  stream(): ReadStream;
}

export function createFile(file: ReadyFile): DispatchedFile {
  return {
    id: file.id,
    path: file.path,
    name: file.name,
    size: file.size,
    createdAt: new Date(file.createdMs),
    text: (encoding: BufferEncoding = 'utf8') => read(file.path, { encoding }),
    buffer: () => read(file.path),
    stream: () => createReadStream(file.path),
  };
}
