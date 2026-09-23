'use strict';

// Release helpers used by .github/workflows/release.yml.
//   node scripts/release.js plan <beta|dry-run|stable>  -> JSON { version, tag, publish }
//   node scripts/release.js notes [version]             -> GitHub release notes from CHANGELOG.md
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

function readManifest() {
  return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
}

function readChangelog() {
  return fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
}

function nextPatch(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) {
    throw new Error(`Cannot compute the next patch version of ${version}.`);
  }
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

/**
 * Decides what a release run publishes. Prereleases of an already published version would sort
 * below it, so they build on the next patch version. A stable version that is already on npm is not
 * published again, so a run that failed after publishing can be re-run to finish the GitHub release.
 */
function resolvePlan({ version, kind, published, build }) {
  if (kind === 'stable') {
    return { version, tag: version.includes('-') ? 'next' : 'latest', publish: !published };
  }

  const base = published && !version.includes('-') ? nextPatch(version) : version;
  const suffix = `${kind === 'beta' ? 'beta' : 'dryrun'}.${build}`;
  return {
    version: base.includes('-') ? `${base}.${suffix}` : `${base}-${suffix}`,
    tag: kind === 'beta' ? 'beta' : 'dry-run',
    publish: true,
  };
}

function isPublished(name, version) {
  try {
    return (
      execFileSync('npm', ['view', `${name}@${version}`, 'version'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
      }).trim() !== ''
    );
  } catch (error) {
    const output = `${error.stdout || ''}${error.stderr || ''}`;
    if (output.includes('E404')) {
      return false;
    }
    throw new Error(`Unable to check ${name}@${version} on npm:\n${output}`);
  }
}

function getChangelogSection(changelog, version) {
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `## ${version}`);
  if (start === -1) {
    return '';
  }
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  return lines.slice(start + 1, end === -1 ? undefined : end).join('\n').trim();
}

function getReleaseNotes(changelog, name, version) {
  const section = getChangelogSection(changelog, version);
  if (!section) {
    throw new Error(`CHANGELOG.md has no "## ${version}" section.`);
  }
  return [
    section,
    '',
    '### Install',
    '',
    '```bash',
    `npm install ${name}@${version}`,
    '```',
    '',
    `Published to npm with provenance: https://www.npmjs.com/package/${name}/v/${version}`,
    '',
  ].join('\n');
}

function main([command, argument] = process.argv.slice(2)) {
  const manifest = readManifest();

  if (command === 'plan') {
    const kind = argument;
    if (!['beta', 'dry-run', 'stable'].includes(kind)) {
      throw new Error('Usage: node scripts/release.js plan <beta|dry-run|stable>');
    }
    // Every kind checks what a stable release of this version needs, so a dry run proves it.
    getReleaseNotes(readChangelog(), manifest.name, manifest.version);
    const published = isPublished(manifest.name, manifest.version);
    const build =
      kind === 'beta'
        ? `${process.env.GITHUB_RUN_NUMBER || '0'}.${process.env.GITHUB_RUN_ATTEMPT || '1'}`
        : process.env.GITHUB_RUN_ID || 'local';
    process.stdout.write(`${JSON.stringify(resolvePlan({ version: manifest.version, kind, published, build }))}\n`);
    return;
  }

  if (command === 'notes') {
    process.stdout.write(getReleaseNotes(readChangelog(), manifest.name, argument || manifest.version));
    return;
  }

  throw new Error('Usage: node scripts/release.js <plan|notes> [argument]');
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

module.exports = {
  getChangelogSection,
  getReleaseNotes,
  nextPatch,
  resolvePlan,
};
