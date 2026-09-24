import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { dispatch, type Dispatcher, type DispatchedFile, type DispatchOptions, type FileHandler } from '../src';
import { timing } from '../src/watcher';
import { sleep, tempDir, waitFor, write, writeFromAnotherProcess } from './helpers';

const RESCAN_INTERVAL = timing.rescanInterval;

let dir: string;
let outside: string;
const dispatchers: Dispatcher[] = [];

beforeEach(() => {
  dir = tempDir();
  outside = tempDir();
});

afterEach(async () => {
  await Promise.all(dispatchers.splice(0).map((dispatcher) => dispatcher.close()));
  timing.rescanInterval = RESCAN_INTERVAL;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

/** Starts a dispatcher on `dir` that records the files whose handler returned, and every error. */
function start(handler: FileHandler, options?: DispatchOptions) {
  const handled: string[] = [];
  const errors: { error: Error; file: DispatchedFile | undefined }[] = [];
  const dispatcher = dispatch(
    dir,
    async (file) => {
      await handler(file);
      handled.push(file.name);
    },
    options,
  );
  dispatcher.on('error', (error, file) => errors.push({ error, file }));
  dispatchers.push(dispatcher);
  return { dispatcher, handled, errors };
}

/** Starts a dispatcher on `dir` that records each file's name and content. */
function collect(options?: DispatchOptions) {
  const files: { name: string; content: string }[] = [];
  const started = start((file) => {
    files.push({ name: file.name, content: fs.readFileSync(file.path, 'utf8') });
  }, options);
  return { ...started, files };
}

function listing(directory: string): string[] {
  return fs.readdirSync(directory).sort();
}

describe('dispatch', () => {
  test('hands each new file to the handler once it is written', async () => {
    const seen: DispatchedFile[] = [];
    const { handled } = start((file) => {
      seen.push(file);
    });

    write(dir, 'a.txt', 'hello');
    await waitFor(() => handled.length === 1);

    const file = seen[0];
    assert.ok(file);
    assert.equal(file.name, 'a.txt');
    assert.equal(file.path, path.join(dir, 'a.txt'));
    assert.equal(file.size, 5);
    assert.equal(typeof file.id, 'string');
    assert.ok(Math.abs(file.createdAt.getTime() - Date.now()) < 60_000);
  });

  test('handles empty files and binary files intact', async () => {
    const seen = new Map<string, Buffer>();
    const { handled } = start((file) => {
      seen.set(file.name, fs.readFileSync(file.path));
    });

    const bytes = Buffer.from([0x41, 0x00, 0x42, 0xff]);
    write(dir, 'empty.bin', '');
    write(dir, 'data.bin', bytes);
    await waitFor(() => handled.length === 2);

    assert.deepEqual(seen.get('empty.bin'), Buffer.alloc(0));
    assert.deepEqual(seen.get('data.bin'), bytes);
  });

  test('ignores modifications, deletions, and directories', async () => {
    timing.rescanInterval = 50;
    write(dir, 'existing.txt', 'old');
    write(dir, 'removed.txt', 'old');
    const { files, handled } = collect();

    fs.appendFileSync(path.join(dir, 'existing.txt'), ' modified');
    fs.unlinkSync(path.join(dir, 'removed.txt'));
    fs.mkdirSync(path.join(dir, 'subdirectory'));
    write(dir, 'marker.txt');
    await waitFor(() => handled.length >= 1);
    await sleep(300);

    assert.deepEqual(files.map((file) => file.name), ['marker.txt']);
  });

  test('handles files left from an earlier run only when done removes handled files', async () => {
    write(dir, 'left-over.txt');
    const kept = collect();
    write(dir, 'new.txt');
    await waitFor(() => kept.handled.length === 1);
    await kept.dispatcher.close();
    assert.deepEqual(kept.files.map((file) => file.name), ['new.txt']);

    const removed = collect({ done: 'delete' });
    await waitFor(() => listing(dir).length === 0);
    assert.deepEqual(removed.files.map((file) => file.name).sort(), ['left-over.txt', 'new.txt']);
  });

  test('moves handled files, and reports a failed handler and leaves its file in place', async () => {
    const done = path.join(outside, 'done');
    const { errors } = start(
      (file) => {
        if (file.name.startsWith('bad')) {
          throw new Error('rejected');
        }
      },
      { done: { moveTo: done } },
    );

    write(dir, 'good.txt');
    write(dir, 'bad.txt');
    await waitFor(() => errors.length === 1 && listing(dir).length === 1);

    assert.equal(errors[0]?.error.message, 'rejected');
    assert.equal(errors[0]?.file?.name, 'bad.txt');
    assert.deepEqual(listing(done), ['good.txt']);
    assert.deepEqual(listing(dir), ['bad.txt']);
  });

  test('moves files without overwriting files already in the target', async () => {
    const done = path.join(outside, 'done');
    fs.mkdirSync(done);
    fs.writeFileSync(path.join(done, 'report.json'), 'oldest');
    fs.writeFileSync(path.join(done, 'report-1.json'), 'older');
    start(() => {}, { done: { moveTo: done } });

    write(dir, 'report.json', 'newer');
    await waitFor(() => listing(dir).length === 0);

    assert.equal(fs.readFileSync(path.join(done, 'report.json'), 'utf8'), 'oldest');
    assert.equal(fs.readFileSync(path.join(done, 'report-1.json'), 'utf8'), 'older');
    assert.equal(fs.readFileSync(path.join(done, 'report-2.json'), 'utf8'), 'newer');
  });

  test('treats a file the handler already removed as handled', async () => {
    const { handled, errors } = start((file) => fs.unlinkSync(file.path), { done: { moveTo: outside } });

    write(dir, 'self-removed.txt');
    await waitFor(() => handled.length === 1);
    await sleep(100);

    assert.deepEqual(errors, []);
    assert.deepEqual(listing(outside), []);
  });

  test('retries a failed action without running the handler again', async () => {
    const done = path.join(outside, 'done');
    let calls = 0;
    const { errors } = start(
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
    await waitFor(() => listing(dir).length === 0);

    assert.equal(calls, 1);
    assert.deepEqual(errors, []);
    assert.deepEqual(listing(done), ['a.txt']);
  });

  test('gives up on an action that keeps failing and moves on', async () => {
    const done = path.join(outside, 'done');
    const { handled, errors } = start(() => {}, { done: { moveTo: done } });
    fs.rmSync(done, { recursive: true, force: true });
    fs.writeFileSync(done, 'blocker');

    write(dir, 'a.txt');
    await waitFor(() => errors.length === 1, 15_000);
    assert.equal(errors[0]?.file?.name, 'a.txt');
    assert.ok(fs.existsSync(path.join(dir, 'a.txt')));

    fs.rmSync(done);
    write(dir, 'b.txt');
    await waitFor(() => !fs.existsSync(path.join(dir, 'b.txt')));
    assert.deepEqual(handled, ['a.txt', 'b.txt']);
  });

  test('leaves a file that replaced the handled one alone and handles it next', async () => {
    let release: () => void = () => {};
    const contents: string[] = [];
    start(
      async (file) => {
        const content = fs.readFileSync(file.path, 'utf8');
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
    await waitFor(() => contents.length === 2 && listing(dir).length === 0);

    assert.deepEqual(contents, ['v1', 'v2']);
  });

  test('moves concurrently into one directory without overwriting', async () => {
    const second = tempDir();
    const target = path.join(outside, 'shared');
    const other = dispatch(second, () => {}, { concurrency: 4, done: { moveTo: target } });
    try {
      start(() => {}, { concurrency: 4, done: { moveTo: target } });

      for (let index = 0; index < 50; index += 1) {
        write(dir, `f${index}.txt`, `a${index}`);
        write(second, `f${index}.txt`, `b${index}`);
      }
      await waitFor(() => listing(dir).length === 0 && listing(second).length === 0, 20_000);

      const contents = listing(target).map((name) => fs.readFileSync(path.join(target, name), 'utf8'));
      assert.equal(contents.length, 100);
      assert.equal(new Set(contents).size, 100);
    } finally {
      await other.close();
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
    start(() => {}, { done: { moveTo: done } });

    write(dir, 'a.txt', 'newer');
    await waitFor(() => !fs.existsSync(path.join(dir, 'a.txt')));

    assert.equal(fs.readFileSync(path.join(done, 'a.txt'), 'utf8'), 'older');
    assert.equal(fs.readFileSync(path.join(done, 'a-1.txt'), 'utf8'), 'newer');
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
      assert.throws(() => dispatch(dir, noop, { done: { moveTo: upper } }), /done.moveTo must differ/);
    }
  });

  test('handles a file again when it is removed and created again', async () => {
    timing.rescanInterval = 50;
    const { files } = collect({ done: 'delete' });

    write(dir, 'again.txt', 'first');
    await waitFor(() => files.length === 1 && listing(dir).length === 0);
    write(dir, 'again.txt', 'second');
    await waitFor(() => files.length === 2);

    assert.deepEqual(files.map((file) => file.content), ['first', 'second']);
  });

  test('handles a file that replaces a handled one under the same name', async () => {
    const { files, handled } = collect();

    write(dir, 'a.txt', 'v1');
    await waitFor(() => handled.length === 1);
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

  test('handles a file written under a temporary name and linked into place', async () => {
    const { files } = collect({ filter: /\.json$/ });

    // "Rename without replace": write a temporary name, link the final name, remove the temporary one.
    write(dir, 'three-tmp.json', 'three');
    fs.linkSync(path.join(dir, 'three-tmp.json'), path.join(dir, 'three.json'));
    fs.unlinkSync(path.join(dir, 'three-tmp.json'));
    await waitFor(() => files.length === 1);
    await sleep(300);

    assert.equal(files.length, 1);
    assert.equal(files[0]?.content, 'three');
  });

  test('does not handle a file again when it is renamed or linked under another name', async () => {
    timing.rescanInterval = 50;
    write(dir, 'before.json');
    const { files, handled } = collect({ filter: /\.json$/ });

    write(dir, 'a.json');
    await waitFor(() => handled.length >= 1);
    fs.renameSync(path.join(dir, 'a.json'), path.join(dir, 'b.json'));
    fs.linkSync(path.join(dir, 'b.json'), path.join(dir, 'c.json'));
    // A file that was already there is not new under another name either.
    fs.renameSync(path.join(dir, 'before.json'), path.join(dir, 'after.json'));
    await sleep(500);

    assert.deepEqual(files.map((file) => file.name), ['a.json']);
  });

  test('gives each file an id that stays the same across restarts', async () => {
    const first: string[] = [];
    // A failed handler leaves its file in place for the next run.
    const failing = start(
      (file) => {
        first.push(`${file.name}:${file.id}`);
        throw new Error('not yet');
      },
      { done: 'delete' },
    );
    write(dir, 'a.txt');
    write(dir, 'b.txt');
    await waitFor(() => failing.errors.length === 2);
    await failing.dispatcher.close();

    const again: string[] = [];
    start((file) => again.push(`${file.name}:${file.id}`), { done: 'delete' });
    await waitFor(() => again.length === 2);

    assert.notEqual(first[0]?.split(':')[1], first[1]?.split(':')[1]);
    assert.deepEqual(again.sort(), first.sort());
  });

  test('handles a file created again under a handled name even if it reuses the inode and birth time', async (t) => {
    // Simulates a file system that hands the freed inode to the new file within one timestamp tick.
    const stat = fs.stat;
    t.mock.method(fs, 'stat', (file: fs.PathLike, options: any, callback: (...args: any[]) => void) =>
      stat(file, options, (error: NodeJS.ErrnoException | null, stats: any) => {
        // Every file in the directory, under any name, reports the same inode and birth time.
        if (stats && typeof stats.ino === 'bigint' && String(file).startsWith(dir + path.sep)) {
          stats.ino = 42n;
          stats.birthtimeNs = 1_000_000_000n;
        }
        callback(error, stats);
      }),
    );
    const { files } = collect({ done: 'delete', filter: /\.json$/ });

    write(dir, 'job.json', 'v1');
    await waitFor(() => files.length === 1 && listing(dir).length === 0);
    write(dir, 'job.json', 'v2');
    await waitFor(() => files.length === 2);

    assert.deepEqual(files.map((file) => file.content), ['v1', 'v2']);
  });

  test('never deletes a file that took the name just before the delete', async (t) => {
    const target = path.join(dir, 'job.json');
    let injected = false;
    // Replaces the handled file at the last moment before the dispatcher touches its name.
    const inject = (file: fs.PathLike) => {
      if (!injected && String(file) === target) {
        injected = true;
        fs.writeFileSync(path.join(dir, 'job.tmp'), 'v2');
        fs.renameSync(path.join(dir, 'job.tmp'), target);
      }
    };
    const rename = fs.rename;
    const unlink = fs.unlink;
    t.mock.method(fs, 'rename', (source: fs.PathLike, destination: fs.PathLike, callback: fs.NoParamCallback) => {
      inject(source);
      rename(source, destination, callback);
    });
    t.mock.method(fs, 'unlink', (file: fs.PathLike, callback: fs.NoParamCallback) => {
      inject(file);
      unlink(file, callback);
    });
    const { files } = collect({ done: 'delete', filter: /\.json$/ });

    write(dir, 'job.json', 'v1');
    await waitFor(() => files.length === 2 && listing(dir).length === 0);

    assert.deepEqual(files.map((file) => file.content), ['v1', 'v2']);
  });

  test('ignores its own temporary names', async () => {
    timing.rescanInterval = 50;
    const { handled } = collect();

    write(dir, '.file-dispatcher-parked');
    write(dir, 'marker.txt');
    await waitFor(() => handled.length >= 1);
    await sleep(300);

    assert.deepEqual(handled, ['marker.txt']);
  });

  test('does not handle another spelling of a handled file as a new file', async (t) => {
    if (!fs.existsSync(path.join(dir, '..', path.basename(dir).toUpperCase()))) {
      t.skip('case-sensitive file system');
      return;
    }
    timing.rescanInterval = 50;
    let emit: fs.WatchListener<string> = () => {};
    const watchFn = fs.watch;
    t.mock.method(fs, 'watch', (target: fs.PathLike, options: fs.WatchOptions, listener: fs.WatchListener<string>) => {
      emit = listener;
      return watchFn(target, options, listener);
    });
    const { handled } = collect();

    write(dir, 'a.txt');
    await waitFor(() => handled.length === 1);
    emit('rename', 'A.TXT');
    await sleep(400);

    assert.equal(handled.length, 1);
  });

  test('does not handle a modified file again when macOS reports the change as a rename', async (t) => {
    if (process.platform !== 'darwin') {
      t.skip('only macOS reports modifications as renames');
      return;
    }
    timing.rescanInterval = 0;
    let emit: fs.WatchListener<string> = () => {};
    t.mock.method(fs, 'watch', (_target: fs.PathLike, _options: fs.WatchOptions, listener: fs.WatchListener<string>) => {
      emit = listener;
      return Object.assign(new EventEmitter(), { close: () => {} });
    });
    write(dir, 'existing.txt', 'old');
    const { handled } = collect();

    await sleep(100);
    fs.appendFileSync(path.join(dir, 'existing.txt'), ' modified');
    emit('rename', 'existing.txt');
    write(dir, 'marker.txt');
    emit('rename', 'marker.txt');
    await waitFor(() => handled.length >= 1);
    await sleep(300);

    assert.deepEqual(handled, ['marker.txt']);
  });

  test('finds a handled file replaced under its name even when every watch event is lost', async (t) => {
    timing.rescanInterval = 50;
    t.mock.method(fs, 'watch', () => Object.assign(new EventEmitter(), { close: () => {} }));
    const { files, handled } = collect({ filter: /\.txt$/ });

    write(dir, 'a.txt', 'v1');
    await waitFor(() => handled.length === 1);
    write(dir, 'a.tmp', 'v2');
    fs.renameSync(path.join(dir, 'a.tmp'), path.join(dir, 'a.txt'));
    await waitFor(() => handled.length === 2);

    assert.deepEqual(files.map((file) => file.content), ['v1', 'v2']);
  });

  test('handles a file created under a name whose earlier event was for a removal', async (t) => {
    timing.rescanInterval = 0;
    // Delivers only synthetic events, like a late event for a file that was just deleted.
    let emit: fs.WatchListener<string> = () => {};
    t.mock.method(fs, 'watch', (_target: fs.PathLike, _options: fs.WatchOptions, listener: fs.WatchListener<string>) => {
      emit = listener;
      return Object.assign(new EventEmitter(), { close: () => {} });
    });
    const { handled } = collect();

    emit('rename', 'ghost.txt');
    await sleep(30);
    write(dir, 'ghost.txt');
    emit('rename', 'ghost.txt');
    await waitFor(() => handled.length === 1);

    assert.deepEqual(handled, ['ghost.txt']);
  });

  test('handles a file recreated under the same name where the file system records no birth time', async (t) => {
    timing.rescanInterval = 50;
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
    const { files, handled } = collect();

    write(dir, 'a.txt', 'v1');
    emit('rename', 'a.txt');
    await waitFor(() => handled.length === 1);
    fs.unlinkSync(path.join(dir, 'a.txt'));
    write(dir, 'a.txt', 'v2');
    emit('rename', 'a.txt');
    await waitFor(() => handled.length === 2);

    assert.deepEqual(files.map((file) => file.content), ['v1', 'v2']);
  });

  test('handles a file created under a name that was a directory', async () => {
    timing.rescanInterval = 50;
    fs.mkdirSync(path.join(dir, 'job'));
    const { files, handled } = collect();

    await sleep(200);
    fs.rmdirSync(path.join(dir, 'job'));
    write(dir, 'job', 'content');
    await waitFor(() => handled.length === 1);

    assert.deepEqual(files, [{ name: 'job', content: 'content' }]);
  });

  test('keeps dispatching after the watcher fails', async (t) => {
    timing.rescanInterval = 50;
    const watchers: EventEmitter[] = [];
    t.mock.method(fs, 'watch', () => {
      const watcher = Object.assign(new EventEmitter(), { close: () => {} });
      watchers.push(watcher);
      return watcher;
    });
    const { handled, errors } = collect();

    watchers[0]?.emit('error', new Error('watcher failed'));
    write(dir, 'after.txt');
    await waitFor(() => handled.length === 1);

    assert.equal(errors[0]?.error.message, 'watcher failed');
    assert.equal(errors[0]?.file, undefined);
    await waitFor(() => watchers.length >= 2);
  });

  test('watches a directory again after it is deleted and created again', async (t) => {
    if (process.platform !== 'linux') {
      t.skip('the watched directory cannot be replaced while watched on this platform');
      return;
    }
    timing.rescanInterval = 60_000;
    const { handled } = collect();

    fs.rmSync(dir, { recursive: true });
    fs.mkdirSync(dir);
    // The rescan triggered by the deletion notices the new directory and watches it again, long
    // before the next periodic rescan a minute later.
    await sleep(1000);
    write(dir, 'after.txt');
    await waitFor(() => handled.length === 1);
  });

  test('filters names with a pattern or a predicate', async () => {
    const byPattern = collect({ filter: /\.log$/g });
    const byPredicate = collect({ filter: (name) => name.startsWith('two') });

    write(dir, 'skip.txt');
    write(dir, 'one.log');
    write(dir, 'two.log');
    await waitFor(() => byPattern.handled.length === 2 && byPredicate.handled.length === 1);
    await sleep(200);

    assert.deepEqual(byPattern.handled.sort(), ['one.log', 'two.log']);
    assert.deepEqual(byPredicate.handled, ['two.log']);
  });

  test('waits until a file stops changing before handling it', async () => {
    const { files, handled } = collect({ stabilityThreshold: 300 });

    const fd = fs.openSync(path.join(dir, 'slow.txt'), 'w');
    for (const chunk of ['one ', 'two ', 'three']) {
      fs.writeSync(fd, chunk);
      await sleep(100);
    }
    fs.closeSync(fd);
    await waitFor(() => handled.length === 1);

    assert.equal(files[0]?.content, 'one two three');
  });

  test('handles files right away with a stabilityThreshold of 0', async () => {
    const { handled } = collect({ stabilityThreshold: 0 });

    write(dir, 'now.txt');
    await waitFor(() => handled.length === 1);
  });

  test('keeps waiting on monotonic time when the wall clock steps back', async (t) => {
    const now = Date.now();
    t.mock.method(Date, 'now', () => now - 3_600_000);
    const { handled } = collect();

    write(dir, 'clock.txt');
    await waitFor(() => handled.length === 1);
  });

  test('handles one file at a time, oldest first, by default', async () => {
    let active = 0;
    let maxActive = 0;
    const { handled } = start(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await sleep(40);
      active -= 1;
    });

    const names = ['e.txt', 'd.txt', 'c.txt', 'b.txt', 'a.txt'];
    for (const name of names) {
      write(dir, name);
      await sleep(30);
    }
    await waitFor(() => handled.length === names.length);

    assert.deepEqual(handled, names);
    assert.equal(maxActive, 1);
  });

  test('does not let a file that is still being written block newer files', async () => {
    const { handled } = collect();

    const fd = fs.openSync(path.join(dir, 'growing.log'), 'w');
    const appender = setInterval(() => fs.writeSync(fd, 'line\n'), 10);
    try {
      await sleep(50);
      write(dir, 'job.json');
      await waitFor(() => handled.length === 1);
      assert.deepEqual(handled, ['job.json']);
    } finally {
      clearInterval(appender);
      fs.closeSync(fd);
    }
    await waitFor(() => handled.length === 2);
  });

  test('runs up to concurrency handlers at once', async () => {
    let active = 0;
    let maxActive = 0;
    const { handled } = start(
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
    await waitFor(() => handled.length === 9);

    assert.equal(maxActive, 3);
  });

  test('keeps creation order when the oldest file loses its watch event', async (t) => {
    timing.rescanInterval = 200;
    const watchFn = fs.watch;
    t.mock.method(fs, 'watch', (target: fs.PathLike, options: fs.WatchOptions, listener: fs.WatchListener<string>) =>
      watchFn(target, options, (event, name) => {
        if (name !== 'first.txt') {
          listener(event, name);
        }
      }),
    );
    const { handled } = collect();

    const names = ['first.txt', 'second.txt', 'third.txt'];
    for (const name of names) {
      write(dir, name);
      await sleep(30);
    }
    await waitFor(() => handled.length === names.length);

    assert.deepEqual(handled, names);
  });

  test('finds files when every watch event is lost', async (t) => {
    timing.rescanInterval = 100;
    t.mock.method(fs, 'watch', () => Object.assign(new EventEmitter(), { close: () => {} }));
    const { handled } = collect({ concurrency: 8 });

    for (let index = 0; index < 50; index += 1) {
      write(dir, `lost-${index}.txt`);
    }
    await waitFor(() => handled.length === 50);

    assert.equal(new Set(handled).size, 50);
  });

  test('recovers when a directory scan fails', async (t) => {
    // Periodic rescans are off, so only the retry helps; synthetic events keep the timing deterministic.
    timing.rescanInterval = 0;
    const readdir = fsp.readdir;
    let failures = 1;
    t.mock.method(fsp, 'readdir', async (...args: Parameters<typeof fsp.readdir>) => {
      if (failures > 0) {
        failures -= 1;
        throw Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' });
      }
      return readdir(...args);
    });
    let emit: fs.WatchListener<string> = () => {};
    t.mock.method(fs, 'watch', (_target: fs.PathLike, _options: fs.WatchOptions, listener: fs.WatchListener<string>) => {
      emit = listener;
      return Object.assign(new EventEmitter(), { close: () => {} });
    });
    const { handled, errors } = collect();

    write(dir, 'a.json');
    emit('rename', 'a.json');
    await waitFor(() => handled.length === 1);

    assert.equal(errors.length, 1);
    assert.match(errors[0]?.error.message ?? '', /EMFILE/);
  });

  test('does not let one stalled scan delay the files found meanwhile', async (t) => {
    timing.rescanInterval = 0;
    const readdir = fsp.readdir;
    let stalls = 1;
    t.mock.method(fsp, 'readdir', async (...args: Parameters<typeof fsp.readdir>) => {
      const entries = await readdir(...args);
      if (stalls > 0) {
        stalls -= 1;
        await sleep(600);
      }
      return entries;
    });
    let emit: fs.WatchListener<string> = () => {};
    t.mock.method(fs, 'watch', (_target: fs.PathLike, _options: fs.WatchOptions, listener: fs.WatchListener<string>) => {
      emit = listener;
      return Object.assign(new EventEmitter(), { close: () => {} });
    });
    const { handled } = collect();

    // Starts the stalled scan, then creates a file its listing does not include.
    write(dir, 'first.txt');
    emit('rename', 'first.txt');
    await sleep(200);
    write(dir, 'second.txt');
    emit('rename', 'second.txt');
    await waitFor(() => handled.length === 2, 3000);
  });

  test('does not rescan the directory for events on files it already handled', async (t) => {
    timing.rescanInterval = 0;
    const readdir = t.mock.method(fsp, 'readdir');
    let emit: fs.WatchListener<string> = () => {};
    t.mock.method(fs, 'watch', (_target: fs.PathLike, _options: fs.WatchOptions, listener: fs.WatchListener<string>) => {
      emit = listener;
      return Object.assign(new EventEmitter(), { close: () => {} });
    });
    const { handled } = collect();

    write(dir, 'app.log', 'start\n');
    emit('rename', 'app.log');
    await waitFor(() => handled.length === 1);
    await sleep(300);
    const scans = readdir.mock.callCount();
    for (let index = 0; index < 20; index += 1) {
      fs.appendFileSync(path.join(dir, 'app.log'), `line ${index}\n`);
      emit('change', 'app.log');
      await sleep(10);
    }
    await sleep(300);

    assert.equal(readdir.mock.callCount(), scans);
    assert.equal(handled.length, 1);
  });

  test('does not handle a file twice when it appears while a rescan is listing the directory', async (t) => {
    timing.rescanInterval = 30;
    // A listing taken before a file exists can finish after the file's watch event arrives.
    const readdir = fsp.readdir;
    t.mock.method(fsp, 'readdir', async (...args: Parameters<typeof fsp.readdir>) => {
      const entries = await readdir(...args);
      await sleep(80);
      return entries;
    });
    const { handled } = collect({ concurrency: 4 });

    for (let index = 0; index < 20; index += 1) {
      write(dir, `race-${index}.txt`);
      await sleep(15);
    }
    await waitFor(() => new Set(handled).size === 20);
    await sleep(500);

    assert.equal(handled.length, 20);
  });

  test('handles every file of a burst from another process exactly once', async () => {
    const count = 2000;
    const { files } = collect({ concurrency: 16, done: 'delete' });

    await writeFromAnotherProcess(dir, count, 4096);
    await waitFor(() => files.length >= count && listing(dir).length === 0, 30_000);
    await sleep(300);

    assert.equal(files.length, count);
    assert.equal(new Set(files.map((file) => file.name)).size, count);
    assert.ok(files.every((file) => file.content.length === 4096));
  });

  test('throws errors when nothing listens for them', async () => {
    const dispatcher = dispatch(dir, () => {
      throw new Error('unhandled');
    });
    dispatchers.push(dispatcher);
    const uncaught = new Promise<Error>((resolve) => {
      const listeners = process.listeners('uncaughtException');
      process.removeAllListeners('uncaughtException');
      process.once('uncaughtException', (error) => {
        for (const listener of listeners) {
          process.on('uncaughtException', listener);
        }
        resolve(error);
      });
    });

    write(dir, 'a.txt');

    assert.equal((await uncaught).message, 'unhandled');
  });

  test('close waits for running handlers and stops dispatching', async () => {
    timing.rescanInterval = 50;
    let started = false;
    let finished = false;
    const { dispatcher, handled } = start(async () => {
      started = true;
      await sleep(200);
      finished = true;
    });

    write(dir, 'slow.txt');
    await waitFor(() => started);
    await dispatcher.close();
    assert.equal(finished, true);
    assert.equal(handled.length, 1);

    write(dir, 'after-close.txt');
    await sleep(300);
    assert.equal(handled.length, 1);
  });

  test('close called from a handler does not wait for that handler', async () => {
    let dispatcher: Dispatcher | undefined;
    let returned = false;
    const started = start(async () => {
      await sleep(10);
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

  test('validates arguments and the directory without side effects', () => {
    const noop = () => {};
    assert.throws(() => dispatch('', noop), /directory must be a non-empty string/);
    assert.throws(() => dispatch(dir, 'nope' as unknown as FileHandler), /handler must be a function/);
    assert.throws(() => dispatch(dir, noop, { filter: 'txt' as unknown as RegExp }), /filter must be a RegExp or a function/);
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
  });
});
