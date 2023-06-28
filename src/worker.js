const fs = require('fs');
const {parentPort} = require("worker_threads");

parentPort?.on('message', async ({ filePath }) => {
    try {
        const content = await fs.promises.readFile(filePath, 'utf8');
        parentPort?.postMessage({ filePath, content });
    } catch (error) {
        console.error('Worker file processing error:', error);
    }
});
