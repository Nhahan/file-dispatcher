# file-dispatcher

[![npm](https://img.shields.io/npm/v/file-dispatcher.svg)](https://www.npmjs.com/package/file-dispatcher)
[![CI](https://img.shields.io/github/actions/workflow/status/Nhahan/file-dispatcher/ci.yml?branch=main)](https://github.com/Nhahan/file-dispatcher/actions/workflows/ci.yml)

Process every file dropped into a directory exactly once, after it has been fully written.

Plain `fs.watch` drops events under heavy traffic and reports files before their content is written. file-dispatcher does neither.

## Benchmark

Files delivered with complete content, out of 10,000 files of 4 KB written by another process. Median of 3 rounds on GitHub Actions, Node.js 24:

| Handler work per file | | Linux | macOS | Windows |
| --- | --- | ---: | ---: | ---: |
| none | `fs.watch` | 9,890 | 10,000 | 5,285 |
| | file-dispatcher | **10,000** | **10,000** | **10,000** |
| 1 ms | `fs.watch` | 8,592 | 10,000 | 2,473 |
| | file-dispatcher | **10,000** | **10,000** | **10,000** |

`fs.watch` reads each file on its `rename` event. Run `npm run benchmark` to reproduce.

## Install

```bash
npm install file-dispatcher
```

Node.js 20 or later. No native code and no dependencies.

## Usage

```ts
import { dispatch } from 'file-dispatcher';

const dispatcher = dispatch('./inbox', async (file) => {
  await saveOrder(JSON.parse(await file.text()));
}, {
  filter: /\.json$/,
  done: 'delete',
  failed: { moveTo: './failed' },
});

dispatcher.on('failed', (error, file) => console.error(file.name, error));
dispatcher.on('error', (error) => console.error(error));

// On shutdown: waits for running handlers.
await dispatcher.close();
```

Handlers run one at a time in creation order, and the next file waits for the previous handler. Because `done` removes handled files, anything left in the directory is unhandled, so a restart continues where it stopped.

To only observe files, iterate instead:

```ts
import { watch } from 'file-dispatcher';

for await (const file of watch('./logs', { filter: /\.log$/ })) {
  console.log(file.name, file.size);
}
```

## API

### `dispatch(directory, handler, options?)`

Calls `await handler(file)` for every file created in `directory`. Throws if the directory cannot be read.

| Option | Default | Description |
| --- | --- | --- |
| `filter` | | `RegExp` or `(name) => boolean`. Only matching file names are handled. |
| `concurrency` | `1` | Handlers running at once. With `1`, files are handled in creation order. |
| `done` | `'keep'` | After the handler succeeds: `'keep'`, `'delete'`, or `{ moveTo: directory }`. |
| `failed` | `'keep'` | After the handler throws: `'keep'`, `'delete'`, or `{ moveTo: directory }`. |
| `existing` | `done !== 'keep'` | Also handle files already in the directory at start. |
| `stabilityThreshold` | `50` | Milliseconds a file's size and mtime must stay unchanged before it is handled. |
| `rescanInterval` | `1000` | Milliseconds between rescans that run without watch events. `0` disables them. |
| `signal` | | `AbortSignal` that closes the dispatcher. |

Returns a dispatcher with `close()` and these events:

- `processed (file)`: the handler succeeded and `done` was applied.
- `failed (error, file)`: the handler threw, or `done` or `failed` could not be applied.
- `error (error)`: the directory could not be watched or listed.

### `watch(directory, options?)`

Returns an async iterable of files in creation order. The next file is found only after the loop body finishes, and the directory is never modified. Takes `filter`, `existing` (default `false`), `stabilityThreshold`, `rescanInterval`, and `signal`. Breaking out of the loop or calling `close()` stops watching.

### File

`path`, `name`, `size`, and `createdAt`, plus `text(encoding?)`, `buffer()`, and `stream()` to read the content on demand.

## How it works

- Watch events only trigger a rescan. New files are found by comparing directory listings, so a dropped event cannot lose a file.
- A file is handled once its size and mtime stop changing for `stabilityThreshold` milliseconds.
- In creation order, a file waits for a rescan that started after it was found, so an older file whose event was dropped still goes first.

## License

[MIT](./LICENSE)
