# Contributing

```bash
npm install
npm test            # type-check and run the tests
npm run benchmark   # compare with plain fs.watch
```

Open pull requests against `main`.

## Releasing

1. Update `version` in `package.json` and add a matching `## <version>` section to `CHANGELOG.md` in one commit on `main`.
2. Tag that commit and push both: `git tag v<version> && git push origin main v<version>`. The tag must point to a commit on `main`.

The `Release` workflow runs the tests, publishes to npm with provenance, and creates the GitHub release from the CHANGELOG section. A `-` in the version (for example `4.1.0-rc.1`) publishes under the `next` dist-tag. If a run fails after publishing, re-run it. Run the workflow manually for a dry run.

Publishing uses npm trusted publishing. Before the first release, add a trusted publisher on npmjs.com for the repository `Nhahan/file-dispatcher` and the workflow `release.yml`.
