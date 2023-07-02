const { parentPort, workerData } = require("worker_threads");

parentPort?.on('message', async (filePath) => {
  try {
    const filemodPath = workerData.filemodPath;
    const filemod = require(filemodPath);

    const content = filemod.newFileContent(filePath);
    content && parentPort?.postMessage({ filePath, content });
  } catch (error) {
    console.error('Worker processing error:', error);
  }
});
