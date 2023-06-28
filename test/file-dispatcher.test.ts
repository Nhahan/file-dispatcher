import { FileDispatcher, FdMode, FdEventType } from '../src';

const fileDispatcherConfig = {
  path: './test/tmp',
  mode: FdMode.Async,
}
const dispatcher = new FileDispatcher(fileDispatcherConfig);

dispatcher.on(FdEventType.Success, (filePath, fileContent) => {
  console.log(filePath, fileContent);
});

dispatcher.on(FdEventType.Fail, (error) => {
  console.error('Failed to dispatch file:', error);
});

dispatcher.start();
