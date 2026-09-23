'use strict';

// Compares plain fs.watch with dispatch() while another process creates files in a burst.
// Usage: node scripts/benchmark.js [--files=10000] [--size=4096] [--work-us=0] [--rounds=3]
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { dispatch } = require('../dist');

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, value] = arg.replace(/^--/, '').split('=');
    return [key, Number(value)];
  }),
);
const FILES = args.files || 10_000;
const SIZE = args.size || 4096;
// Busy time per delivered file, simulating a listener that parses or forwards content.
const WORK_US = args['work-us'] || 0;
const ROUNDS = args.rounds || 3;
const QUIET_MS = 5000;
const TIMEOUT_MS = 120_000;

function busy() {
  if (WORK_US === 0) return;
  const until = process.hrtime.bigint() + BigInt(WORK_US * 1000);
  while (process.hrtime.bigint() < until);
}

function createFiles(dir) {
  const script = `
    const fs = require('fs'); const path = require('path');
    const body = 'x'.repeat(${SIZE});
    for (let i = 0; i < ${FILES}; i++) fs.writeFileSync(path.join(${JSON.stringify(dir)}, 'file-' + i + '.txt'), body);
  `;
  return new Promise((resolve, reject) => {
    const writer = spawn(process.execPath, ['-e', script], { stdio: 'inherit' });
    writer.on('error', reject);
    writer.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`writer exited with ${code}`))));
  });
}

// Reads each file on its 'rename' event, as code built on fs.watch usually does.
function watchWithFs(dir, record) {
  const seen = new Set();
  const watcher = fs.watch(dir, (event, name) => {
    if (event !== 'rename' || !name || seen.has(name)) return;
    let content;
    try {
      content = fs.readFileSync(path.join(dir, name), 'utf8');
    } catch {
      return;
    }
    seen.add(name);
    record(name, content);
  });
  return () => watcher.close();
}

function watchWithDispatcher(dir, record) {
  const dispatcher = dispatch(dir, async (file) => record(file.name, await file.text()), { concurrency: 16 });
  return () => dispatcher.close();
}

async function measure(label, watch) {
  // The real path avoids a libuv abort when fs.watch gets a Windows 8.3 short path.
  const dir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'file-dispatcher-bench-'));
  const delivered = new Map();
  let lastDeliveryAt = Date.now();
  const stop = watch(dir, (name, content) => {
    busy();
    delivered.set(name, content.length === SIZE);
    lastDeliveryAt = Date.now();
  });

  // Give the platform watcher time to attach before the burst starts.
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const started = Date.now();
  await createFiles(dir);
  const written = Date.now();

  while (delivered.size < FILES && Date.now() - Math.max(lastDeliveryAt, written) < QUIET_MS && Date.now() - started < TIMEOUT_MS) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  await stop();
  fs.rmSync(dir, { recursive: true, force: true });

  const complete = [...delivered.values()].filter(Boolean).length;
  return { complete, incomplete: delivered.size - complete, missed: FILES - delivered.size, ms: lastDeliveryAt - started };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

// Results vary between runs on shared CI machines, so report the median of several rounds.
async function measureRounds(label, watch) {
  const rounds = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    rounds.push(await measure(label, watch));
  }
  return {
    label,
    complete: median(rounds.map((round) => round.complete)),
    incomplete: median(rounds.map((round) => round.incomplete)),
    missed: median(rounds.map((round) => round.missed)),
    ms: median(rounds.map((round) => round.ms)),
    completeByRound: rounds.map((round) => round.complete).join('/'),
  };
}

async function main() {
  const results = [
    await measureRounds('fs.watch', watchWithFs),
    await measureRounds('file-dispatcher', watchWithDispatcher),
  ];

  console.log(
    `${process.platform} ${os.arch()} Node ${process.version}: ${FILES} files x ${SIZE} B, ${WORK_US} us per file, median of ${ROUNDS} rounds`,
  );
  console.table(results);
  console.log(JSON.stringify({ platform: process.platform, files: FILES, size: SIZE, workUs: WORK_US, rounds: ROUNDS, results }));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
