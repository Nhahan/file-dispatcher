# file-dispatcher

[![npm](https://img.shields.io/npm/v/file-dispatcher.svg)](https://www.npmjs.com/package/file-dispatcher)
[![CI](https://img.shields.io/github/actions/workflow/status/Nhahan/file-dispatcher/ci.yml?branch=main)](https://github.com/Nhahan/file-dispatcher/actions/workflows/ci.yml)

Dispatches every file created in a directory exactly once, after it has been fully written.

Plain `fs.watch` drops events under heavy traffic and reports files before their content is written. file-dispatcher does neither.

## Benchmark

Files delivered with complete content, out of 10,000 files of 4 KB written by another process. Median of 3 rounds on GitHub Actions, Node.js 24:

| Listener work per file | | Linux | macOS | Windows |
| --- | --- | ---: | ---: | ---: |
| none | `fs.watch` | 9,929 | 10,000 | 5,354 |
| | file-dispatcher | **10,000** | **10,000** | **10,000** |
| 1 ms | `fs.watch` | 8,593 | 10,000 | 2,441 |
| | file-dispatcher | **10,000** | **10,000** | **10,000** |

`fs.watch` reads each file on its `rename` event. Run `npm run benchmark` to reproduce.

## Install

```bash
npm install file-dispatcher
```

Node.js 20 or later. No native code and no dependencies.

## Usage

```ts
import { FdEventType, FileDispatcher } from 'file-dispatcher';

const dispatcher = new FileDispatcher({ path: './inbox', pattern: /\.json$/ });

dispatcher.on(FdEventType.Success, (filePath, content) => {
  console.log(filePath, content);
});
dispatcher.on(FdEventType.Fail, (error, filePath) => {
  console.error(filePath, error);
});

dispatcher.start();
// ...
await dispatcher.stop();
```

## Options

| Option | Default | Description |
| --- | --- | --- |
| `path` | `process.cwd()` | Directory to watch. Subdirectories are not watched. |
| `mode` | `FdMode.Async` | `FdMode.Async` reads files concurrently. `FdMode.Sync` dispatches one file at a time in creation order. |
| `pattern` | | Only file names matching this `RegExp` are dispatched. |
| `encoding` | `'utf8'` | Encoding used to read files. `null` dispatches a `Buffer`. |
| `interceptor` | | `(filePath, content) => content`, sync or async. Transforms content before it is dispatched. |
| `concurrency` | `16` | Files read at once in `FdMode.Async`. |
| `stabilityThreshold` | `50` | Milliseconds a file's size and mtime must stay unchanged before it is read. |
| `rescanInterval` | `1000` | Milliseconds between rescans that run without watch events. `0` disables them. |

Files that already exist when `start()` is called are not dispatched, and neither are modifications or deletions.

## Events

- `FdEventType.Success`: `(filePath, content)`
- `FdEventType.Fail`: `(error, filePath)` for read and interceptor errors, or `(error)` when the directory cannot be read

## How it works

- Watch events only trigger a rescan. New files are found by comparing directory listings, so a dropped event cannot lose a file.
- A file is read once its size and mtime stop changing for `stabilityThreshold` milliseconds.
- In `FdMode.Sync`, a file waits for a rescan that started after it was found, so an older file whose event was dropped still goes first.

Upgrading from 3.x: see the [CHANGELOG](./CHANGELOG.md).

## License

[MIT](./LICENSE)
