import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { watch, type FileWatcher } from '../src';
import { sleep, tempDir, write } from './helpers';

let dir: string;
const opened: FileWatcher[] = [];

beforeEach(() => {
  dir = tempDir();
});

afterEach(async () => {
  // A failed test must not leave a watcher keeping the process alive.
  await Promise.all(opened.splice(0).map((files) => files.close()));
  fs.rmSync(dir, { recursive: true, force: true });
});

function open(...args: Parameters<typeof watch>): FileWatcher {
  const files = watch(...args);
  opened.push(files);
  return files;
}

describe('watch', () => {
  test('yields new files in creation order and stops when the loop breaks', async () => {
    write(dir, 'existing.txt');
    const files = open(dir);
    const names = ['c.txt', 'b.txt', 'a.txt'];
    void (async () => {
      for (const name of names) {
        write(dir, name);
        await sleep(30);
      }
    })();

    const seen: string[] = [];
    for await (const file of files) {
      seen.push(`${file.name}:${await file.text()}`);
      if (seen.length === names.length) {
        break;
      }
    }

    assert.deepEqual(seen, names.map((name) => `${name}:${name}`));
    assert.deepEqual((await files.next()).done, true);
    assert.ok(fs.existsSync(`${dir}/c.txt`));
  });

  test('includes existing files when asked', async () => {
    write(dir, 'existing.txt');
    const files = open(dir, { existing: true });

    const first = await files.next();
    await files.close();

    assert.equal(first.value?.name, 'existing.txt');
  });

  test('filters file names', async () => {
    const files = open(dir, { filter: /\.json$/ });
    write(dir, 'skip.txt');
    write(dir, 'keep.json');

    const first = await files.next();
    await files.close();

    assert.equal(first.value?.name, 'keep.json');
  });

  test('ends a pending iteration when closed or aborted', async () => {
    const closed = open(dir);
    const pendingClose = closed.next();
    await closed.close();
    assert.deepEqual(await pendingClose, { done: true, value: undefined });

    const controller = new AbortController();
    const aborted = open(dir, { signal: controller.signal });
    const pendingAbort = aborted.next();
    controller.abort();
    assert.deepEqual(await pendingAbort, { done: true, value: undefined });
  });

  test('throws a directory failure once and then ends', async (t) => {
    t.mock.method(fsp, 'readdir', async () => {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    });
    const files = open(dir, { rescanInterval: 50 });

    await assert.rejects(files.next(), /EACCES/);
    assert.deepEqual(await files.next(), { done: true, value: undefined });
  });
});
