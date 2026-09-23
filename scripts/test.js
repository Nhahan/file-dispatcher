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

const result = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
