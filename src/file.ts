import fs from 'node:fs';
import { promisify } from 'node:util';

import type { ReadyFile } from './watcher';

const readFile = promisify(fs.readFile);

/** A file that was created in the watched directory and has finished being written. Content is read on demand. */
export class DispatchedFile {
  /** Absolute path. */
  readonly path: string;
  /** File name within the watched directory. */
  readonly name: string;
  /** Size in bytes once the file stopped changing. */
  readonly size: number;
  /** Birth time, or modification time where the file system does not record it. */
  readonly createdAt: Date;

  constructor(file: ReadyFile) {
    this.path = file.path;
    this.name = file.name;
    this.size = file.size;
    this.createdAt = new Date(file.createdMs);
  }

  /** Reads the whole file as text. */
  text(encoding: BufferEncoding = 'utf8'): Promise<string> {
    return readFile(this.path, { encoding });
  }

  /** Reads the whole file as bytes. */
  buffer(): Promise<Buffer> {
    return readFile(this.path);
  }

  /** Streams the file, for content too large to hold in memory. */
  stream(): fs.ReadStream {
    return fs.createReadStream(this.path);
  }
}
