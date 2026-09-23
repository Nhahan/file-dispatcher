# file-dispatcher

[![npm](https://img.shields.io/npm/v/file-dispatcher.svg)](https://www.npmjs.com/package/file-dispatcher)
[![CI](https://img.shields.io/github/actions/workflow/status/Nhahan/file-dispatcher/ci.yml?branch=main)](https://github.com/Nhahan/file-dispatcher/actions/workflows/ci.yml)

Process every file dropped into a directory exactly once, after it has been fully written.

Plain `fs.watch` drops events under heavy traffic and reports files before their content is written. file-dispatcher does neither.

## Benchmark

Files delivered with complete content, out of 10,000 files of 4 KB written by another process. Median of 3 rounds on GitHub Actions, Node.js 24:

| Handler work per file | | Linux | macOS | Windows |
| --- | --- | ---: | ---: | ---: |
| none | `fs.watch` | 9,939 | 10,000 | 6,108 |
| | file-dispatcher | **10,000** | **10,000** | **10,000** |
| 1 ms | `fs.watch` | 8,597 | 10,000 | 2,101 |
| | file-dispatcher | **10,000** | **10,000** | **10,000** |

`fs.watch` reads each file on its `rename` event; file-dispatcher runs with `concurrency: 16`. Run `npm run benchmark` to reproduce.

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

Handlers run one at a time, oldest file first, and the next file waits for the previous handler. Because `done` removes handled files, anything left in the directory is unhandled, so a restart continues where it stopped.

To only observe files, iterate instead:

```ts
import { watch } from 'file-dispatcher';

for await (const file of watch('./logs', { filter: /\.log$/ })) {
  console.log(file.name, file.size);
}
```

## API

### `dispatch(directory, handler, options?)`

Calls `await handler(file, { signal })` for every file created in `directory`. `signal` aborts when the dispatcher closes. Throws if the directory cannot be read.

| Option | Default | Description |
| --- | --- | --- |
| `filter` | | `RegExp` or `(name) => boolean`. Only matching file names are handled. |
| `concurrency` | `1` | Handlers running at once. With `1`, files are handled oldest first. |
| `done` | `'keep'` | After the handler succeeds: `'keep'`, `'delete'`, or `{ moveTo: directory }`. |
| `failed` | `'keep'` | After the handler throws: `'keep'`, `'delete'`, or `{ moveTo: directory }`. |
| `existing` | `done !== 'keep'` | Also handle files already in the directory at start. |
| `stabilityThreshold` | `50` | Milliseconds a file's size and mtime must stay unchanged before it is handled. |
| `rescanInterval` | `1000` | Minimum milliseconds between rescans that run without watch events. `0` disables them. |
| `signal` | | `AbortSignal` that closes the dispatcher. |

`moveTo` never overwrites: if the target name is taken, the file becomes `name-1.ext`, `name-2.ext`, and so on.

The dispatcher emits:

- `processed (file, movedTo)`: the handler succeeded and `done` was applied. `movedTo` is the new path when `done` moved the file.
- `failed (error, file, movedTo)`: the handler threw and `failed` was applied. If an action itself fails, `error` is an `ActionError`, and the action is retried without running the handler again.
- `error (error)`: the directory could not be watched or listed. Dispatching resumes once it can. Like any EventEmitter, an `error` without a listener is thrown.

`close()` stops watching and waits for running handlers. Called from inside a handler, it does not wait for that handler.

### `watch(directory, options?)`

Returns an async iterable of files, oldest first. The next file is found only after the loop body finishes, and the directory is never modified. Takes `filter`, `existing` (default `false`), `stabilityThreshold`, `rescanInterval`, and `signal`. Breaking out of the loop or calling `close()` stops watching. A directory failure is thrown from the loop once and ends it.

### File

`path`, `name`, `size`, and `createdAt`, plus `text(encoding?)`, `buffer()`, and `stream()` to read the content on demand. Read it inside the handler: after `done` or `failed` deletes or moves the file, `path` no longer exists.

## How it works

- Watch events only point at names to check. New files are also found by comparing directory listings, so a dropped event cannot lose a file.
- Files are identified by device, inode, and birth time, so a file replaced under a name that was already handled is handled again.
- A file is handled once its size and mtime stop changing for `stabilityThreshold` milliseconds.
- Oldest first means a newer file waits for older files that were found first, including one whose watch event was dropped. It waits at most a second (or 20 × `stabilityThreshold`) for a file that is still being written.
- Handling is at least once: if the process stops after a handler finishes but before `done` completes, the file is handled again on the next start.

## License

[MIT](./LICENSE)
