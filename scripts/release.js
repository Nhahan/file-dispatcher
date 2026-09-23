'use strict';

// Release helpers used by .github/workflows/release.yml.
//   node scripts/release.js plan stable <tag>   -> JSON { version, tag, publish } for a v<version> tag
//   node scripts/release.js plan dry-run        -> JSON for a dry run of the current version
//   node scripts/release.js notes [version]     -> GitHub release notes from CHANGELOG.md
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

/**
 * Decides what a release run publishes. A version already on npm is not published again, so a run
 * that failed after publishing can be re-run to finish the GitHub release; it must have been
 * published from the tagged commit.
 */
function resolvePlan({ version, kind, gitTag, published, publishedHead, sha, build }) {
  const distTag = version.includes('-') ? 'next' : 'latest';
  if (kind === 'stable') {
    if (gitTag !== `v${version}`) {
      throw new Error(`Tag ${gitTag} does not match package.json version ${version}; expected v${version}.`);
    }
    if (published && publishedHead && sha && publishedHead !== sha) {
      throw new Error(`${version} is already on npm from ${publishedHead}, but ${gitTag} points to ${sha}.`);
    }
    return { version, tag: distTag, publish: !published };
  }

  return {
    version: version.includes('-') ? `${version}.dryrun.${build}` : `${version}-dryrun.${build}`,
    tag: 'dry-run',
    publish: true,
  };
}

/** Returns the published version's git commit ('' if npm did not record one), or undefined if unpublished. */
function publishedHead(name, version) {
  try {
    const output = execFileSync('npm', ['view', `${name}@${version}`, 'version', 'gitHead', '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    }).trim();
    if (output === '') {
      return undefined;
    }
    const view = JSON.parse(output);
    return typeof view === 'object' && view !== null ? String(view.gitHead || '') : '';
  } catch (error) {
    const output = `${error.stdout || ''}${error.stderr || ''}`;
    if (output.includes('E404')) {
      return undefined;
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

function main([command, kind, gitTag] = process.argv.slice(2)) {
  const manifest = readManifest();

  if (command === 'plan') {
    if (kind !== 'stable' && kind !== 'dry-run') {
      throw new Error('Usage: node scripts/release.js plan <stable <tag>|dry-run>');
    }
    // A dry run checks what a release of this version needs, so it proves the release would work.
    getReleaseNotes(readChangelog(), manifest.name, manifest.version);
    const head = kind === 'stable' ? publishedHead(manifest.name, manifest.version) : undefined;
    const plan = resolvePlan({
      version: manifest.version,
      kind,
      gitTag,
      published: head !== undefined,
      publishedHead: head,
      sha: process.env.GITHUB_SHA,
      build: process.env.GITHUB_RUN_ID || 'local',
    });
    process.stdout.write(`${JSON.stringify(plan)}\n`);
    return;
  }

  if (command === 'notes') {
    process.stdout.write(getReleaseNotes(readChangelog(), manifest.name, kind || manifest.version));
    return;
  }

  throw new Error('Usage: node scripts/release.js <plan|notes> [arguments]');
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
  resolvePlan,
};
