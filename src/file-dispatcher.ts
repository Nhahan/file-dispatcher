import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import { promisify } from 'util';

export enum FdEventType {
  Success = 'FdEventType.Success',
  Fail = 'FdEventType.Fail',
}

export enum FdMode {
  Async = 'FdMode.Async',
  Sync = 'FdMode.Sync',
}

export class FileDispatcher extends EventEmitter {
  private watcher?: fs.FSWatcher;

  constructor(
      private readonly directory: string,
      private readonly executionMode: FdMode,
      private pattern?: RegExp
  ) {
    super();
  }

  private async processFileAsync(filePath: string): Promise<void> {
    try {
      const content = await promisify(fs.readFile)(filePath, 'utf8');
      this.emit(FdEventType.Success, filePath, content);
    } catch (error: any) {
      this.emit(FdEventType.Fail, error);
    }
  }

  private processFileSync(filePath: string): void {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      this.emit(FdEventType.Success, filePath, content);
    } catch (error: any) {
      this.emit(FdEventType.Fail, error);
    }
  }

  start(): void {
    if (this.watcher) {
      console.log("[FileDispatcher] Already started.");
      return;
    }

    this.watcher = fs.watch(this.directory, { persistent: true }, async (eventType: string, filename: Buffer | string | null) => {
      if (eventType === 'rename' && filename && (!this.pattern || filename.toString().match(this.pattern))) {
        const filePath = path.join(this.directory, filename.toString());
        if (this.executionMode === FdMode.Async) {
          await this.processFileAsync(filePath);
        } else {
          this.processFileSync(filePath);
        }
      }
    });
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = undefined;
    }
  }
}
