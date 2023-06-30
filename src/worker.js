const fs = require('fs');
const {parentPort} = require("worker_threads");

parentPort?.on('message', async ({ task, interceptor }) => {
  try {
    let content = await fs.promises.readFile(task.filePath, 'utf8');
    if (interceptor) content = interceptor(task.filePath, content);
    parentPort?.postMessage({ filePath: task.filePath, content });
  } catch (error) {
    console.error('Worker file processing error:', error);
  }
});
