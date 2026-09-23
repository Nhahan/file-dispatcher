import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { dispatch, type Dispatcher, type DispatchedFile, type DispatchOptions, type FileHandler } from '../src';
import { sleep, tempDir, waitFor, write, writeFromAnotherProcess } from './helpers';

let dir: string;
let outside: string;
const dispatchers: Dispatcher[] = [];

beforeEach(() => {
  dir = tempDir();
  outside = tempDir();
});

afterEach(async () => {
  await Promise.all(dispatchers.splice(0).map((dispatcher) => dispatcher.close()));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

function start(handler: FileHandler, options?: DispatchOptions) {
  const dispatcher = dispatch(dir, handler, options);
  dispatchers.push(dispatcher);
  const processed: string[] = [];
  const failed: { error: Error; file: DispatchedFile }[] = [];
  const errors: Error[] = [];
  dispatcher.on('processed', (file) => processed.push(file.name));
  dispatcher.on('failed', (error, file) => failed.push({ error, file }));
  dispatcher.on('error', (error) => errors.push(error));
  return { dispatcher, processed, failed, errors };
}

function collect(options?: DispatchOptions) {
  const files: { name: string; content: string }[] = [];
  const started = start(async (file) => {
    files.push({ name: file.name, content: await file.text() });
  }, options);
  return { ...started, files };
}

describe('dispatch', () => {
  test('handles files created after start with lazy access to their content', async () => {
    const seen: { name: string; size: number; path: string; text: string; bytes: Buffer; streamed: string }[] = [];
    const { processed } = start(async (file) => {
      let streamed = '';
      for await (const chunk of file.stream()) {
        streamed += chunk;
      }
      seen.push({ name: file.name, size: file.size, path: file.path, text: await file.text(), bytes: await file.buffer(), streamed });
    });

    write(dir, 'a.txt', 'hello');
    await waitFor(() => processed.length === 1);

    assert.deepEqual(seen[0], {
      name: 'a.txt',
      size: 5,
      path: path.join(dir, 'a.txt'),
      text: 'hello',
      bytes: Buffer.from('hello'),
      streamed: 'hello',
    });
  });

  test('ignores modifications, deletions, and directories', async () => {
    write(dir, 'existing.txt', 'old');
    write(dir, 'removed.txt', 'old');
    const { files, processed } = collect();

    fs.appendFileSync(path.join(dir, 'existing.txt'), ' modified');
    fs.unlinkSync(path.join(dir, 'removed.txt'));
    fs.mkdirSync(path.join(dir, 'subdirectory'));
    write(dir, 'marker.txt');
    await waitFor(() => processed.length === 1);
    await sleep(300);

    assert.deepEqual(files.map((file) => file.name), ['marker.txt']);
  });

  test('skips existing files when done keeps them, and handles them when done removes them', async () => {
    write(dir, 'left-over.txt');
    const kept = collect();
    write(dir, 'new.txt');
    await waitFor(() => kept.processed.length === 1);
    await kept.dispatcher.close();
    assert.deepEqual(kept.files.map((file) => file.name), ['new.txt']);

    const removed = collect({ done: 'delete' });
    await waitFor(() => removed.processed.length === 2);
    assert.deepEqual(removed.files.map((file) => file.name).sort(), ['left-over.txt', 'new.txt']);
    assert.deepEqual(fs.readdirSync(dir), []);
  });

  test('moves files after success and after failure', async () => {
    const done = path.join(outside, 'done');
    const failedDir = path.join(outside, 'failed');
    const { processed, failed } = start(
      (file) => {
        if (file.name.startsWith('bad')) {
          throw new Error('rejected');
        }
      },
      { done: { moveTo: done }, failed: { moveTo: failedDir } },
    );

    write(dir, 'good.txt');
    write(dir, 'bad.txt');
    await waitFor(() => processed.length === 1 && failed.length === 1);

    assert.equal(failed[0]?.error.message, 'rejected');
    assert.equal(failed[0]?.file.name, 'bad.txt');
    assert.deepEqual(fs.readdirSync(done), ['good.txt']);
    assert.deepEqual(fs.readdirSync(failedDir), ['bad.txt']);
    assert.deepEqual(fs.readdirSync(dir), []);
  });

  test('handles a file again when it is removed and created again', async () => {
    const { files, processed } = collect({ done: 'delete', rescanInterval: 50 });

    write(dir, 'again.txt', 'first');
    await waitFor(() => processed.length === 1);
    write(dir, 'again.txt', 'second');
    await waitFor(() => processed.length === 2);

    assert.deepEqual(files.map((file) => file.content), ['first', 'second']);
  });

  test('handles a file created under a name whose earlier event was for a removal', async (t) => {
    // Delivers only synthetic events, like a late event for a file that was just deleted.
    let emit: fs.WatchListener<string> = () => {};
    t.mock.method(fs, 'watch', (_target: fs.PathLike, _options: fs.WatchOptions, listener: fs.WatchListener<string>) => {
      emit = listener;
      return Object.assign(new EventEmitter(), { close: () => {} });
    });
    const { files, processed } = collect({ rescanInterval: 0 });

    emit('rename', 'ghost.txt');
    await sleep(30);
    write(dir, 'ghost.txt');
    await waitFor(() => processed.length === 1);

    assert.deepEqual(files.map((file) => file.name), ['ghost.txt']);
  });

  test('filters names with a pattern or a predicate', async () => {
    const byPattern = collect({ filter: /\.log$/g });
    const byPredicate = collect({ filter: (name) => name.startsWith('two') });

    write(dir, 'skip.txt');
    write(dir, 'one.log');
    write(dir, 'two.log');
    await waitFor(() => byPattern.processed.length === 2 && byPredicate.processed.length === 1);
    await sleep(200);

    assert.deepEqual(byPattern.files.map((file) => file.name).sort(), ['one.log', 'two.log']);
    assert.deepEqual(byPredicate.files.map((file) => file.name), ['two.log']);
  });

  test('waits until a file stops changing before handling it', async () => {
    const { files, processed } = collect({ stabilityThreshold: 300 });

    const fd = fs.openSync(path.join(dir, 'slow.txt'), 'w');
    for (const chunk of ['one ', 'two ', 'three']) {
      fs.writeSync(fd, chunk);
      await sleep(100);
    }
    fs.closeSync(fd);
    await waitFor(() => processed.length === 1);

    assert.equal(files[0]?.content, 'one two three');
  });

  test('handles one file at a time in creation order by default', async () => {
    let active = 0;
    let maxActive = 0;
    const order: string[] = [];
    const { processed } = start(async (file) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await sleep(40);
      order.push(file.name);
      active -= 1;
    });

    const names = ['e.txt', 'd.txt', 'c.txt', 'b.txt', 'a.txt'];
    for (const name of names) {
      write(dir, name);
      await sleep(30);
    }
    await waitFor(() => processed.length === names.length);

    assert.deepEqual(order, names);
    assert.equal(maxActive, 1);
  });

  test('runs up to concurrency handlers at once', async () => {
    let active = 0;
    let maxActive = 0;
    const { processed } = start(
      async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await sleep(100);
        active -= 1;
      },
      { concurrency: 3 },
    );

    for (let index = 0; index < 9; index += 1) {
      write(dir, `file-${index}.txt`);
    }
    await waitFor(() => processed.length === 9);

    assert.equal(maxActive, 3);
  });

  test('keeps creation order when the oldest file loses its watch event', async (t) => {
    const watchFn = fs.watch;
    t.mock.method(fs, 'watch', (target: fs.PathLike, options: fs.WatchOptions, listener: fs.WatchListener<string>) =>
      watchFn(target, options, (event, name) => {
        if (name !== 'first.txt') {
          listener(event, name);
        }
      }),
    );
    const { files, processed } = collect({ rescanInterval: 200 });

    const names = ['first.txt', 'second.txt', 'third.txt'];
    for (const name of names) {
      write(dir, name);
      await sleep(30);
    }
    await waitFor(() => processed.length === names.length);

    assert.deepEqual(files.map((file) => file.name), names);
  });

  test('finds files when every watch event is lost', async (t) => {
    t.mock.method(fs, 'watch', () => Object.assign(new EventEmitter(), { close: () => {} }));
    const { files, processed } = collect({ concurrency: 8, rescanInterval: 100 });

    for (let index = 0; index < 50; index += 1) {
      write(dir, `lost-${index}.txt`);
    }
    await waitFor(() => processed.length === 50);

    assert.equal(new Set(files.map((file) => file.name)).size, 50);
  });

  test('does not handle a file twice when it appears while a rescan is listing the directory', async (t) => {
    // A listing taken before a file exists can finish after the file's watch event arrives.
    const readdir = fsp.readdir;
    t.mock.method(fsp, 'readdir', async (...args: Parameters<typeof fsp.readdir>) => {
      const entries = await readdir(...args);
      await sleep(80);
      return entries;
    });
    const { files } = collect({ concurrency: 4, rescanInterval: 30 });

    for (let index = 0; index < 20; index += 1) {
      write(dir, `race-${index}.txt`);
      await sleep(15);
    }
    await waitFor(() => new Set(files.map((file) => file.name)).size === 20);
    await sleep(500);

    assert.equal(files.length, 20);
  });

  test('handles every file of a burst from another process exactly once', async () => {
    const count = 2000;
    const { files, processed } = collect({ concurrency: 16, done: 'delete' });

    await writeFromAnotherProcess(dir, count, 4096);
    await waitFor(() => processed.length >= count, 30_000);
    await sleep(300);

    assert.equal(files.length, count);
    assert.equal(new Set(files.map((file) => file.name)).size, count);
    assert.ok(files.every((file) => file.content.length === 4096));
    assert.deepEqual(fs.readdirSync(dir), []);
  });

  test('close waits for running handlers and stops dispatching', async () => {
    let started = false;
    let finished = false;
    const { dispatcher, processed } = start(async () => {
      started = true;
      await sleep(200);
      finished = true;
    });

    write(dir, 'slow.txt');
    await waitFor(() => started);
    await dispatcher.close();
    assert.equal(finished, true);
    assert.equal(processed.length, 1);

    write(dir, 'after-close.txt');
    await sleep(300);
    assert.equal(processed.length, 1);
  });

  test('stops when the abort signal fires', async () => {
    const controller = new AbortController();
    const { processed } = collect({ signal: controller.signal });

    write(dir, 'before.txt');
    await waitFor(() => processed.length === 1);
    controller.abort();
    write(dir, 'after.txt');
    await sleep(300);

    assert.equal(processed.length, 1);
  });

  test('validates arguments and the directory', () => {
    const noop = () => {};
    assert.throws(() => dispatch('', noop), /directory must be a non-empty string/);
    assert.throws(() => dispatch(dir, 'nope' as unknown as FileHandler), /handler must be a function/);
    assert.throws(() => dispatch(dir, noop, { concurrency: 0 }), /concurrency must be a positive integer/);
    assert.throws(() => dispatch(dir, noop, { stabilityThreshold: -1 }), /stabilityThreshold must be a non-negative number/);
    assert.throws(() => dispatch(dir, noop, { done: 'archive' as 'keep' }), /done must be 'keep', 'delete', or \{ moveTo: string \}/);
    assert.throws(() => dispatch(dir, noop, { done: { moveTo: dir } }), /done.moveTo must differ from the watched directory/);
    assert.throws(() => dispatch(path.join(dir, 'missing'), noop), { code: 'ENOENT' });
  });

  test('can be imported from ES modules', async () => {
    const entry = pathToFileURL(path.join(__dirname, '..', 'src', 'index.js')).href;
    const module = (await import(entry)) as Record<string, unknown>;

    assert.equal(typeof module['dispatch'], 'function');
    assert.equal(typeof module['watch'], 'function');
  });
});
