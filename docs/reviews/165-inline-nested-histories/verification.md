# Inline nested-loop histories (#165)

Verified 2026-09-07 in the issue worktree, based on `e3eafe7`.

- Extension suite: **866 passed**, up from 857 (+9).
- Kernel suite: **700 passed**, up from 691 (+9).
- Actual VS Code Extension Development Host: **10 scenarios passed**. The
  main session drove the Host through its local command bridge and inspected
  the screenshot; the worker also inspected the captured screenshot.
- No user teaching files or global settings were changed. All execution used
  the isolated fixtures copied into this directory.

The 100×100 screenshot shows the outer `x ×100` history and its captured
output on the first header, and `y ×10,000 total` on the inner header, with
matching orange bars and existing name/value colours. The inner hover says
`10000 iterations total across 100 loop runs`. Counts survive the explorer's
2,000-entry detail limit, because each source recorder supplies them directly.

`host-results.json` and `harness/verify-165.cjs` retain the complete assertions:
uniform and varying loops, empty versus unreached loops, early exit, reused
names, three levels, source reanchoring, own-edit withdrawal, stale undo,
clear, fresh evaluation and a following `print(y)` after Evaluate File. The
last case guards against hidden final snapshots incorrectly suppressing a
later value as already shown.

The automated suites also check 64 source sites and the flat fallback beyond
that bound, a 50-value wire head despite oversized manual requests, no added
user `repr()` calls, pending ownership, dependency staleness, malformed
metadata and source-specific saved hovers. Nested capture uses the existing
explicit evaluation; browsing and rendering add no evaluation requests.

## Repeat the checks

Run `npm --cache /private/tmp/evalens-npm-cache test` and
`npm --cache /private/tmp/evalens-npm-cache run test:kernel` from the worktree.

For the actual-editor harness, copy `harness/*` to
`/private/tmp/evalens-learning-live/` and `fixtures/*` into its `workspace/`.
Launch an isolated VS Code Host with the worktree as
`--extensionDevelopmentPath`, `harness/bridge.cjs` as `--extensionTestsPath`,
CDP port 9354 and that isolated workspace. The bridge listens on loopback
port 9355. Run `node /private/tmp/evalens-learning-live/verify-165.cjs`.
The copied client resolves Puppeteer from the main checkout; adjust its path
on another machine. These helpers are verification artifacts, not shipped
extension features.

## Remaining integration verification

The worker did not merge, push or install a VSIX. The main session must rerun
both suites after integrating the independent #166/#167 panel changes and
verify the final installed package. No physical-key dispatch changes were
made or independently retested for #165. User visual sign-off remains the
maintainer's decision; the recorded screenshot is actual-editor evidence,
not a claim that the maintainer has approved the new layout.
