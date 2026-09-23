import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';

const root = path.join(__dirname, '..', '..');
const { getChangelogSection, getReleaseNotes, nextPatch, resolvePlan } = require(path.join(root, 'scripts', 'release.js'));
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

const CHANGELOG = ['# Changelog', '', '## 4.1.0', '', '### Added', '', '- New.', '', '## 4.0.0', '', '- Old.', ''].join('\n');

describe('release helpers', () => {
  test('publishes a stable version once and resumes a run that already published it', () => {
    assert.deepEqual(resolvePlan({ version: '4.0.0', kind: 'stable', published: false, build: '' }), {
      version: '4.0.0',
      tag: 'latest',
      publish: true,
    });
    assert.deepEqual(resolvePlan({ version: '4.0.0', kind: 'stable', published: true, build: '' }), {
      version: '4.0.0',
      tag: 'latest',
      publish: false,
    });
    assert.equal(resolvePlan({ version: '4.1.0-rc.1', kind: 'stable', published: false, build: '' }).tag, 'next');
  });

  test('bases prereleases on the next patch once a version is published', () => {
    assert.equal(resolvePlan({ version: '4.1.0', kind: 'beta', published: false, build: '7.1' }).version, '4.1.0-beta.7.1');
    assert.equal(resolvePlan({ version: '4.0.0', kind: 'beta', published: true, build: '7.1' }).version, '4.0.1-beta.7.1');
    assert.deepEqual(resolvePlan({ version: '4.0.0', kind: 'dry-run', published: false, build: '99' }), {
      version: '4.0.0-dryrun.99',
      tag: 'dry-run',
      publish: true,
    });
    assert.equal(nextPatch('4.9.19'), '4.9.20');
  });

  test('builds release notes from the matching CHANGELOG section', () => {
    assert.equal(getChangelogSection(CHANGELOG, '4.1.0'), '### Added\n\n- New.');
    const notes = getReleaseNotes(CHANGELOG, 'file-dispatcher', '4.1.0');
    assert.match(notes, /npm install file-dispatcher@4\.1\.0/);
    assert.doesNotMatch(notes, /Old/);
    assert.throws(() => getReleaseNotes(CHANGELOG, 'file-dispatcher', '9.9.9'), /no "## 9\.9\.9" section/);
  });

  test('CHANGELOG documents the current package version', () => {
    const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
    assert.notEqual(getChangelogSection(changelog, manifest.version), '');
  });
});
