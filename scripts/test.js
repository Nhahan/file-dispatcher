'use strict';

// Runs compiled tests. Node 20 has no glob support in `node --test`, and shells differ on
// wildcard expansion, so the test files are listed here.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const testDir = path.join(__dirname, '..', '.test-dist', 'test');
const files = fs
  .readdirSync(testDir)
  .filter((file) => file.endsWith('.test.js'))
  .map((file) => path.join(testDir, file));

// A hung test fails after two minutes, and handles a failed test left open do not keep the run alive.
const result = spawnSync(process.execPath, ['--test', '--test-timeout=120000', '--test-force-exit', ...process.argv.slice(2), ...files], {
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
