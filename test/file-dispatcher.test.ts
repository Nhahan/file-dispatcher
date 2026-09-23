import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { FdEventType, FdMode, FileDispatcher, type FdEncoding } from '../src';

type Delivery = { name: string; content: string | Buffer };

let dir: string;
const dispatchers: FileDispatcher<FdEncoding>[] = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-dispatcher-'));
});

afterEach(async () => {
  await Promise.all(dispatchers.splice(0).map((dispatcher) => dispatcher.stop()));
  fs.rmSync(dir, { recursive: true, force: true });
});

function track<E extends FdEncoding>(dispatcher: FileDispatcher<E>) {
  dispatchers.push(dispatcher as unknown as FileDispatcher<FdEncoding>);
  const delivered: Delivery[] = [];
  const failures: { error: Error; filePath: string | undefined }[] = [];
  dispatcher.on(FdEventType.Success, (filePath, content) => delivered.push({ name: path.basename(filePath), content }));
  dispatcher.on(FdEventType.Fail, (error, filePath) => failures.push({ error, filePath }));
  return { dispatcher, delivered, failures };
}

async function waitFor(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`Timed out after ${timeoutMs}ms`);
    }
    await sleep(10);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function write(name: string, content: string | Buffer = name): void {
  fs.writeFileSync(path.join(dir, name), content);
}

describe('FileDispatcher', () => {
  test('dispatches files created after start with their content', async () => {
    const { dispatcher, delivered } = track(new FileDispatcher({ path: dir }));
    dispatcher.start();

    write('a.txt', 'hello');
    write('b.txt', 'world');
    await waitFor(() => delivered.length === 2);

    assert.deepEqual(delivered.map((entry) => entry.name).sort(), ['a.txt', 'b.txt']);
    assert.equal(delivered.find((entry) => entry.name === 'a.txt')?.content, 'hello');
  });

  test('ignores existing files, modifications, deletions, and directories', async () => {
    write('existing.txt', 'old');
    write('removed.txt', 'old');
    const { dispatcher, delivered } = track(new FileDispatcher({ path: dir }));
    dispatcher.start();

    fs.appendFileSync(path.join(dir, 'existing.txt'), ' modified');
    fs.unlinkSync(path.join(dir, 'removed.txt'));
    fs.mkdirSync(path.join(dir, 'subdirectory'));
    write('marker.txt');
    await waitFor(() => delivered.length === 1);
    await sleep(300);

    assert.deepEqual(delivered.map((entry) => entry.name), ['marker.txt']);
  });

  test('dispatches a file again when it is deleted and created again', async () => {
    const { dispatcher, delivered } = track(new FileDispatcher({ path: dir, rescanInterval: 50 }));
    dispatcher.start();

    write('again.txt', 'first');
    await waitFor(() => delivered.length === 1);
    fs.unlinkSync(path.join(dir, 'again.txt'));
    await sleep(200);
    write('again.txt', 'second');
    await waitFor(() => delivered.length === 2);

    assert.deepEqual(delivered.map((entry) => entry.content), ['first', 'second']);
  });

  test('filters file names with a pattern, including global patterns', async () => {
    const { dispatcher, delivered } = track(new FileDispatcher({ path: dir, pattern: /\.log$/g }));
    dispatcher.start();

    write('skip.txt');
    write('one.log');
    write('two.log');
    await waitFor(() => delivered.length === 2);
    await sleep(200);

    assert.deepEqual(delivered.map((entry) => entry.name).sort(), ['one.log', 'two.log']);
  });

  test('reads binary files intact when encoding is null', async () => {
    const { dispatcher, delivered } = track(new FileDispatcher({ path: dir, encoding: null }));
    dispatcher.start();

    const bytes = Buffer.from([0x41, 0x00, 0x42, 0xff]);
    write('data.bin', bytes);
    await waitFor(() => delivered.length === 1);

    assert.ok(Buffer.isBuffer(delivered[0]?.content));
    assert.deepEqual(delivered[0]?.content, bytes);
  });

  test('applies sync and async interceptors', async () => {
    const upper = track(new FileDispatcher({ path: dir, interceptor: (_, content) => content.toUpperCase() }));
    const delayed = track(
      new FileDispatcher({
        path: dir,
        interceptor: async (filePath, content) => `${path.basename(filePath)}:${content}`,
      }),
    );
    upper.dispatcher.start();
    delayed.dispatcher.start();

    write('file.txt', 'content');
    await waitFor(() => upper.delivered.length === 1 && delayed.delivered.length === 1);

    assert.equal(upper.delivered[0]?.content, 'CONTENT');
    assert.equal(delayed.delivered[0]?.content, 'file.txt:content');
  });

  test('emits Fail with the file path when the interceptor throws', async () => {
    const { dispatcher, delivered, failures } = track(
      new FileDispatcher({
        path: dir,
        interceptor: (filePath, content) => {
          if (filePath.endsWith('bad.txt')) {
            throw new Error('rejected');
          }
          return content;
        },
      }),
    );
    dispatcher.start();

    write('bad.txt');
    write('good.txt');
    await waitFor(() => failures.length === 1 && delivered.length === 1);

    assert.equal(failures[0]?.error.message, 'rejected');
    assert.equal(failures[0]?.filePath, path.join(dir, 'bad.txt'));
    assert.equal(delivered[0]?.name, 'good.txt');
  });

  test('waits until a file stops changing before reading it', async () => {
    const { dispatcher, delivered } = track(new FileDispatcher({ path: dir, stabilityThreshold: 300 }));
    dispatcher.start();

    const fd = fs.openSync(path.join(dir, 'slow.txt'), 'w');
    for (const chunk of ['one ', 'two ', 'three']) {
      fs.writeSync(fd, chunk);
      await sleep(100);
    }
    fs.closeSync(fd);
    await waitFor(() => delivered.length === 1);

    assert.equal(delivered[0]?.content, 'one two three');
  });

  test('finds new files when watch events are lost', async (t) => {
    // Simulates the kernel dropping every event: only rescans can find the files.
    t.mock.method(fs, 'watch', () => Object.assign(new EventEmitter(), { close: () => {} }));
    const { dispatcher, delivered } = track(new FileDispatcher({ path: dir, rescanInterval: 100 }));
    dispatcher.start();

    for (let index = 0; index < 50; index += 1) {
      write(`lost-${index}.txt`);
    }
    await waitFor(() => delivered.length === 50);

    assert.equal(new Set(delivered.map((entry) => entry.name)).size, 50);
  });

  test('dispatches every file of a burst from another process exactly once', async () => {
    const { dispatcher, delivered } = track(new FileDispatcher({ path: dir, concurrency: 8 }));
    dispatcher.start();

    const count = 2000;
    const body = 'x'.repeat(4096);
    await new Promise<void>((resolve, reject) => {
      const writer = spawn(process.execPath, [
        '-e',
        `const fs = require('fs'); for (let i = 0; i < ${count}; i++) fs.writeFileSync(require('path').join(${JSON.stringify(dir)}, 'burst-' + i + '.txt'), 'x'.repeat(4096));`,
      ]);
      writer.on('error', reject);
      writer.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`writer exited with ${code}`))));
    });
    await waitFor(() => delivered.length >= count, 30_000);
    await sleep(300);

    assert.equal(delivered.length, count);
    assert.equal(new Set(delivered.map((entry) => entry.name)).size, count);
    assert.ok(delivered.every((entry) => entry.content === body));
  });

  test('does not dispatch a file twice when it appears while a rescan is listing the directory', async (t) => {
    // A listing taken before a file exists can finish after the file's watch event arrives.
    const readdir = fsp.readdir;
    t.mock.method(fsp, 'readdir', async (...args: Parameters<typeof fsp.readdir>) => {
      const entries = await readdir(...args);
      await sleep(80);
      return entries;
    });
    const { dispatcher, delivered } = track(new FileDispatcher({ path: dir, rescanInterval: 30 }));
    dispatcher.start();

    for (let index = 0; index < 20; index += 1) {
      write(`race-${index}.txt`);
      await sleep(15);
    }
    await waitFor(() => new Set(delivered.map((entry) => entry.name)).size === 20);
    await sleep(500);

    assert.equal(delivered.length, 20);
  });

  test('dispatches one file at a time in creation order in sync mode', async () => {
    let active = 0;
    let maxActive = 0;
    const { dispatcher, delivered } = track(
      new FileDispatcher({
        path: dir,
        mode: FdMode.Sync,
        interceptor: async (_, content) => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await sleep(20);
          active -= 1;
          return content;
        },
      }),
    );
    dispatcher.start();

    const names = ['e.txt', 'd.txt', 'c.txt', 'b.txt', 'a.txt'];
    for (const name of names) {
      write(name);
      await sleep(30);
    }
    await waitFor(() => delivered.length === names.length);

    assert.deepEqual(delivered.map((entry) => entry.name), names);
    assert.equal(maxActive, 1);
  });

  test('keeps creation order in sync mode when the oldest file loses its watch event', async (t) => {
    const watch = fs.watch;
    t.mock.method(fs, 'watch', (target: fs.PathLike, options: fs.WatchOptions, listener: fs.WatchListener<string>) =>
      watch(target, options, (event, name) => {
        if (name !== 'first.txt') {
          listener(event, name);
        }
      }),
    );
    const { dispatcher, delivered } = track(new FileDispatcher({ path: dir, mode: FdMode.Sync, rescanInterval: 200 }));
    dispatcher.start();

    const names = ['first.txt', 'second.txt', 'third.txt'];
    for (const name of names) {
      write(name);
      await sleep(30);
    }
    await waitFor(() => delivered.length === names.length);

    assert.deepEqual(delivered.map((entry) => entry.name), names);
  });

  test('stops dispatching after stop and can start again', async () => {
    const { dispatcher, delivered } = track(new FileDispatcher({ path: dir }));
    dispatcher.start();
    dispatcher.start();

    write('before.txt');
    await waitFor(() => delivered.length === 1);
    await dispatcher.stop();

    write('while-stopped.txt');
    await sleep(300);
    assert.equal(delivered.length, 1);

    dispatcher.start();
    write('after.txt');
    await waitFor(() => delivered.length === 2);
    assert.equal(delivered[1]?.name, 'after.txt');
  });

  test('validates options and the watched directory', () => {
    assert.throws(() => new FileDispatcher({ mode: 'fast' as FdMode }), /Invalid mode: fast/);
    assert.throws(() => new FileDispatcher({ concurrency: 0 }), /concurrency must be a positive integer/);
    assert.throws(() => new FileDispatcher({ stabilityThreshold: -1 }), /stabilityThreshold must be a non-negative number/);
    assert.throws(() => new FileDispatcher({ path: path.join(dir, 'missing') }).start(), { code: 'ENOENT' });
  });

  test('can be imported from ES modules', async () => {
    const entry = pathToFileURL(path.join(__dirname, '..', 'src', 'index.js')).href;
    const module = (await import(entry)) as Record<string, unknown>;

    assert.equal(typeof module['FileDispatcher'], 'function');
    assert.equal((module['FdMode'] as Record<string, string>)['Sync'], FdMode.Sync);
  });
});
