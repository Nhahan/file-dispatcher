'use strict';

// Release helpers used by .github/workflows/release.yml.
//   node scripts/release.js version <beta|dry-run|stable>  -> prints the version to publish
//   node scripts/release.js notes [version]                -> prints GitHub release notes from CHANGELOG.md
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

function readManifest() {
  return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
}

function nextPatch(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) {
    throw new Error(`Cannot compute the next patch version of ${version}.`);
  }
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

/**
 * Prereleases of an already published version would sort below it, so they build on the next
 * patch version instead. Stable releases must not exist yet.
 */
function resolvePublishVersion({ version, kind, published, build }) {
  if (kind === 'stable') {
    if (published) {
      throw new Error(`${version} is already published. Bump the version before releasing again.`);
    }
    return version;
  }

  const base = published && !version.includes('-') ? nextPatch(version) : version;
  const suffix = `${kind === 'beta' ? 'beta' : 'dryrun'}.${build}`;
  return base.includes('-') ? `${base}.${suffix}` : `${base}-${suffix}`;
}

function isPublished(name, version) {
  try {
    return execFileSync('npm', ['view', `${name}@${version}`, 'version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    }).trim() !== '';
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

  if (command === 'version') {
    const kind = argument;
    if (!['beta', 'dry-run', 'stable'].includes(kind)) {
      throw new Error('Usage: node scripts/release.js version <beta|dry-run|stable>');
    }
    const published = kind !== 'dry-run' && isPublished(manifest.name, manifest.version);
    process.stdout.write(
      `${resolvePublishVersion({
        version: manifest.version,
        kind,
        published,
        build:
          kind === 'beta'
            ? `${process.env.GITHUB_RUN_NUMBER || '0'}.${process.env.GITHUB_RUN_ATTEMPT || '1'}`
            : process.env.GITHUB_RUN_ID || 'local',
      })}\n`,
    );
    return;
  }

  if (command === 'notes') {
    const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
    process.stdout.write(getReleaseNotes(changelog, manifest.name, argument || manifest.version));
    return;
  }

  throw new Error('Usage: node scripts/release.js <version|notes> [argument]');
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
  resolvePublishVersion,
};
