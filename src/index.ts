import fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import { Worker } from 'worker_threads';

export class FileDispatcher extends EventEmitter {
  private readonly path: string = __dirname;
  private readonly mode: FdMode = FdMode.Async;
  private readonly interceptor?: FdInterceptor;
  private readonly pattern?: RegExp;
  private workers: AvailableWorker[] = [];
  private taskQueue: Task[] = [];
  private watcher?: fs.FSWatcher;

  constructor(options: FileDispatcherOptions) {
    super();
    const { path, mode, interceptor, pattern } = options;

    if (!Object.values(FdMode).includes(mode)) {
      console.log('Invalid mode:', mode);
      return;
    }

    this.path = path || __dirname;
    this.mode = mode || FdMode.Async;
    this.interceptor = interceptor || ((_, content) => content);
    this.pattern = pattern;
  }

  private getAvailableWorker(): AvailableWorker | null {
    return this.workers.find(worker => worker.isAvailable) || null;
  }

  private async processFile(task: Task): Promise<void> {
    const worker = this.getAvailableWorker();
    if (worker) {
      worker.isAvailable = false;
      worker.postMessage(task.filePath);
    } else {
      this.taskQueue.push(task);
    }
  }

  private setupWorkers(): void {
    const workerCount = this.mode === FdMode.Async ? 2 : 1;
    const workerPath = path.join(__dirname, 'worker.js');
    const filemodSyncPath = path.resolve(__dirname, 'filemod-sync.node');
    const filemodAsyncPath = path.resolve(__dirname, 'filemod-async.node');

    for (let i = 0; i < workerCount; i++) {
      const filemodPath = this.mode === FdMode.Async ? (i === 0 ? filemodSyncPath : filemodAsyncPath) : filemodSyncPath;

      const worker = new Worker(workerPath, { workerData: { filemodPath } }) as AvailableWorker;
      worker.isAvailable = true;

      worker.on('message', ({ filePath, content }: { filePath: string; content: string }) => {
        worker.isAvailable = true;
        content = this.interceptor!(filePath, content);
        this.emit(FdEventType.Success, filePath, content);
        const nextTask = this.taskQueue.shift();
        if (nextTask) {
          this.processFile(nextTask).catch(console.error);
        }
      });

      worker.on('error', (error) => {
        worker.isAvailable = true;
        console.error('Worker error:', error);
        const nextTask = this.taskQueue.shift();
        if (nextTask) {
          this.processFile(nextTask).catch(console.error);
        }
      });

      this.workers.push(worker);
    }
  }

  private cleanupWorkers(): void {
    this.workers.forEach(worker => {
      worker.terminate();
    });
    this.workers = [];
  }

  start(): void {
    if (this.watcher) {
      console.log('[FileDispatcher] Already started.');
      return;
    }
    this.setupWorkers();
    this.watcher = fs.watch(this.path, { persistent: true }, (_, filename) => {
      if (!filename || (this.pattern && !filename.toString().match(this.pattern))) return;

      const filePath = path.join(this.path, filename.toString());
      const task: Task = { filePath };
      this.processFile(task).catch((error) => {
        console.error('File processing error:', error);
      });
    });
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = undefined;
    }
    this.cleanupWorkers();
  }
}

interface AvailableWorker extends Worker {
  isAvailable: boolean;
}

export interface Task {
  filePath: string;
}

export enum FdEventType {
  Success = 'FdEventType.Success',
  Fail = 'FdEventType.Fail',
}

export enum FdMode {
  Async = 'FdMode.Async',
  Sync = 'FdMode.Sync',
}

export interface FileDispatcherOptions {
  path: string;
  mode: FdMode;
  interceptor?: FdInterceptor;
  pattern?: RegExp;
}

export type FdInterceptor = (filePath: string, content: string) => string;
