import { FileDispatcher, FdMode, FdEventType } from '../src';

const dispatcher = new FileDispatcher('./test', FdMode.Async);

dispatcher.on(FdEventType.Success, (filePath, fileContent) => {
  console.log('File dispatched successfully:', filePath);
  console.log('File content:', fileContent);
});

dispatcher.on(FdEventType.Fail, (error) => {
  console.error('Failed to dispatch file:', error);
});

dispatcher.start();
