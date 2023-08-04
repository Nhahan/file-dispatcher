import {FdEventType, FdInterceptor} from '../src';

interface TaskWithContent {
    filePath: string;
    content: string;
}

jest.mock('fs', () => {
    const originalFs = jest.requireActual('fs');
    return {
        ...originalFs,
        watch: jest.fn().mockImplementation((path, options, listener) => {
            if (typeof options === 'function') {
                listener = options;
            }
            listener('rename', './');
            return {
                close: jest.fn(),
            };
        }),
        existsSync: jest.fn(),
    };
});

class FakeFileDispatcher {
    private processedStringCount: number;
    private readonly interceptor: FdInterceptor;
    private eventHandlers: Map<FdEventType, Function[]>;

    constructor(private options: any) {
        this.processedStringCount = 0;
        this.interceptor = options.interceptor;
        this.eventHandlers = new Map();
    }

    public on(eventType: FdEventType, handler: Function): void {
        const handlers = this.eventHandlers.get(eventType) || [];
        handlers.push(handler);
        this.eventHandlers.set(eventType, handlers);
    }

    public processFile(task: TaskWithContent): Promise<void> {
        return new Promise<void>((resolve) => {
            this.processedStringCount++;
            if (this.interceptor) {
                task.content = this.interceptor(task.filePath, task.content);
            }

            this.emit(FdEventType.Success, task.filePath, task.content);

            resolve();
        });
    }

    public stop(): void {
        this.eventHandlers.clear();
    }

    private emit(eventType: FdEventType, ...args: any[]): void {
        const handlers = this.eventHandlers.get(eventType) || [];
        handlers.forEach((handler) => {
            handler(...args);
        });
    }
}

describe('FileDispatcher', () => {
    const originalContent = 'original';
    const modifiedContent = 'Modified Content';
    let fileDispatcher: FakeFileDispatcher;

    afterEach(() => {
        jest.clearAllMocks();
    });

    afterAll(() => {
        fileDispatcher.stop();
    });

    describe('FileDispatcher', () => {
        afterEach(() => {
            jest.clearAllMocks();
        });

        describe('interceptor', () => {
            it('should process original content when interceptor is null', () => {
                fileDispatcher = new FakeFileDispatcher({});

                let successEventCount = 0;

                fileDispatcher.on(FdEventType.Success, (filePath: string, content: string) => {
                    successEventCount++;
                    expect(content).toBe(originalContent);
                });

                fileDispatcher.processFile({ filePath: 'file1.txt', content: originalContent });
                fileDispatcher.processFile({ filePath: 'file2.txt', content: originalContent });

                expect(successEventCount).toBe(2);
            });

            it('should process modified content when interceptor is provided', () => {
                const interceptor: FdInterceptor = (filePath, content) => {
                    return modifiedContent;
                };

                fileDispatcher = new FakeFileDispatcher({
                    interceptor: interceptor,
                });

                let successEventCount = 0;

                fileDispatcher.on(FdEventType.Success, (filePath: string, content: string) => {
                    successEventCount++;
                    expect(content).toBe(modifiedContent);
                });

                fileDispatcher.processFile({ filePath: 'file1.txt', content: originalContent });
                fileDispatcher.processFile({ filePath: 'file2.txt', content: originalContent });

                expect(successEventCount).toBe(2);
            });
        });
    });
});
