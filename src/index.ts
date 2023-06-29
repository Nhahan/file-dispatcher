import fs from "fs";
import * as path from 'path';
import { EventEmitter } from 'events';
import { Worker } from 'worker_threads';
import {FdEventType, FdMode, FileDispatcherOptions, FdInterceptor} from './type';

export class FileDispatcher extends EventEmitter {
  private readonly path: string;
  private readonly mode: FdMode;
  private readonly interceptor?: FdInterceptor;
  private readonly pattern?: RegExp;
  private worker?: Worker;
  private watcher?: fs.FSWatcher;

  constructor(options: FileDispatcherOptions) {
    super();
    const { path, mode, interceptor, pattern } = options;

    if (!Object.values(FdMode).includes(mode)) {
      console.log('Invalid mode:', mode);
      return;
    }
    this.path = path;
    this.mode = mode;
    this.interceptor = interceptor;
    this.pattern = pattern;
  }

  private emitEvent(eventType: FdEventType, filePath: string, content: string): void {
    if (this.interceptor) content = this.interceptor(filePath, content);
    this.emit(eventType, filePath, content);
  }

  private processFileAsync(filePath: string): Promise<void> {
    return new Promise((resolve, _) => {
      if (this.worker) {

      } else {
        fs.readFile(filePath, 'utf8', (error, data) => {
          if (error) {
            this.emitEvent(FdEventType.Fail, filePath, error.message);
          } else {
            this.emitEvent(FdEventType.Success, filePath, data);
          }
          resolve();
        });
      }
    });
  }

  private processFileSync(filePath: string): void {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      this.emitEvent(FdEventType.Success, filePath, content);
    } catch (error: any) {
      this.emitEvent(FdEventType.Fail, filePath, error.message);
    }
  }

  private setupWorker(): void {
    if (!this.worker) {
      this.worker = new Worker(workerCode, { eval: true }); // don't want to separate worker.js
      this.worker.on('message', ({ filePath, content }: { filePath: string; content: string }) => {
        this.emitEvent(FdEventType.Success, filePath, content);
      });
      this.worker.on('error', (error) => {
        console.error('Worker error:', error);
      });
    }
  }

  private cleanupWorker(): void {
    if (this.worker) {
      this.worker.terminate().then(() => {
        this.worker = undefined;
      });
    }
  }

  start(): void {
    if (this.watcher) {
      console.log('[FileDispatcher] Already started.');
      return;
    }
    this.setupWorker();

    this.watcher = fs.watch(this.path, { recursive: true, persistent: true }, (eventType, filename) => {
      if (eventType === 'rename' && filename && (!this.pattern || filename.toString().match(this.pattern))) {
        const filePath = path.join(this.path, filename.toString());
        if (!fs.existsSync(filePath)) return;
        (this.mode === FdMode.Async
                ? this.processFileAsync(filePath).catch((error) => {
                  console.error('File processing error:', error);
                })
                : this.processFileSync(filePath)
        );
      }
    });
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = undefined;
    }
    this.cleanupWorker();
  }
}


const workerCode = `
const fs = require('fs');
const { parentPort } = require("worker_threads");

parentPort?.on('message', async ({ filePath }) => {
    try {
        const content = await fs.promises.readFile(filePath, 'utf8');
        parentPort?.postMessage({ filePath, content });
    } catch (error) {
        console.error('Worker file processing error:', error);
    }
});
`;
