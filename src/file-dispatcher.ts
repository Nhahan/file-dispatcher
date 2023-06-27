import * as fs from 'fs';
import { EventEmitter } from 'events';
import { promisify } from 'util';
import * as path from 'path';

export enum FdEventType {
  Success = 'FdEventType.Success',
  Fail = 'FdEventType.Fail',
}

export enum FdMode {
  Async = 'FdMode.Async',
  Sync = 'FdMode.Sync',
}

export class FileDispatcher extends EventEmitter {
  constructor(
    private readonly directory: string,
    private readonly executionMode: FdMode,
    private pattern?: RegExp
  ) {
    super();
  }

  start(): void {
    if (this._watcher) {
      console.log("[FileDispatcher] Already started.")
      return;
    }

    this._watcher = fs.watch(this.directory, { encoding: 'utf8' }, (eventType, filename) => {
      if (eventType === 'rename' && filename && (!this.pattern || filename.match(this.pattern))) {
        const filePath = path.join(this.directory, filename);

        this.executionMode === FdMode.Async
          ? this.dispatchFileAsync(filePath)
          : this.dispatchFileSync(filePath);
      }
    });
  }

  stop(): void {
    if (this._watcher) {
      this._watcher.close();
      this._watcher = undefined;
    }
  }

  private _watcher?: fs.FSWatcher;

  private async dispatchFileAsync(filePath: string): Promise<void> {
    try {
      const fileContent = await promisify(fs.readFile)(filePath, 'utf8');
      this.emit(FdEventType.Success, filePath, fileContent);
    } catch (error) {
      this.emit(FdEventType.Fail, error);
    }
  }

  private dispatchFileSync(filePath: string): void {
    try {
      const fileContent = fs.readFileSync(filePath, 'utf8');
      this.emit(FdEventType.Success, filePath, fileContent);
    } catch (error) {
      this.emit(FdEventType.Fail, error);
    }
  }
}
