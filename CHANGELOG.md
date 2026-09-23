# Changelog

## 4.0.0

Rewritten in TypeScript without native code. Every file created in the watched directory is now dispatched exactly once, after it has been fully written, on Linux, macOS, and Windows.

### Breaking changes

- Requires Node.js 20 or later.
- Only newly created files are dispatched. Modifications and deletions are ignored; 3.x also dispatched modified files.
- `path` defaults to `process.cwd()` instead of the package's install directory.
- Invalid options throw a `TypeError`, and `start()` throws when the directory cannot be read. 3.x only logged these.
- `stop()` returns a promise that resolves when in-flight dispatches finish.

### Added

- `encoding` option; `null` dispatches a `Buffer`.
- `concurrency`, `stabilityThreshold`, and `rescanInterval` options.
- Interceptors may be async.
- `FdEventType.Fail` is emitted for read and interceptor errors.
- Typed `on` and `once` overloads for both events.

### Fixed

- Files are no longer lost when `fs.watch` drops events under bursts. In the benchmark, plain `fs.watch` lost up to 76% of files on Windows and 14% on Linux.
- Files are no longer read before their content is written.
- Dispatching no longer stops permanently after two deleted or empty files.
- Binary files are no longer truncated at the first NUL byte.
- Works on every platform and Node.js version; 3.x shipped a binary only for macOS arm64 on Node.js 18.
- `mode` is optional, as documented.
