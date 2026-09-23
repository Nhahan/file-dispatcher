import assert from 'node:assert/strict';
import { EventEmitter, getEventListeners } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';

import {
  ActionError,
  dispatch,
  type Dispatcher,
  type DispatchedFile,
  type DispatchOptions,
  type FileHandler,
} from '../src';
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
  const processed: { name: string; movedTo: string | undefined }[] = [];
  const failed: { error: Error; file: DispatchedFile; movedTo: string | undefined }[] = [];
  const errors: Error[] = [];
  dispatcher.on('processed', (file, movedTo) => processed.push({ name: file.name, movedTo }));
  dispatcher.on('failed', (error, file, movedTo) => failed.push({ error, file, movedTo }));
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
    const seen: unknown[] = [];
    const { processed } = start(async (file) => {
      let streamed = '';
      for await (const chunk of file.stream()) {
        streamed += chunk;
      }
      seen.push({
        name: file.name,
        size: file.size,
        path: file.path,
        text: await file.text(),
        latin1: await file.text('latin1'),
        bytes: await file.buffer(),
        streamed,
        recent: Math.abs(file.createdAt.getTime() - Date.now()) < 60_000,
      });
    });

    write(dir, 'a.txt', 'hello');
    await waitFor(() => processed.length === 1);

    assert.deepEqual(seen[0], {
      name: 'a.txt',
      size: 5,
      path: path.join(dir, 'a.txt'),
      text: 'hello',
      latin1: 'hello',
      bytes: Buffer.from('hello'),
      streamed: 'hello',
      recent: true,
    });
  });

  test('handles empty files and binary files intact', async () => {
    const seen = new Map<string, Buffer>();
    const { processed } = start(async (file) => {
      seen.set(file.name, await file.buffer());
    });

    const bytes = Buffer.from([0x41, 0x00, 0x42, 0xff]);
    write(dir, 'empty.bin', '');
    write(dir, 'data.bin', bytes);
    await waitFor(() => processed.length === 2);

    assert.deepEqual(seen.get('empty.bin'), Buffer.alloc(0));
    assert.deepEqual(seen.get('data.bin'), bytes);
  });

  test('ignores modifications, deletions, and directories', async () => {
    write(dir, 'existing.txt', 'old');
    write(dir, 'removed.txt', 'old');
    const { files, processed } = collect({ rescanInterval: 50 });

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

  test('lets existing override the default', async () => {
    write(dir, 'left-over.txt');
    const included = collect({ existing: true });
    await waitFor(() => included.processed.length === 1);
    await included.dispatcher.close();

    const excluded = collect({ done: 'delete', existing: false, rescanInterval: 50 });
    await sleep(300);
    assert.equal(excluded.processed.length, 0);
    assert.ok(fs.existsSync(path.join(dir, 'left-over.txt')));
  });

  test('moves files after success and after failure, and reports where', async () => {
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

    assert.deepEqual(processed[0], { name: 'good.txt', movedTo: path.join(done, 'good.txt') });
    assert.equal(failed[0]?.error.message, 'rejected');
    assert.equal(failed[0]?.movedTo, path.join(failedDir, 'bad.txt'));
    assert.deepEqual(fs.readdirSync(done), ['good.txt']);
    assert.deepEqual(fs.readdirSync(failedDir), ['bad.txt']);
    assert.deepEqual(fs.readdirSync(dir), []);
  });

  test('deletes failed files when asked', async () => {
    const { failed } = start(
      () => {
        throw new Error('rejected');
      },
      { failed: 'delete' },
    );

    write(dir, 'bad.txt');
    await waitFor(() => failed.length === 1);

    assert.deepEqual(fs.readdirSync(dir), []);
  });

  test('moves files without overwriting files already in the target', async () => {
    const done = path.join(outside, 'done');
    fs.mkdirSync(done);
    fs.writeFileSync(path.join(done, 'report.json'), 'oldest');
    fs.writeFileSync(path.join(done, 'report-1.json'), 'older');
    const { processed } = start(() => {}, { done: { moveTo: done } });

    write(dir, 'report.json', 'newer');
    await waitFor(() => processed.length === 1);

    assert.equal(processed[0]?.movedTo, path.join(done, 'report-2.json'));
    assert.equal(fs.readFileSync(path.join(done, 'report.json'), 'utf8'), 'oldest');
    assert.equal(fs.readFileSync(path.join(done, 'report-1.json'), 'utf8'), 'older');
    assert.equal(fs.readFileSync(path.join(done, 'report-2.json'), 'utf8'), 'newer');
  });

  test('treats a file the handler already removed as handled', async () => {
    const { processed, failed } = start((file) => fs.unlinkSync(file.path), { done: { moveTo: outside } });

    write(dir, 'self-removed.txt');
    await waitFor(() => processed.length === 1);

    assert.deepEqual(processed[0], { name: 'self-removed.txt', movedTo: undefined });
    assert.equal(failed.length, 0);
  });

  test('retries a failed action without running the handler again', async () => {
    const done = path.join(outside, 'done');
    let calls = 0;
    const { processed, failed } = start(
      () => {
        calls += 1;
        // Make the first move fail: the target directory path is a file for a moment.
        fs.rmSync(done, { recursive: true, force: true });
        fs.writeFileSync(done, 'blocker');
        setTimeout(() => fs.rmSync(done, { force: true }), 150);
      },
      { done: { moveTo: done } },
    );

    write(dir, 'a.txt');
    await waitFor(() => processed.length === 1);

    assert.equal(calls, 1);
    assert.equal(failed.length, 0);
    assert.deepEqual(fs.readdirSync(done), ['a.txt']);
  });

  test('gives up on an action that keeps failing and moves on', async () => {
    const failedDir = path.join(outside, 'failed');
    const { processed, failed } = start(
      (file) => {
        if (file.name === 'bad.txt') {
          throw new Error('rejected');
        }
      },
      { failed: { moveTo: failedDir } },
    );
    fs.rmSync(failedDir, { recursive: true, force: true });
    fs.writeFileSync(failedDir, 'blocker');

    write(dir, 'bad.txt');
    await sleep(30);
    write(dir, 'good.txt');
    await waitFor(() => processed.length === 1, 15_000);

    assert.equal(failed.length, 1);
    const error = failed[0]?.error;
    assert.ok(error instanceof ActionError);
    assert.equal(error.action, 'failed');
    assert.equal(error.handlerError?.message, 'rejected');
    assert.ok(error.cause instanceof Error);
    assert.ok(fs.existsSync(path.join(dir, 'bad.txt')));
  });

  test('leaves a file that replaced the handled one alone and handles it next', async () => {
    let release: () => void = () => {};
    const contents: string[] = [];
    const { processed } = start(
      async (file) => {
        const content = await file.text();
        contents.push(content);
        if (content === 'v1') {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
      },
      { done: 'delete', filter: /\.json$/ },
    );

    write(dir, 'job.json', 'v1');
    await waitFor(() => contents.length === 1);
    write(dir, 'job.tmp', 'v2');
    fs.renameSync(path.join(dir, 'job.tmp'), path.join(dir, 'job.json'));
    release();
    await waitFor(() => processed.length === 2);

    assert.deepEqual(contents, ['v1', 'v2']);
    assert.deepEqual(fs.readdirSync(dir), []);
  });

  test('moves concurrently into one directory without overwriting', async () => {
    const second = tempDir();
    const target = path.join(outside, 'shared');
    try {
      const a = start(() => {}, { concurrency: 4, done: { moveTo: target } });
      const b = dispatch(second, () => {}, { concurrency: 4, done: { moveTo: target } });
      dispatchers.push(b);
      let processedB = 0;
      b.on('processed', () => {
        processedB += 1;
      });

      for (let index = 0; index < 50; index += 1) {
        write(dir, `f${index}.txt`, `a${index}`);
        fs.writeFileSync(path.join(second, `f${index}.txt`), `b${index}`);
      }
      await waitFor(() => a.processed.length === 50 && processedB === 50, 20_000);

      const contents = fs.readdirSync(target).map((name) => fs.readFileSync(path.join(target, name), 'utf8'));
      assert.equal(contents.length, 100);
      assert.equal(new Set(contents).size, 100);
    } finally {
      fs.rmSync(second, { recursive: true, force: true });
    }
  });

  test('copies across file systems without overwriting', async (t) => {
    t.mock.method(fs, 'link', (_existing: fs.PathLike, _target: fs.PathLike, callback: fs.NoParamCallback) =>
      process.nextTick(callback, Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' })),
    );
    const done = path.join(outside, 'done');
    fs.mkdirSync(done);
    fs.writeFileSync(path.join(done, 'a.txt'), 'older');
    const { processed } = start(() => {}, { done: { moveTo: done } });

    write(dir, 'a.txt', 'newer');
    await waitFor(() => processed.length === 1);

    assert.equal(processed[0]?.movedTo, path.join(done, 'a-1.txt'));
    assert.equal(fs.readFileSync(path.join(done, 'a.txt'), 'utf8'), 'older');
    assert.equal(fs.readFileSync(path.join(done, 'a-1.txt'), 'utf8'), 'newer');
    assert.equal(fs.existsSync(path.join(dir, 'a.txt')), false);
  });

  test('rejects a moveTo that is the watched directory under another path', () => {
    const noop = () => {};
    assert.throws(() => dispatch(dir, noop, { done: { moveTo: dir } }), /done.moveTo must differ from the watched directory/);

    if (process.platform !== 'win32') {
      const link = path.join(outside, 'link');
      fs.symlinkSync(dir, link);
      assert.throws(() => dispatch(dir, noop, { done: { moveTo: link } }), /done.moveTo must differ/);
    }

    const upper = dir.toUpperCase();
    if (upper !== dir && fs.existsSync(upper)) {
      // Case-insensitive file system.
      assert.throws(() => dispatch(dir, noop, { failed: { moveTo: upper } }), /failed.moveTo must differ/);
    }
  });

  test('handles a file again when it is removed and created again', async () => {
    const { files, processed } = collect({ done: 'delete', rescanInterval: 50 });

    write(dir, 'again.txt', 'first');
    await waitFor(() => processed.length === 1);
    write(dir, 'again.txt', 'second');
    await waitFor(() => processed.length === 2);

    assert.deepEqual(files.map((file) => file.content), ['first', 'second']);
  });

  test('handles a file that replaces a handled one under the same name', async () => {
    const { files, processed } = collect();

    write(dir, 'a.txt', 'v1');
    await waitFor(() => processed.length === 1);
    // Atomic replacement: write a temporary file, then rename it over the original.
    write(dir, 'a.txt.tmp', 'v2');
    fs.renameSync(path.join(dir, 'a.txt.tmp'), path.join(dir, 'a.txt'));
    await waitFor(() => files.some((file) => file.content === 'v2'));
    // Delete and create again under the same name.
    fs.unlinkSync(path.join(dir, 'a.txt'));
    write(dir, 'a.txt', 'v3');
    await waitFor(() => files.some((file) => file.content === 'v3'));

    assert.deepEqual(
      files.filter((file) => file.name === 'a.txt').map((file) => file.content),
      ['v1', 'v2', 'v3'],
    );
  });

  test('handles a hard link as its own entry, including link-then-unlink writes', async () => {
    const { files, processed } = collect({ filter: /\.json$/ });

    write(dir, 'one.json');
    await waitFor(() => processed.length === 1);
    fs.linkSync(path.join(dir, 'one.json'), path.join(dir, 'two.json'));
    await waitFor(() => processed.length === 2);

    // "Rename without replace": write a temporary name, link the final name, remove the temporary one.
    write(dir, 'three-tmp.json', 'three');
    fs.linkSync(path.join(dir, 'three-tmp.json'), path.join(dir, 'three.json'));
    fs.unlinkSync(path.join(dir, 'three-tmp.json'));
    await waitFor(() => files.some((file) => file.name === 'three.json'));
    await sleep(300);

    assert.deepEqual(files.filter((file) => file.name !== 'three-tmp.json').map((file) => file.name), [
      'one.json',
      'two.json',
      'three.json',
    ]);
  });

  test('does not handle another spelling of a handled file as a new file', async (t) => {
    if (!fs.existsSync(path.join(dir, '..', path.basename(dir).toUpperCase()))) {
      t.skip('case-sensitive file system');
      return;
    }
    let emit: fs.WatchListener<string> = () => {};
    const watchFn = fs.watch;
    t.mock.method(fs, 'watch', (target: fs.PathLike, options: fs.WatchOptions, listener: fs.WatchListener<string>) => {
      emit = listener;
      return watchFn(target, options, listener);
    });
    const { processed } = collect({ rescanInterval: 50 });

    write(dir, 'a.txt');
    await waitFor(() => processed.length === 1);
    emit('rename', 'A.TXT');
    await sleep(400);

    assert.equal(processed.length, 1);
  });

  test('finds a handled file replaced under its name even when every watch event is lost', async (t) => {
    t.mock.method(fs, 'watch', () => Object.assign(new EventEmitter(), { close: () => {} }));
    const { files, processed } = collect({ filter: /\.txt$/, rescanInterval: 50 });

    write(dir, 'a.txt', 'v1');
    await waitFor(() => processed.length === 1);
    write(dir, 'a.tmp', 'v2');
    fs.renameSync(path.join(dir, 'a.tmp'), path.join(dir, 'a.txt'));
    await waitFor(() => processed.length === 2);

    assert.deepEqual(files.map((file) => file.content), ['v1', 'v2']);
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
    emit('rename', 'ghost.txt');
    await waitFor(() => processed.length === 1);

    assert.deepEqual(files.map((file) => file.name), ['ghost.txt']);
  });

  test('handles a file recreated under the same name where the file system records no birth time', async (t) => {
    const stat = fs.stat;
    // Simulates a file system without birth times (ext3, NFS, ...).
    t.mock.method(fs, 'stat', (file: fs.PathLike, options: any, callback: (...args: any[]) => void) =>
      stat(file, options, (error: NodeJS.ErrnoException | null, stats: any) => {
        if (stats && typeof stats.birthtimeNs === 'bigint') {
          stats.birthtimeNs = 0n;
        }
        callback(error, stats);
      }),
    );
    // Without a birth time an inode reused for the new file looks unchanged; only the 'rename' event tells.
    let emit: fs.WatchListener<string> = () => {};
    t.mock.method(fs, 'watch', (_target: fs.PathLike, _options: fs.WatchOptions, listener: fs.WatchListener<string>) => {
      emit = listener;
      return Object.assign(new EventEmitter(), { close: () => {} });
    });
    const { files, processed } = collect({ rescanInterval: 50 });

    write(dir, 'a.txt', 'v1');
    emit('rename', 'a.txt');
    await waitFor(() => processed.length === 1);
    fs.unlinkSync(path.join(dir, 'a.txt'));
    write(dir, 'a.txt', 'v2');
    emit('rename', 'a.txt');
    await waitFor(() => processed.length === 2);

    assert.deepEqual(files.map((file) => file.content), ['v1', 'v2']);
  });

  test('handles a file created under a name that was a directory', async () => {
    fs.mkdirSync(path.join(dir, 'job'));
    const { files, processed } = collect({ rescanInterval: 50 });

    await sleep(200);
    fs.rmdirSync(path.join(dir, 'job'));
    write(dir, 'job', 'content');
    await waitFor(() => processed.length === 1);

    assert.deepEqual(files, [{ name: 'job', content: 'content' }]);
  });

  test('keeps dispatching after the watcher fails', async (t) => {
    const watchers: EventEmitter[] = [];
    t.mock.method(fs, 'watch', () => {
      const watcher = Object.assign(new EventEmitter(), { close: () => {} });
      watchers.push(watcher);
      return watcher;
    });
    const { processed, errors } = collect({ rescanInterval: 50 });

    watchers[0]?.emit('error', new Error('watcher failed'));
    write(dir, 'after.txt');
    await waitFor(() => processed.length === 1);

    assert.equal(errors[0]?.message, 'watcher failed');
    await waitFor(() => watchers.length >= 2);
  });

  test('watches a directory again after it is deleted and created again', async (t) => {
    if (process.platform !== 'linux') {
      t.skip('the watched directory cannot be replaced while watched on this platform');
      return;
    }
    const { processed } = collect({ rescanInterval: 60_000 });

    fs.rmSync(dir, { recursive: true });
    fs.mkdirSync(dir);
    // The rescan triggered by the deletion notices the new directory and watches it again.
    await sleep(1000);
    write(dir, 'after.txt');
    await waitFor(() => processed.length === 1, 3000);
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

  test('handles files right away with a stabilityThreshold of 0', async () => {
    const { processed } = collect({ stabilityThreshold: 0 });

    write(dir, 'now.txt');
    await waitFor(() => processed.length === 1);
  });

  test('keeps waiting on monotonic time when the wall clock steps back', async (t) => {
    const now = Date.now();
    t.mock.method(Date, 'now', () => now - 3_600_000);
    const { processed } = collect();

    write(dir, 'clock.txt');
    await waitFor(() => processed.length === 1);
  });

  test('handles one file at a time, oldest first, by default', async () => {
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

  test('does not let a file that is still being written block newer files', async () => {
    const { files, processed } = collect();

    const fd = fs.openSync(path.join(dir, 'growing.log'), 'w');
    const appender = setInterval(() => fs.writeSync(fd, 'line\n'), 10);
    try {
      await sleep(50);
      write(dir, 'job.json');
      await waitFor(() => processed.length === 1);
      assert.deepEqual(files.map((file) => file.name), ['job.json']);
    } finally {
      clearInterval(appender);
      fs.closeSync(fd);
    }
    await waitFor(() => processed.length === 2);
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

  test('recovers when a directory scan fails', async (t) => {
    const readdir = fsp.readdir;
    let failures = 1;
    t.mock.method(fsp, 'readdir', async (...args: Parameters<typeof fsp.readdir>) => {
      if (failures > 0) {
        failures -= 1;
        throw Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' });
      }
      return readdir(...args);
    });
    // Synthetic events keep the timing deterministic; periodic rescans are off, so only the retry helps.
    let emit: fs.WatchListener<string> = () => {};
    t.mock.method(fs, 'watch', (_target: fs.PathLike, _options: fs.WatchOptions, listener: fs.WatchListener<string>) => {
      emit = listener;
      return Object.assign(new EventEmitter(), { close: () => {} });
    });
    const { processed, errors } = collect({ rescanInterval: 0 });

    write(dir, 'a.json');
    emit('rename', 'a.json');
    await waitFor(() => processed.length === 1);

    assert.equal(errors.length, 1);
    assert.match(errors[0]?.message ?? '', /EMFILE/);
  });

  test('does not rescan the directory for events on files it already handled', async (t) => {
    const readdir = t.mock.method(fsp, 'readdir');
    let emit: fs.WatchListener<string> = () => {};
    t.mock.method(fs, 'watch', (_target: fs.PathLike, _options: fs.WatchOptions, listener: fs.WatchListener<string>) => {
      emit = listener;
      return Object.assign(new EventEmitter(), { close: () => {} });
    });
    const { processed } = collect({ rescanInterval: 0 });

    write(dir, 'app.log', 'start\n');
    emit('rename', 'app.log');
    await waitFor(() => processed.length === 1);
    await sleep(300);
    const scans = readdir.mock.callCount();
    for (let index = 0; index < 20; index += 1) {
      fs.appendFileSync(path.join(dir, 'app.log'), `line ${index}\n`);
      emit('change', 'app.log');
      await sleep(10);
    }
    await sleep(300);

    assert.equal(readdir.mock.callCount(), scans);
    assert.equal(processed.length, 1);
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

  test('close waits for running handlers, aborts their signal, and stops dispatching', async () => {
    let started = false;
    let finished = false;
    let aborted = false;
    const { dispatcher, processed } = start(
      async (_file, { signal }) => {
        started = true;
        await sleep(200);
        aborted = signal.aborted;
        finished = true;
      },
      { rescanInterval: 50 },
    );

    write(dir, 'slow.txt');
    await waitFor(() => started);
    await dispatcher.close();
    assert.equal(finished, true);
    assert.equal(aborted, true);
    assert.equal(processed.length, 1);

    write(dir, 'after-close.txt');
    await sleep(300);
    assert.equal(processed.length, 1);
  });

  test('close called from a handler does not wait for that handler', async () => {
    let dispatcher: Dispatcher | undefined;
    let returned = false;
    const started = start(async (file) => {
      await file.text();
      await dispatcher?.close();
      returned = true;
    });
    dispatcher = started.dispatcher;

    write(dir, 'a.txt');
    await waitFor(() => returned, 3000);
  });

  test('close called from several handlers at once does not deadlock', async () => {
    let dispatcher: Dispatcher | undefined;
    let returned = 0;
    const started = start(
      async () => {
        await sleep(50);
        await dispatcher?.close();
        returned += 1;
      },
      { concurrency: 2 },
    );
    dispatcher = started.dispatcher;

    write(dir, 'a.txt');
    write(dir, 'b.txt');
    await waitFor(() => returned === 2, 3000);
  });

  test('stops when the abort signal fires and removes its listener', async () => {
    const controller = new AbortController();
    const { dispatcher, processed } = collect({ signal: controller.signal, rescanInterval: 50 });

    write(dir, 'before.txt');
    await waitFor(() => processed.length === 1);
    controller.abort();
    write(dir, 'after.txt');
    await sleep(300);
    assert.equal(processed.length, 1);

    const reused = new AbortController();
    const other = dispatch(dir, () => {}, { signal: reused.signal });
    await other.close();
    await dispatcher.close();
    assert.equal(getEventListeners(reused.signal, 'abort').length, 0);
  });

  test('never starts with an already aborted signal', async () => {
    write(dir, 'left-over.txt');
    const { processed } = collect({ signal: AbortSignal.abort(), done: 'delete', rescanInterval: 50 });

    await sleep(300);
    assert.equal(processed.length, 0);
  });

  test('validates arguments and the directory without side effects', () => {
    const noop = () => {};
    assert.throws(() => dispatch('', noop), /directory must be a non-empty string/);
    assert.throws(() => dispatch(dir, 'nope' as unknown as FileHandler), /handler must be a function/);
    assert.throws(() => dispatch(dir, noop, { concurrency: 0 }), /concurrency must be a positive integer/);
    assert.throws(() => dispatch(dir, noop, { stabilityThreshold: -1 }), /stabilityThreshold must be a non-negative number/);
    assert.throws(() => dispatch(dir, noop, { done: 'archive' as 'keep' }), /done must be 'keep', 'delete', or \{ moveTo: string \}/);

    const target = path.join(outside, 'never-created');
    assert.throws(() => dispatch(path.join(dir, 'missing'), noop, { done: { moveTo: target } }), { code: 'ENOENT' });
    assert.equal(fs.existsSync(target), false);
  });

  test('can be imported from ES modules', async () => {
    const entry = pathToFileURL(path.join(__dirname, '..', 'src', 'index.js')).href;
    const module = (await import(entry)) as Record<string, unknown>;

    assert.equal(typeof module['dispatch'], 'function');
    assert.equal(typeof module['watch'], 'function');
    assert.equal(typeof module['ActionError'], 'function');
  });
});
