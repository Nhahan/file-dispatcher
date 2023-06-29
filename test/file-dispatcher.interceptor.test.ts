import {FileDispatcher} from '../src';
import {FdEventType, FdInterceptor, FdMode} from '../src/type';

describe('FileDispatcher', () => {
    const path = './path/directory';
    const originalContent = 'original';
    const modifiedContent = 'Modified Content';
    let fileDispatcher: FileDispatcher;

    afterEach(() => {
        fileDispatcher.stop();
    });

    describe('emitEvent', () => {
        it('should emit event with modified content when interceptor modifies the content', (done) => {
            const interceptor: FdInterceptor = (filePath: string, content: string) => {
                if (filePath.includes('path')) {
                    return modifiedContent;
                }
                return content;
            };
            fileDispatcher = new FileDispatcher({ path, mode: FdMode.Async, interceptor });

            fileDispatcher.on(FdEventType.Success, (emittedFilePath, emittedContent) => {
                expect(emittedFilePath).toEqual(path);
                expect(emittedContent).toEqual(modifiedContent);
                done();
            });
            fileDispatcher['emitEvent'](FdEventType.Success, path, originalContent);
        });

        it('should emit event with original content when interceptor is null', (done) => {
            fileDispatcher = new FileDispatcher({ path, mode: FdMode.Async });

            fileDispatcher.on(FdEventType.Success, (emittedFilePath, emittedContent) => {
                expect(emittedFilePath).toEqual(path);
                expect(emittedContent).toEqual(originalContent);
                done();
            });
            fileDispatcher['emitEvent'](FdEventType.Success, path, originalContent);
        });
    });
});
