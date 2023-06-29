import fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import { Worker } from 'worker_threads';

export class FileDispatcher extends EventEmitter {
  private readonly path: string = '';
  private readonly mode: FdMode = FdMode.Async;
  private readonly interceptor?: FdInterceptor;
  private readonly pattern?: RegExp;
  private workers: AvailableWorker[] = [];
  private taskQueue: Task[] = [];
  private watcher?: fs.FSWatcher;

  constructor(options: FileDispatcherOptions) {
    super();
    const { path, mode, interceptor, pattern } = options;

    if (Object.keys(FdMode).indexOf(mode) === -1) {
      console.log('Invalid mode:', mode);
      return;
    }

    this.path = path;
    this.mode = mode;
    this.interceptor = interceptor;
    this.pattern = pattern;
  }

  private getAvailableWorker(): AvailableWorker | null {
    return this.workers.find(worker => worker.isAvailable) || null;
  }

  private async processFile(task: Task): Promise<void> {
    const worker = this.getAvailableWorker();
    if (worker) {
      worker.isAvailable = false;
      worker.postMessage(task);
    } else {
      this.taskQueue.push(task);
    }
  }

  private processPendingTasks(): void {
    while (this.taskQueue.length > 0 && this.getAvailableWorker()) {
      const task = this.taskQueue.shift() as Task;
      this.processFile(task).catch((error) => {
        console.error('File processing error:', error);
      });
    }
  }

  private setupWorkers(): void {
    const numWorkers = this.mode === FdMode.Async ? 2 : 1;
    const workerPath = path.join(__dirname, 'worker.js');
    for (let i = 0; i < numWorkers; i++) {
      const worker = new Worker(workerPath) as AvailableWorker;
      worker.isAvailable = true;
      worker.on('message', ({ filePath, content }: { filePath: string; content: string }) => {
        worker.isAvailable = true;
        if (this.interceptor) content = this.interceptor(filePath, content);
        this.emit(FdEventType.Success, filePath, content);
        this.processPendingTasks();
      });
      worker.on('error', (error) => {
        worker.isAvailable = true;
        console.error('Worker error:', error);
        this.processPendingTasks();
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
    this.watcher = fs.watch(this.path, { recursive: true, persistent: true }, (eventType, filename) => {
      if (eventType === 'rename' && filename && (!this.pattern || filename.toString().match(this.pattern))) {
        const filePath = path.join(this.path, filename.toString());
        if (!fs.existsSync(filePath)) return;
        this.processFile({ filePath }).catch((error) => {
          console.error('File processing error:', error);
        });
      }
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
