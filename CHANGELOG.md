# Changelog

## 4.0.0

A redesign for processing files dropped into a directory. Every created file is handled once, after it has been fully written, on Linux, macOS, and Windows.

### Breaking changes

- Replaces `FileDispatcher`, `FdMode`, and `FdEventType` with `dispatch(directory, handler, options)`. `pattern` is now `filter`, `mode` is replaced by `concurrency`, and `interceptor` is removed: transform content in the handler.
- Handlers are awaited: with the default `concurrency` of `1`, the next file waits for the previous handler, in creation order.
- Handlers receive the file's `path` and metadata instead of its content.
- Only newly created files are handled. Modifications and deletions are ignored.
- Errors, including a handler's, are reported on a single `error` event with the file they concern.
- Requires Node.js 20 or later.

### Added

- `done` deletes or moves handled files, so a restart resumes with the files left in the directory. Moves never overwrite, and a failed action is retried a few times without running the handler again.
- `concurrency` and `stabilityThreshold` options, and `filter` accepts a `RegExp` or a predicate.
- `file.id`, which stays the same for the same file across restarts, for idempotent handlers.

### Fixed

- Files are no longer lost when `fs.watch` drops events under bursts. In the benchmark, plain `fs.watch` lost up to 75% of files on Windows and 16% on Linux.
- Files are no longer handed out before their content is written.
- A file replaced under the name of a handled file is handled again, while a handled file renamed or hard-linked under another name, or reported under another spelling (an 8.3 short name or other letter case), is not.
- `done: 'delete'` never deletes a file that replaced the handled one.
- Processing no longer stops permanently after two deleted or empty files.
- Binary files are no longer truncated at the first NUL byte.
- Works on Linux, macOS, and Windows with every supported Node.js version; 3.x shipped a binary only for macOS arm64 on Node.js 18.
