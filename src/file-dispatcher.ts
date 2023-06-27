import chokidar from 'chokidar';
import { EventEmitter } from 'events';
import { promisify } from 'util';
import * as fs from 'fs';

export enum FdEventType {
  Success = 'FdEventType.Success',
  Fail = 'FdEventType.Fail',
}

export enum FdMode {
  Async = 'FdMode.Async',
  Sync = 'FdMode.Sync',
}

export class FileDispatcher extends EventEmitter {
  private watcher: chokidar.FSWatcher;

  constructor(
      private readonly directory: string,
      private readonly executionMode: FdMode,
      private pattern?: RegExp
  ) {
    super();
    this.watcher = chokidar.watch(directory, {
      ignored: /(^|[/\\])\../, // 숨겨진 파일 및 폴더 무시
      persistent: true,
    });
  }

  start(): void {
    if (this.watcher) {
      console.log('[FileDispatcher] Already started.');
      return;
    }

    this.watcher
        .on('add', (filePath) => this.processFile(filePath))
        .on('change', (filePath) => this.processFile(filePath));
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = undefined;
    }
  }

  private async processFile(filePath: string): Promise<void> {
    if (!this.pattern || filePath.match(this.pattern)) {
      if (this.executionMode === FdMode.Async) {
        this.dispatchFileAsync(filePath);
      } else {
        await this.dispatchFileSync(filePath);
      }
    }
  }

  private async dispatchFileAsync(filePath: string): Promise<void> {
    try {
      const fileContent = await promisify(fs.readFile)(filePath, 'utf8');
      this.emit(FdEventType.Success, filePath, fileContent);
    } catch (error) {
      this.emit(FdEventType.Fail, error);
    }
  }

  private async dispatchFileSync(filePath: string): Promise<void> {
    try {
      const fileContent = await promisify(fs.readFile)(filePath, 'utf8');
      this.emit(FdEventType.Success, filePath, fileContent);
    } catch (error) {
      this.emit(FdEventType.Fail, error);
    }
  }
}
