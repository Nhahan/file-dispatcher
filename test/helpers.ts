import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

export function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'file-dispatcher-'));
}

// Uses monotonic time, so tests that move the wall clock still time out.
export async function waitFor(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const started = performance.now();
  while (!condition()) {
    if (performance.now() - started > timeoutMs) {
      throw new Error(`Timed out after ${timeoutMs}ms`);
    }
    await sleep(10);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function write(dir: string, name: string, content: string | Buffer = name): void {
  fs.writeFileSync(path.join(dir, name), content);
}

/** Creates files from another process, the way a real producer would. */
export function writeFromAnotherProcess(dir: string, count: number, size: number): Promise<void> {
  const script = `const fs = require('fs'); const path = require('path'); const body = 'x'.repeat(${size});
    for (let i = 0; i < ${count}; i++) fs.writeFileSync(path.join(${JSON.stringify(dir)}, 'burst-' + i + '.txt'), body);`;
  return new Promise((resolve, reject) => {
    const writer = spawn(process.execPath, ['-e', script]);
    writer.on('error', reject);
    writer.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`writer exited with ${code}`))));
  });
}
