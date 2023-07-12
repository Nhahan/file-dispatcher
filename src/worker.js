const { parentPort, workerData } = require("worker_threads");
const path = require("path");

parentPort?.on('message', async (filePath) => {
  try {
    const filemodPath = workerData.i ? path.resolve(__dirname, 'filemod-async.node') : path.resolve(__dirname, 'filemod-sync.node');
    const filemod = require(filemodPath);
    const content = filemod.newFileContent(filePath);
    content && parentPort?.postMessage({ filePath, content });
  } catch (error) {
    console.error('Worker processing error:', error);
  }
});
