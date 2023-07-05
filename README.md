# File Dispatcher

The File Dispatcher is a lightweight and high-performance Node.js library designed to monitor and dispatch file creation events. It provides real-time responses and effectively handles file system interactions without external dependencies. With support for both synchronous and asynchronous modes. It ensures reliable performance. Additionally, it is compatible with Linux, macOS, and Windows, offering seamless operation across multiple platforms.

---

### How It Works

The built-in fs module in Node.js has a performance flaw where it fails to read all files in situations where files are rapidly created. This library has addressed this issue by implementing the following solution.

- Main Thread: The main thread scans file paths and stores them in a queue, without reading their contents.
- Worker Threads: Worker threads retrieve file paths from the queue and read the corresponding file contents.

This method allows the library to efficiently handle a large volume of data. In C++ code, the content is read immediately upon receiving the path, thereby making the probability of encountering concurrency issues extremely low. Therefore, no lock processing, such as mutex, has been applied.  
The fs module treats file creation, modification, and deletion as a single event called "rename." To address this, a C++ native addon is used to detect file creations.

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


