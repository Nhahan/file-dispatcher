# File Dispatcher

File Dispatcher is a lightweight and high-performance Node.js library for file event monitoring and dispatching. It leverages only the built-in Node.js libraries, making it a compact and efficient solution for handling file creation or renaming events. It provides real-time responses and supports both synchronous and asynchronous modes, making it well-suited for event-driven file system interactions.

---

### Features

- Monitor specified directories for file events
- Dispatch file events with customizable execution modes (async or sync)
- Intercept file content and modify it using customizable interceptor function
- Supports regular expression pattern matching for file filtering
- Emit success or fail events with file path and content

### Installation

```shell
npm install file-dispatcher
```

## Usage

```ts
import { FileDispatcher, FdMode, FdEventType } from 'file-dispatcher';

// Create a FileDispatcher instance
const dispatcher = new FileDispatcher({
  path: '/path/to/directory',
  mode: FdMode.Async,
  interceptor: customInterceptor, // Optional
  pattern: /\.txt$/, // Optional
});

dispatcher.start(); // Start monitoring the directory
dispatcher.stop(); // Stop monitoring the directory

// Handle success and fail event
dispatcher.on(FdEventType.Success, (filePath, fileContent) => {
  console.log('File dispatched successfully:\n', 'Path:', filePath, '\nContent:', fileContent); 
});
dispatcher.on(FdEventType.Fail, (error) => {
  console.error('Failed to dispatch file:', error);
});

// Custom interceptor function
function customInterceptor(filePath: string, content: string): string {
  // Modify the file content here (example: convert to uppercase)
  return content.toUpperCase();
}
```

### FileDispatcherOptions

- `path`: The directory path to monitor for file events.
- `mode`: The execution mode for file processing. Use `FdMode.Async` for asynchronous mode or `FdMode.Sync` for synchronous mode.
- `interceptor` (optional): A custom interceptor function that can modify the file content before dispatching. It takes the file path and content as input and returns the modified content.
- `pattern` (optional): A regular expression pattern to filter specific file types. Only files matching this pattern will be dispatched. Leave it empty to include all files.

### FdEventType

- `FdEventType.Success`: Event type emitted when a file is successfully dispatched.
- `FdEventType.Fail`: Event type emitted when an error occurs during file dispatching.

### FdMode

- `FdMode.Async`: Execution mode set to asynchronous. Use this mode for asynchronous file processing.
- `FdMode.Sync`: Execution mode set to synchronous. Use this mode for synchronous file processing.

---

## License

This library is licensed under the MIT License.

---

For more information and detailed API documentation, please visit the [GitHub repository](https://github.com/Nhahan/file-dispatcher).  
If you encounter any issues or have questions, please feel free to [submit an issue](https://github.com/Nhahan/file-dispatcher/issues).


