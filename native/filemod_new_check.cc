#include <node.h>
#include <string>
#include <iostream>
#include <mutex>

#ifdef _WIN32 // Windows
  #include <windows.h>

  bool IsFileModified(const std::string& filePath) {
    return PerformFileOperation(filePath);
  }

#elif defined(__APPLE__) // macOS
  #include <sys/stat.h>

  bool IsFileModified(const std::string& filePath) {
    return PerformFileOperation(filePath);
  }

#else // Linux
  #include <sys/stat.h>

  bool IsFileModified(const std::string& filePath) {
    return PerformFileOperation(filePath);
  }

#endif

bool PerformFileOperation(const std::string& filePath) {
  static std::mutex mtx;
  std::lock_guard<std::mutex> lock(mtx);

  bool isModified = false;

#ifdef _WIN32 // Windows
  FILETIME creationTime, lastWriteTime;
  HANDLE hFile = OpenAndLockFile(filePath);
  if (hFile != INVALID_HANDLE_VALUE) {
    isModified = GetFileTimes(hFile, creationTime, lastWriteTime);
    CloseHandle(hFile);
  }

#elif defined(__APPLE__) // macOS
  struct stat fileStat;
  if (stat(filePath.c_str(), &fileStat) == 0) {
    isModified = CompareFileTimes(fileStat.st_ctimespec, fileStat.st_mtimespec);
  }

#else // Linux
  struct stat fileStat;
  if (stat(filePath.c_str(), &fileStat) == 0) {
    isModified = CompareFileTimes(fileStat.st_ctime, fileStat.st_mtime);
  }

#endif

  return isModified;
}

#ifdef _WIN32 // Windows
HANDLE OpenAndLockFile(const std::string& filePath) {
  HANDLE hFile = CreateFile(
      filePath.c_str(),
      GENERIC_READ,
      FILE_SHARE_READ,
      NULL,
      OPEN_EXISTING,
      FILE_ATTRIBUTE_NORMAL,
      NULL);

  if (hFile == INVALID_HANDLE_VALUE) {
    std::cerr << "Failed to open file: " << GetLastError() << std::endl;
  }

  return hFile;
}

bool GetFileTimes(HANDLE hFile, FILETIME& creationTime, FILETIME& lastWriteTime) {
  if (!GetFileTime(hFile, &creationTime, NULL, &lastWriteTime)) {
    std::cerr << "Failed to get file time: " << GetLastError() << std::endl;
    return false;
  }

  ULARGE_INTEGER creationTimeValue;
  creationTimeValue.HighPart = creationTime.dwHighDateTime;
  creationTimeValue.LowPart = creationTime.dwLowDateTime;

  ULARGE_INTEGER lastWriteTimeValue;
  lastWriteTimeValue.HighPart = lastWriteTime.dwHighDateTime;
  lastWriteTimeValue.LowPart = lastWriteTime.dwLowDateTime;

  return creationTimeValue.QuadPart < lastWriteTimeValue.QuadPart;
}

#elif defined(__APPLE__) // macOS

bool CompareFileTimes(const timespec& creationTime, const timespec& lastWriteTime) {
  return creationTime.tv_sec < lastWriteTime.tv_sec;
}

#else // Linux

bool CompareFileTimes(const time_t& creationTime, const time_t& lastWriteTime) {
  return creationTime < lastWriteTime;
}

#endif

void IsFileModified(const v8::FunctionCallbackInfo<v8::Value>& args) {
  v8::Isolate* isolate = args.GetIsolate();

  if (args.Length() < 1 || !args[0]->IsString()) {
    isolate->ThrowException(v8::Exception::TypeError(
        v8::String::NewFromUtf8(isolate, "Invalid argument")));
    return;
  }

  v8::String::Utf8Value filename(args[0]);
  std::string filePath(*filename);

  bool isModified = false;
  try {
    isModified = IsFileModified(filePath);
  } catch (const std::exception& e) {
    isolate->ThrowException(v8::Exception::TypeError(
        v8::String::NewFromUtf8(isolate, e.what())));
    return;
  }

  args.GetReturnValue().Set(v8::Boolean::New(isolate, isModified));
}

void Initialize(v8::Local<v8::Object> exports) {
  NODE_SET_METHOD(exports, "isFileModified", IsFileModified);
}

NODE_MODULE(NODE_GYP_MODULE_NAME, Initialize)
