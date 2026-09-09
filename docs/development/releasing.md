# Releasing Evalens

Use an issue and its worktree for release changes. Publishing a Marketplace
version is permanent; the maintainer must have explicitly authorized it in
the current task. An existing instruction to publish is that authorization.
The coordinating session merges and publishes; implementation agents commit
their issue branches and report. No PR is required for this workflow.

## Prepare and verify

1. Check the [Marketplace listing](https://marketplace.visualstudio.com/items?itemName=mbjarland.evalens)
   for the current versions and channels. Pick a higher version in
   `package.json` and both root-version fields in `package-lock.json`.
   Update `CHANGELOG.md` and the user guide's versioned VSIX examples.
2. Run both suites in the issue worktree. Commit the release changes with
   `refs #N`; the ticket stays open until publication has been verified.
3. Merge into `master`, rerun both suites, push, and check CI. Start packaging
   only when `git status --porcelain` is empty. Record `git rev-parse HEAD`.

```bash
npm --cache /private/tmp/evalens-npm-cache ci
npm --cache /private/tmp/evalens-npm-cache test
npm --cache /private/tmp/evalens-npm-cache run test:kernel
```

Package the committed version into a location outside the checkout, using
the release commit for relative README image and documentation links. A
branch such as `master` moves after publication; it can silently replace a
published release's images with pictures of newer behavior:

```bash
release_commit=$(git rev-parse HEAD)
npm --cache /private/tmp/evalens-npm-cache run package -- \
  --githubBranch "$release_commit" --out /private/tmp/evalens-0.2.0.vsix
```

Replace `0.2.0` with the committed version. For a stable release, omit
`--pre-release` from both packaging and publishing. Do not pass a version
argument to `vsce publish`: publish the exact VSIX that was tested.

Inspect the ZIP contents: publisher/name/version, compiled extension and
kernel, icon, README, changelog, learning resources and images. Confirm its
manifest does not mark it as a pre-release. `.vscodeignore` excludes source,
tests and internal docs; it deliberately includes `CHANGELOG.md`. Compare
packaged files to the committed checkout, allowing only documented generated
metadata and rewritten README links. Inspect the packaged README's links,
including raw HTML attributes: image URLs must use that release commit,
documentation must resolve to GitHub, and no example may resolve relative to
the Marketplace host. The full user guide is linked on GitHub; it is not
bundled into the extension because `docs/**` is excluded.

Review the page at the Marketplace's approximately 711px content width and
at a narrower width. A loaded image is not enough: its values and labels
must be readable at the displayed size. Public screenshots must show the
actual extension running in VS Code. Keep source fixtures, capture method,
image dimensions and hashes together in a review manifest; the current set
is documented in `docs/reviews/196-marketplace-page-refresh/captures.json`.
Start a later asset refresh from the
[native capture instructions](../reviews/196-marketplace-page-refresh/README.md)
and helpers, using disposable source fixtures and an isolated VS Code profile. The former `npm run stills` simulated-editor generator has
been removed; it must not overwrite native screenshots.
Tests check asset integrity and link coverage, while actual native and page
inspection establishes what the pictures show. Do not replace real captures
with a simulated editor or generated illustration.

Install the VSIX and verify the loaded extension path and version in a real
VS Code window. Exercise evaluation, advance, panel navigation, loop folds
and pages, recorded-text actions and learning images using disposable
fixtures. Verify installed files against the VSIX. Record the artifact's
SHA-256, test counts, installation evidence and any platform or human checks
not performed. Do not execute the maintainer's teaching files as fixtures.

## Authenticate and publish

Use the local credential store or a locally supplied `VSCE_PAT`; never paste
a token into chat, commit it, or put it in a shell command argument. When
needed, run the interactive login locally:

```bash
./node_modules/.bin/vsce login mbjarland
./node_modules/.bin/vsce verify-pat mbjarland
```

With authorization and the verified artifact ready:

```bash
./node_modules/.bin/vsce publish --packagePath /private/tmp/evalens-0.2.0.vsix
```

Wait for Marketplace processing, then check the public version and confirm
it is a regular release. Verify installation from the Marketplace in an
isolated VS Code profile. A successful upload alone is not that check.
Record the release commit, artifact hash, live listing, version/channel and
verification limits on the issue; then close it, set its board status to
Done, and clear in-progress or blocked mirror labels. Clean up only the
release worktree and branch
after confirming they are clean, merged and pushed.

The [VS Code publishing guide](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)
describes authentication, pre-release channels and Marketplace processing.
