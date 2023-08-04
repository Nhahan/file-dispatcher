import { FdEventType, FdMode, FileDispatcher } from '../src';

/**
 * To test the FileDispatcher, execute this .ts file `using ts-node`
 * and run the `file-generator.test.ts`. This will allow you to test the file-dispatcher functionality.
 */
const fileDispatcherConfig = {
  path: './test',
  mode: FdMode.Async,
  interceptor: function customInterceptor(filePath: string, content: string): string {
    // Modify the file content here (example: convert to uppercase)
    return content.toUpperCase();
  }
};

const dispatcher = new FileDispatcher(fileDispatcherConfig);

dispatcher.on(FdEventType.Success, (filePath, fileContent) => {
  console.log(filePath, fileContent);
});

dispatcher.on(FdEventType.Fail, (error) => {
  console.error('Failed to read file:', error);
});

dispatcher.start();
