import {FdEventType, FdMode, FileDispatcher} from '../src';

const fileDispatcherConfig = {
  path: './test',
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
