import assert from 'node:assert/strict';
import fs from 'node:fs';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { watch } from '../src';
import { sleep, tempDir, write } from './helpers';

let dir: string;

beforeEach(() => {
  dir = tempDir();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('watch', () => {
  test('yields new files in creation order and stops when the loop breaks', async () => {
    write(dir, 'existing.txt');
    const files = watch(dir);
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
    const files = watch(dir, { existing: true });

    const first = await files.next();
    await files.close();

    assert.equal(first.value?.name, 'existing.txt');
  });

  test('ends a pending iteration when closed or aborted', async () => {
    const controller = new AbortController();
    const files = watch(dir, { signal: controller.signal });

    const pending = files.next();
    controller.abort();

    assert.deepEqual(await pending, { done: true, value: undefined });
  });
});
