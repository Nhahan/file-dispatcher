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

// On shutdown:
await dispatcher.close();
```

Files are handled one at a time, oldest first. With `done` removing handled files, a restart picks up whatever is left. Renaming or hard-linking a handled file does not handle it again.

To only observe files:

```ts
import { watch } from 'file-dispatcher';

for await (const file of watch('./uploads', { filter: /\.csv$/ })) {
  console.log(file.name, file.size);
}
```

## API

### `dispatch(directory, handler, options?)`

Calls `handler(file, { signal })` for each new file and waits for it. `signal` aborts when the dispatcher closes.

| Option | Default | |
| --- | --- | --- |
| `filter` | | `RegExp` or `(name) => boolean` |
| `concurrency` | `1` | Handlers running at once |
| `done` | `'keep'` | After success: `'keep'`, `'delete'`, or `{ moveTo }` |
| `failed` | `'keep'` | After failure: `'keep'`, `'delete'`, or `{ moveTo }` |
| `existing` | `done !== 'keep'` | Also handle files present at start |
| `stabilityThreshold` | `50` | Milliseconds a file must stay unchanged before it is handled |
| `rescanInterval` | `1000` | Milliseconds between rescans; `0` disables them |
| `signal` | | `AbortSignal` that closes the dispatcher |

`{ moveTo }` never overwrites; a taken name gets a `-1`, `-2`, ... suffix.

Events:

- `processed (file, movedTo)`
- `failed (error, file, movedTo)`: `error` is an `ActionError` when `done` or `failed` still failed after a few retries; the file is left in place.
- `error (error)`: the directory could not be watched or read. Without an `error` listener, it is thrown.

`close()` stops watching and waits for running handlers.

A file is handled again after a restart if the process stopped between its handler and `done`; use `file.id` to make the handler idempotent.

### `watch(directory, options?)`

An async iterable of new files, oldest first. Takes `filter`, `existing` (default `false`), `stabilityThreshold`, `rescanInterval`, and `signal`. Leaving the loop stops watching; a directory error is thrown from the loop.

### File

`id` (the same for the same file across restarts), `path`, `name`, `size`, `createdAt`, `text(encoding?)`, `buffer()`, and `stream()`.

## License

[MIT](./LICENSE)
