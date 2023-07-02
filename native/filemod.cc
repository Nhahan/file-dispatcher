#include <node.h>
#include <string>
#include <iostream>
#include <fstream>
#include <sstream>

bool FetchFileTimesAndContent(const std::string& filePath, std::string& fileContent);
bool CompareFileTimes(const timespec& creationTime, const timespec& lastWriteTime);

std::string NewFileContent(const std::string& filePath) {
  std::string fileContent;
  if (FetchFileTimesAndContent(filePath, fileContent)) {
    return fileContent;
  }
  return "";
}

#ifdef _WIN32
  #include <windows.h>

  HANDLE OpenAndLockFile(const std::string& filePath);
  bool GetFileTimes(HANDLE hFile, FILETIME& creationTime, FILETIME& lastWriteTime);
  bool FetchFileTimesAndContent(const std::string& filePath, std::string& fileContent) {
    FILETIME creationTime, lastWriteTime;
    HANDLE hFile = OpenAndLockFile(filePath);
    if (hFile != INVALID_HANDLE_VALUE) {
      if (GetFileTimes(hFile, creationTime, lastWriteTime)) {
        ULARGE_INTEGER creationTimeValue;
        creationTimeValue.HighPart = creationTime.dwHighDateTime;
        creationTimeValue.LowPart = creationTime.dwLowDateTime;

        ULARGE_INTEGER lastWriteTimeValue;
        lastWriteTimeValue.HighPart = lastWriteTime.dwHighDateTime;
        lastWriteTimeValue.LowPart = lastWriteTime.dwLowDateTime;

        if (creationTimeValue.QuadPart == lastWriteTimeValue.QuadPart) {
          std::ifstream inFile(filePath);
          std::stringstream strStream;
          strStream << inFile.rdbuf();
          fileContent = strStream.str();
          inFile.close();
          return true;
        }
      }
      CloseHandle(hFile);
    }
    return false;
  }

#elif defined(__APPLE__)
  #include <sys/stat.h>

  bool CompareFileTimes(const timespec& creationTime, const timespec& lastWriteTime);
  bool FetchFileTimesAndContent(const std::string& filePath, std::string& fileContent) {
    struct stat fileStat;
    if (stat(filePath.c_str(), &fileStat) == 0) {
      if (CompareFileTimes(fileStat.st_ctimespec, fileStat.st_mtimespec)) {
        std::ifstream inFile(filePath);
        std::stringstream strStream;
        strStream << inFile.rdbuf();
        fileContent = strStream.str();
        inFile.close();
        return true;
      }
    }
    return false;
  }

#else
  #include <sys/stat.h>

  bool CompareFileTimes(const time_t& creationTime, const time_t& lastWriteTime);
  bool FetchFileTimesAndContent(const std::string& filePath, std::string& fileContent) {
    struct stat fileStat;
    if (stat(filePath.c_str(), &fileStat) == 0) {
      if (CompareFileTimes(fileStat.st_ctime, fileStat.st_mtime)) {
        std::ifstream inFile(filePath);
        std::stringstream strStream;
        strStream << inFile.rdbuf();
        fileContent = strStream.str();
        inFile.close();
        return true;
      }
    }
    return false;
  }

#endif

void NewFileContent(const v8::FunctionCallbackInfo<v8::Value>& args) {
  v8::Isolate* isolate = args.GetIsolate();

  if (args.Length() < 1 || !args[0]->IsString()) {
    isolate->ThrowException(v8::Exception::TypeError(
        v8::String::NewFromUtf8(isolate, "Invalid argument").ToLocalChecked()));
    return;
  }

  v8::String::Utf8Value filename(isolate, args[0]);
  std::string filePath(*filename);

  std::string fileContent = NewFileContent(filePath);

  args.GetReturnValue().Set(v8::String::NewFromUtf8(isolate, fileContent.c_str()).ToLocalChecked());
}

void Initialize(v8::Local<v8::Object> module) {
  v8::Local<v8::Object> exports = v8::Object::New(module->GetIsolate());

  NODE_SET_METHOD(exports, "newFileContent", NewFileContent);

  auto maybeSet = module->Set(
      module->GetIsolate()->GetCurrentContext(),
      v8::String::NewFromUtf8(module->GetIsolate(), "exports").ToLocalChecked(),
      exports);

  if (maybeSet.IsNothing()) {
    std::cerr << "Failed to set module exports." << std::endl;
  }
}

NODE_MODULE(NODE_GYP_MODULE_NAME, Initialize)
