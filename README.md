# file-dispatcher

[![npm](https://img.shields.io/npm/v/file-dispatcher.svg)](https://www.npmjs.com/package/file-dispatcher)
[![CI](https://img.shields.io/github/actions/workflow/status/Nhahan/file-dispatcher/ci.yml?branch=main)](https://github.com/Nhahan/file-dispatcher/actions/workflows/ci.yml)

Process every file dropped into a directory exactly once, after it has been fully written. Plain `fs.watch` misses files under heavy traffic; file-dispatcher does not.

## Benchmark

Files delivered with complete content, out of 10,000 files written by another process (median of 3 runs; file-dispatcher with `concurrency: 16`):

| Handler work per file | | Linux | macOS | Windows |
| --- | --- | ---: | ---: | ---: |
| none | `fs.watch` | 9,871 | 10,000 | 6,049 |
| | file-dispatcher | **10,000** | **10,000** | **10,000** |
| 1 ms | `fs.watch` | 8,415 | 10,000 | 2,498 |
| | file-dispatcher | **10,000** | **10,000** | **10,000** |

## Install

```bash
npm install file-dispatcher
```

## Usage

```ts
import { readFile } from 'node:fs/promises';
import { dispatch } from 'file-dispatcher';

const dispatcher = dispatch('./inbox', async (file) => {
  await saveOrder(JSON.parse(await readFile(file.path, 'utf8')));
}, {
  filter: /\.json$/,
  done: 'delete',
});

dispatcher.on('error', (error, file) => console.error(file?.name, error));

// On shutdown:
await dispatcher.close();
```

Files are handled one at a time, oldest first. Renaming or hard-linking a handled file does not handle it again.

## API

### `dispatch(directory, handler, options?)`

Calls `handler(file)` for each new file and waits for it.

| Option | Default | |
| --- | --- | --- |
| `filter` | | `RegExp` or `(name) => boolean` |
| `concurrency` | `1` | Handlers running at once |
| `done` | `'keep'` | After the handler succeeds: `'keep'`, `'delete'`, or `{ moveTo }` |
| `stabilityThreshold` | `50` | Milliseconds a file must stay unchanged before it is handled |

`{ moveTo }` never overwrites; a taken name gets a `-1`, `-2`, ... suffix.

When `done` removes handled files, files already in the directory at start are handled too, and a file whose handler failed is tried again on the next start. A file is also handled again if the process stopped between its handler and `done`; use `file.id` to make the handler idempotent.

`file` has `id` (the same for the same file across restarts), `name`, `path`, `size`, and `createdAt`.

### `'error'` event

`(error, file)`: the handler threw, or `done` still failed after a few retries, and the file was left in place. Without `file`, the directory could not be watched or read. Without an `error` listener, the error is thrown.

### `close()`

Stops watching and waits for running handlers.

## License

[MIT](./LICENSE)
