# file-dispatcher

[![npm](https://img.shields.io/npm/v/file-dispatcher.svg)](https://www.npmjs.com/package/file-dispatcher)
[![CI](https://img.shields.io/github/actions/workflow/status/Nhahan/file-dispatcher/ci.yml?branch=main)](https://github.com/Nhahan/file-dispatcher/actions/workflows/ci.yml)

Process every file dropped into a directory once, after it has been fully written. Plain `fs.watch` misses files under heavy traffic; file-dispatcher does not.

## Benchmark

Files received intact out of 10,000 written by another process (median of 3 runs):

| | Linux | macOS | Windows |
| --- | ---: | ---: | ---: |
| `fs.watch` | 9,871 | 10,000 | 6,049 |
| `fs.watch`, 1 ms of work per file | 8,415 | 10,000 | 2,498 |
| file-dispatcher, either case | **10,000** | **10,000** | **10,000** |

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

## API

### `dispatch(directory, handler, options?)`

Calls `handler(file)` for each new file and waits for it. `file` has `id`, `name`, `path`, `size`, and `createdAt`.

| Option | Default | |
| --- | --- | --- |
| `filter` | | `RegExp` or `(name) => boolean` |
| `concurrency` | `1` | Handlers running at once; with `1`, oldest file first |
| `done` | `'keep'` | After the handler succeeds: `'keep'`, `'delete'`, or `{ moveTo }`, which never overwrites |
| `stabilityThreshold` | `50` | Milliseconds a file must stay unchanged before it is handled |

When `done` removes handled files, a restart picks up where it left off:

- Files already in the directory at start are handled.
- A file whose handler failed is tried again.
- A file is handled again if the process stopped between its handler and `done`. `file.id` stays the same, so the handler can skip it.

### `'error'` event

`(error, file)`: the handler threw, or `done` kept failing, and the file was left in place. Without `file`, the directory could not be read. Without a listener, the error is thrown.

### `close()`

Stops watching and waits for running handlers.

## License

[MIT](./LICENSE)
