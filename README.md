# File Dispatcher

File Dispatcher is a Node.js library for file monitoring and dispatching. It provides the ability to handle file events such as creation or renaming in either asynchronous or synchronous mode. This library utilizes the `chokidar` package for efficient file system monitoring.

### Features

- Monitor specified directories for file events
- Dispatch file events with customizable execution modes (async or sync)
- Emit success or fail events with file path and content
- Supports regular expression pattern matching for file filtering

### Installation

```shell
npm install file-dispatcher
```

## Usage

### Importing the Library

```ts
import { FileDispatcher, FdMode, FdEventType } from 'file-dispatcher';
```

### Creating a FileDispatcher Instance

```ts
const dispatcher = new FileDispatcher('/path/to/directory', FdMode.Async, /\.txt$/);
```

- `/path/to/directory`: The directory to monitor for file events.
- `FdMode.Async`: Execution mode set to asynchronous. Use FdMode.Sync for synchronous execution.
- `/\.txt$/`: Optional regular expression pattern to filter specific file types. Pass undefined for no filtering.

### Starting and Stopping the FileDispatcher

```ts
dispatcher.start(); // Start monitoring the directory
dispatcher.stop(); // Stop monitoring the directory
```

### Handling File Events

```ts
dispatcher.on(FdEventType.Success, (filePath, fileContent) => {
  console.log('File dispatched successfully:', filePath);
  console.log('File content:', fileContent);
});

dispatcher.on(FdEventType.Fail, (error) => {
  console.error('Failed to dispatch file:', error);
});
```

- `FdEventType.Success`: Event emitted when a file is successfully dispatched.
- `FdEventType.Fail`: Event emitted when an error occurs during file dispatching.

## Example

```ts
import { FileDispatcher, FdMode, FdEventType } from 'file-dispatcher';

const dispatcher = new FileDispatcher('/path/to/directory', FdMode.Async);

dispatcher.on(FdEventType.Success, (filePath, fileContent) => {
  console.log('File dispatched successfully:', filePath);
  console.log('File content:', fileContent);
});

dispatcher.on(FdEventType.Fail, (error) => {
  console.error('Failed to dispatch file:', error);
});

dispatcher.start();
```

## Example

This library is licensed under the MIT License.

---

For more information and detailed API documentation, please visit the [GitHub repository](https://github.com/Nhahan/file-dispatcher).
If you encounter any issues or have questions, please feel free to [submit an issue](https://github.com/Nhahan/file-dispatcher/issues).
