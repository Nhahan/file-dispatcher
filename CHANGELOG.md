# Changelog

## 4.0.0

A redesign for processing files dropped into a directory. Every created file is handled exactly once, after it has been fully written, on Linux, macOS, and Windows.

### Breaking changes

- Replaces `FileDispatcher`, `FdMode`, and `FdEventType` with `dispatch(directory, handler, options)` and `watch(directory, options)`.
- Handlers are awaited: with the default `concurrency` of `1`, the next file waits for the previous handler, in creation order.
- Handlers receive a file whose content is read on demand with `text()`, `buffer()`, or `stream()`, instead of the content itself.
- Only newly created files are handled. Modifications and deletions are ignored.
- Requires Node.js 20 or later.

### Added

- `done` and `failed` actions delete or move handled files, so a restart resumes with the files left in the directory.
- `existing`, `concurrency`, `stabilityThreshold`, `rescanInterval`, and `signal` options.
- `filter` accepts a `RegExp` or a predicate.
- `watch()` async iterator.
- `processed`, `failed`, and `error` events.

### Fixed

- Files are no longer lost when `fs.watch` drops events under bursts. In the benchmark, plain `fs.watch` lost up to 75% of files on Windows and 14% on Linux.
- Files are no longer read before their content is written.
- Processing no longer stops permanently after two deleted or empty files.
- Binary files are no longer truncated at the first NUL byte.
- Works on every platform and Node.js version; 3.x shipped a binary only for macOS arm64 on Node.js 18.
