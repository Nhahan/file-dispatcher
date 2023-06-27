import * as fs from 'fs';
import { EventEmitter } from 'events';
import { Worker } from 'worker_threads';
import * as path from 'path';
import os from 'os';

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
  private workers: Worker[] = [];
  private workerCount: number = os.cpus().length - 1;
  private queue: string[] = [];

  constructor(
      private readonly directory: string,
      private readonly executionMode: FdMode,
      private pattern?: RegExp
  ) {
    super();

    for (let i = 0; i < this.workerCount; i++) {
      const worker = new Worker(`
        const p=require('worker_threads').parentPort,f=require('fs');
        p.on('message',({filePath:d})=>{
          try{p.postMessage({s:1,c:f.readFileSync(d,'utf8')})}
          catch(e){p.postMessage({s:0,e})}});
      `, { eval: true });

      worker.on('message', (data: { s: boolean, c?: string, e?: any }) => {
        if (data.s) {
          this.emit(FdEventType.Success, this.queue[0], data.c);
        } else {
          this.emit(FdEventType.Fail, data.e);
        }
        this.queue.shift();
        if (this.executionMode === FdMode.Sync && this.queue.length > 0) {
          worker.postMessage({ filePath: this.queue[0], mode: this.executionMode });
        } else {
          this.workers.push(worker);
        }
      });

      worker.on('error', (error) => {
        this.emit(FdEventType.Fail, error);
        this.workers.push(worker);
      });

      this.workers.push(worker);
    }
  }

  start(): void {
    if (this.watcher) {
      console.log("[FileDispatcher] Already started.")
      return;
    }

    this.watcher = fs.watch(this.directory, { encoding: 'utf8' }, (eventType, filename) => {
      if (eventType === 'rename' && filename && (!this.pattern || filename.match(this.pattern))) {
        const filePath = path.join(this.directory, filename);
        if (this.executionMode === FdMode.Async || this.workers.length === 0) {
          this.queue.push(filePath);
        }
        if (this.workers.length > 0) {
          const worker = this.workers.shift() as Worker;
          if (this.executionMode === FdMode.Async || (this.executionMode === FdMode.Sync && this.queue.length === 1)) {
            worker.postMessage({ filePath: filePath, mode: this.executionMode });
          }
        }
      }
    });
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = undefined;
      this.workers.forEach(worker => worker.terminate());
    }
  }
}
