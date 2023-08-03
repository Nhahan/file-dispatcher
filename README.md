# File Dispatcher

The File Dispatcher is a lightweight and high-performance Node.js library designed to monitor and dispatch file creation events. It provides real-time responses and effectively handles file system interactions without external dependencies. With support for both synchronous and asynchronous modes. It ensures reliable performance. Additionally, it is compatible with Linux, macOS, and Windows, offering seamless operation across multiple platforms.

---

### How It Works

The built-in fs module in Node.js had two issues, which have been addressed as follows:

1. The problem of not being able to read all files efficiently in situations of rapid file creation:
      - Main Thread: The main thread scans file paths and stores them in a queue.
      - Worker Threads: Worker threads retrieve file paths from the queue and read the corresponding file contents.

2. Treating file creations, modifications, and deletions as a single "rename" event, resulting in the inability to detect file creations accurately:
      - C++ code only reads file creations.

The native addon effectively resolves this by reading the content immediately upon receiving the path, thereby making the probability of encountering concurrency issues extremely low. Therefore, no lock processing, such as mutex, has been applied.

---

### Features

- Monitor specified directories for file creation events
- Dispatch file events with customizable execution modes (async or sync)
- Intercept file content and modify it using customizable interceptor function
- Supports regular expression pattern matching for file name filtering
- Emit success or fail events with file path and content

### Installation

```shell
npm install file-dispatcher
```

***<span style="color: Orange;">Note</span>**: Versions lower than <span style="color: red;">3.0.0</span> are <u>not</u> recommended*

<br>

## Usage

```ts
import { FileDispatcher, FdMode, FdEventType } from 'file-dispatcher';

// Create a FileDispatcher instance
const dispatcher = new FileDispatcher({
  path: './directory/path', // Optional. Default: current directory
  mode: FdMode.Sync, // Optional. Default: FdMode.Async
  interceptor: customInterceptor, // Optional
  pattern: /binlog/, // Optional (file name pattern)
});

dispatcher.start(); // Start monitoring the directory
dispatcher.stop(); // Stop monitoring the directory

// Handle success and fail event
dispatcher.on(FdEventType.Success, (filePath, fileContent) => {
  console.log('File dispatched successfully. Path:', filePath, '\nContent:', fileContent); 
});
dispatcher.on(FdEventType.Fail, (error) => {
  console.error('Failed to dispatch file.', error);
});

function customInterceptor(filePath: string, content: string): string {
  return content.toUpperCase(); // Modify the file content here (example: convert to uppercase)
}
```

### FileDispatcherOptions


- `path` (optional): The directory path to monitor for file events. Leave it empty to monitor the current code file directory.
- `mode` (optional): Use `FdMode.Async` for asynchronous mode or `FdMode.Sync` for synchronous mode. The default mode is `FdMode.Async`.
- `interceptor` (optional): A custom interceptor function that can modify the file content before dispatching. It takes the file path and content as input and returns the modified content.
- `pattern` (optional): A regular expression pattern to filter specific file types. Only files matching this pattern will be dispatched. Leave it empty to include all files.

### FdEventType

- `FdEventType.Success`: Event type emitted when a file is successfully dispatched.
- `FdEventType.Fail`: Event type emitted when an error occurs during file dispatching.

### FdMode

- `FdMode.Async`: Enables parallel processing for faster execution speed, but does not guarantee the order of file processing.
- `FdMode.Sync`: Ensures the order of file processing but may have slower execution speed compared to the asynchronous mode.

<br>


## License

This library is licensed under the MIT License.

---

For more information and detailed API documentation, please visit the [GitHub repository](https://github.com/Nhahan/file-dispatcher).  
If you encounter any issues or have questions, please feel free to [submit an issue](https://github.com/Nhahan/file-dispatcher/issues).


