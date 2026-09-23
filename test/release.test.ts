import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';

const root = path.join(__dirname, '..', '..');
const { getChangelogSection, getReleaseNotes, resolvePlan } = require(path.join(root, 'scripts', 'release.js'));
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

const CHANGELOG = ['# Changelog', '', '## 4.1.0', '', '### Added', '', '- New.', '', '## 4.0.0', '', '- Old.', ''].join('\n');

describe('release helpers', () => {
  test('publishes the version named by the tag once, and resumes a run that already published it', () => {
    assert.deepEqual(resolvePlan({ version: '4.0.0', kind: 'stable', gitTag: 'v4.0.0', published: false }), {
      version: '4.0.0',
      tag: 'latest',
      publish: true,
    });
    assert.equal(resolvePlan({ version: '4.0.0', kind: 'stable', gitTag: 'v4.0.0', published: true }).publish, false);
    assert.equal(resolvePlan({ version: '4.1.0-rc.1', kind: 'stable', gitTag: 'v4.1.0-rc.1', published: false }).tag, 'next');
    assert.throws(
      () => resolvePlan({ version: '4.0.0', kind: 'stable', gitTag: 'v4.0.1', published: false }),
      /Tag v4\.0\.1 does not match package\.json version 4\.0\.0/,
    );
    assert.throws(
      () => resolvePlan({ version: '4.0.0', kind: 'stable', gitTag: 'v4.0.0', published: true, publishedHead: 'aaa', sha: 'bbb' }),
      /already on npm from aaa, but v4\.0\.0 points to bbb/,
    );
    assert.equal(
      resolvePlan({ version: '4.0.0', kind: 'stable', gitTag: 'v4.0.0', published: true, publishedHead: 'aaa', sha: 'aaa' }).publish,
      false,
    );
  });

  test('dry runs publish a unique prerelease under the dry-run tag', () => {
    assert.deepEqual(resolvePlan({ version: '4.0.0', kind: 'dry-run', published: false, build: '99' }), {
      version: '4.0.0-dryrun.99',
      tag: 'dry-run',
      publish: true,
    });
    assert.equal(resolvePlan({ version: '4.1.0-rc.1', kind: 'dry-run', published: false, build: '99' }).version, '4.1.0-rc.1.dryrun.99');
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
