import fs from 'node:fs';
import { promisify } from 'node:util';

import type { ReadyFile } from './watcher';

const readFile = promisify(fs.readFile);

/** A file that was created in the watched directory and has finished being written. Content is read on demand. */
export interface DispatchedFile {
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
  stream(): fs.ReadStream;
}

export function createFile(file: ReadyFile): DispatchedFile {
  return {
    path: file.path,
    name: file.name,
    size: file.size,
    createdAt: new Date(file.createdMs),
    text: (encoding: BufferEncoding = 'utf8') => readFile(file.path, { encoding }),
    buffer: () => readFile(file.path),
    stream: () => fs.createReadStream(file.path),
  };
}
