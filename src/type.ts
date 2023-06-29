export enum FdEventType {
  Success = 'FdEventType.Success',
  Fail = 'FdEventType.Fail',
}

export enum FdMode {
  Async = 'FdMode.Async',
  Sync = 'FdMode.Sync',
}

export interface FileDispatcherOptions {
  path: string;
  mode: FdMode;
  interceptor?: FdInterceptor;
  pattern?: RegExp;
}

export type FdInterceptor = (filePath: string, content: string) => string;