# Releasing

Versions come from git. Nobody edits `package.json` `version` or
`package-lock.json` for a task, so parallel branches no longer conflict on them.

## Version sources

`scripts/version.js` is the only place that resolves the version. The build and
the test harness use the first of these that is set:

1. `STEWARD_VERSION` in the environment (CI sets it for a release build).
2. `git describe --tags --match "v[0-9]*" --dirty`, with the leading `v`
   removed, for example `0.10.14-3-gabc1234-dirty`: three commits after tag
   `v0.10.14`, on a dirty tree.
3. `package.json` `version`, the placeholder `0.0.0-git`, for a checkout
   without git or tags. It is never bumped, so the `steward@0.0.0-git` line npm
   prints before a build is not the bundle version; the build's own last line is.
   The updater reads any 0.0.0 version as unversioned and never offers it an update.
4. `0.0.0`.

Tags are the version record. A release build made on a tagged commit reads
exactly `0.10.14`.

## Commit trailer

The next version is the latest `v*` tag plus a bump level taken from the
commits since that tag. A line `Bump: minor` or `Bump: major` anywhere in a
commit message (the body, a squash or a merge message) sets the level. The
highest level wins. No line means patch.

- `Bump: minor`: a new module or a massive redesign.
- `Bump: major`: rare.
- no line: a bugfix or smaller feature (patch).

Put it above `Assisted-by: Claude`. Commit subjects carry no version suffix.

## What CI does

The Release workflow (`.github/workflows/release.yml`) runs lint and tests,
then `scripts/release.js` decides.

- Push to `main` with a pending minor or major bump and untagged HEAD: CI builds
  the bundle with `STEWARD_VERSION`, creates tag `vX.Y.Z` and a GitHub Release
  with `build/user_steward.js` and notes made from the commit subjects since the
  last tag.
- Push to `main` with only patch commits: no release.
- Patch release: run the Release workflow from the Actions tab ("Run workflow",
  on `main`), or push a tag yourself:
  `git tag -a vX.Y.Z -m "..." && git push origin vX.Y.Z`. A pushed tag always
  produces the release for that tag.

CI never commits or pushes to a branch. Only `contents: write` is granted, for
the tag and release.

## PR builds

The CI workflow (`.github/workflows/ci.yml`) runs on every PR, drafts
included. It builds the PR's head commit (not GitHub's merge commit), so the
bundle's `git describe` version, for example `0.12.2-3-gabc1234`, names a commit
on the branch. The bundle is uploaded before lint and tests run, as the
artifact `user_steward-<version>` (a zip holding `user_steward.js`, kept 14
days), so it can be tested in the client even while lint or a test is red.

A second job keeps one comment on the PR, marked `<!-- steward-ci-bundle -->`
and edited in place on every push, with the version, the artifact link, the run
link and whether lint and tests passed. Only that job gets
`pull-requests: write`. A PR from a fork gets a read-only token, so it skips the
comment and keeps only the artifact on the run page. A new push cancels the
PR's running check; runs on `main` always finish.

Per-PR prereleases were rejected: they need `contents: write` on PR code, and
the in-game updater reads this repository's releases.

## What the in-game updater depends on

The updater module reads the GitHub Releases of this repository and installs the
asset it finds. Three conventions are therefore a contract; changing any of
them breaks updates for every installed client:

- The tag shape `v<semver>`, for example `v0.10.14`.
- The release asset name `user_steward.js`.
- The banner line ` * Steward v<ver>` at the top of the bundle, which the
  updater compares with the release tag before it writes the file.

The banner is written by `banner()` in `scripts/build.js`, and
`tests/modules/updater-install.test.js` builds its fixture from that function.
A wording change there therefore fails the test, not every installed client.

## Dry run

`npm run release` prints the last tag, the commit count, the bump level, the
next version and the notes. It changes nothing: no files, tags or pushes.
`node scripts/release.js --at vX.Y.Z` shows the notes for an existing tag.

## After a CI release

CI creates the tag on the server. Run `git fetch --tags` so local
`git describe` (and so the dev build version) catches up.
