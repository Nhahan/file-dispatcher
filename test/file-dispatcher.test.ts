import * as fs from 'fs';
import { FdEventType, FdMode, FileDispatcher } from '../src/file-dispatcher';
import path from 'path';

// 테스트용 임시 디렉토리 생성
const tmpDir = fs.mkdtempSync('/');

describe('FileDispatcher', () => {
  let fileDispatcher: FileDispatcher;

  beforeEach(() => {
    // 테스트마다 새로운 FileDispatcher 인스턴스 생성
    fileDispatcher = new FileDispatcher(tmpDir, FdMode.Async, /\.txt$/);
  });

  afterEach(() => {
    // 테스트 종료 후 생성된 파일 및 디렉토리 제거
    fs.readdirSync(tmpDir).forEach((file) => {
      fs.unlinkSync(path.join(tmpDir, file));
    });
    fs.rmdirSync(tmpDir);
  });

  test('should emit success event when a matching file is created or renamed', async () => {
    const assertionCount = 2;

    // Create a Promise that resolves when the expected number of assertions have been made
    const assertionPromise = new Promise<void>((resolve) => {
      let assertionCounter = 0;

      // Success 이벤트 핸들러 등록
      fileDispatcher.on(FdEventType.Success, (filePath, fileContent) => {
        expect(filePath).toMatch(/\.txt$/);
        expect(fileContent).toBe('Test file content');
        assertionCounter++;

        // Check if all assertions have been made
        if (assertionCounter === assertionCount) {
          resolve();
        }
      });
    });

    // 파일 생성 후 확인
    const filePath = path.join(tmpDir, 'test.txt');
    fs.writeFileSync(filePath, 'Test file content');
    await assertionPromise; // Wait for the expected assertions to be made
  });

  test('should emit fail event when an error occurs while processing a file', async () => {
    expect.assertions(1);

    // Fail 이벤트 핸들러 등록
    fileDispatcher.on(FdEventType.Fail, (error) => {
      expect(error).toBeInstanceOf(Error);
    });

    // 존재하지 않는 파일을 강제로 처리하도록 시도
    const nonExistentFile = path.join(tmpDir, 'nonexistent.txt');
    fileDispatcher.start(); // 감시 시작
    await new Promise((resolve) => setTimeout(resolve, 100)); // 감시 이벤트 처리 대기

    fs.writeFileSync(nonExistentFile, 'Nonexistent file content');
    await new Promise((resolve) => setTimeout(resolve, 100)); // 감시 이벤트 처리 대기
  });

  test('should handle both async and sync execution modes', async () => {
    expect.assertions(2);

    const asyncFileDispatcher = new FileDispatcher(tmpDir, FdMode.Async, /\.txt$/);
    const syncFileDispatcher = new FileDispatcher(tmpDir, FdMode.Sync, /\.txt$/);

    // Async 모드에서는 비동기적으로 파일 처리
    asyncFileDispatcher.on(FdEventType.Success, (filePath, fileContent) => {
      expect(fileContent).toBe('Async file content');
    });
    const asyncFilePath = path.join(tmpDir, 'async.txt');
    fs.writeFileSync(asyncFilePath, 'Async file content');
    await new Promise((resolve) => setTimeout(resolve, 100)); // 감시 이벤트 처리 대기

    // Sync 모드에서는 동기적으로 파일 처리
    syncFileDispatcher.on(FdEventType.Success, (filePath, fileContent) => {
      expect(fileContent).toBe('Sync file content');
    });
    const syncFilePath = path.join(tmpDir, 'sync.txt');
    fs.writeFileSync(syncFilePath, 'Sync file content');
    await new Promise((resolve) => setTimeout(resolve, 100)); // 감시 이벤트 처리 대기
  });

  test('should stop watching the directory when stop() is called', async () => {
    // 감시 시작
    fileDispatcher.start();

    // 파일 생성 후 확인
    const filePath = path.join(tmpDir, 'test.txt');
    fs.writeFileSync(filePath, 'Test file content');
    await new Promise((resolve) => setTimeout(resolve, 100)); // 감시 이벤트 처리 대기

    // 감시 중지
    fileDispatcher.stop();

    // 파일 이름 변경 후 확인 (감시 중지 상태이므로 이벤트가 발생하지 않아야 함)
    const renamedFilePath = path.join(tmpDir, 'new_name.txt');
    fs.renameSync(filePath, renamedFilePath);
    await new Promise((resolve) => setTimeout(resolve, 100)); // 감시 이벤트 처리 대기
  });

  test('should not start watching the directory again if already started', () => {
    // 감시 시작
    fileDispatcher.start();

    // console.log 함수 대체
    const originalConsoleLog = console.log;
    const consoleLogs: string[] = [];
    console.log = (...args: any[]) => {
      consoleLogs.push(args.join(' '));
    };

    fileDispatcher.start();

    // '[FileDispatcher] Already started.' 메시지가 console.log에 출력되었는지 확인
    expect(consoleLogs).toContain('[FileDispatcher] Already started.');

    // console.log 함수 원래대로 복원
    console.log = originalConsoleLog;
  });

});
