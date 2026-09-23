# Contributing

## Development

```bash
npm install
npm test            # type-check and run the tests
npm run benchmark   # compare with plain fs.watch
```

## Branches

- `main` is the release branch. Every push publishes a `beta` prerelease to npm.
- `dev` is the integration branch.
- `ci-verify/<topic>` branches are for GitHub Actions changes. Promote them to `dev` as logical Conventional Commits.

## Releasing

1. In one commit, set the new version in `package.json` and add a matching `## <version>` section to `CHANGELOG.md`. Tests fail when the section is missing.
2. Merge it to `main`, then run the `Release` workflow manually with `dry_run` unchecked.
3. The workflow publishes to npm with provenance through trusted publishing (OIDC) and creates the `v<version>` GitHub release from the CHANGELOG section.

Betas published from `main` use the next patch version once the current version is released, so they never sort below it.
