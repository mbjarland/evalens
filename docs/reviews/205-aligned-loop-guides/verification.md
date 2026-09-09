# Aligned nested-loop guides

Issue: [#205](https://github.com/mbjarland/evalens/issues/205). The visual
decision is the right-hand Aligned N in
`docs/reviews/203-nested-loop-tree-guides/n-alignment-comparison.png` on the
`203-nested-loop-tree-guides` branch.

The renderer aligns Variables, outer iteration captions, expanded outer-body
readings and the first inner loop heading. Disclosure triangles occupy their
own gutter. Inner readings indent further; printed text keeps one column edge.
Neutral guides connect outer groups and stop at each inner heading, seven
pixels before its text. Later siblings receive local elbows, so their guides
do not run through the earlier sibling's readings. Deeper groups repeat that
local arrangement.

Folded captions include saved body readings. Expanded groups place those
readings above the child loop, beside the original pre-child output. The
readings remain end-of-iteration snapshots: changing `base` after the child
loop can produce `base = 99` beside printed `4`. About these values and the
reading's accessible name explain that timing. Missing readings keep their
local Why control. No kernel protocol or capture behavior changed.

## Checks

Baseline `436634b` passed 969 extension tests and 718 kernel tests after a
fresh `npm ci`. The implementation passes 972 extension tests and 718 kernel
tests. The 46 loop tests include three new regressions for expanded/folded
body rows, saved-end and missing snapshots, and paging sibling invocations
without repeating output from the first page. Existing large-loop, Unicode,
capture-limit, navigation, reanchor and stale-control checks still pass,
including the existing 20,000-character initial 100-by-100 HTML bound.

`verify-renderer.cjs` evaluates five disposable fixtures in fresh real Python
kernels, closes each kernel, then passes their saved responses through the
compiled panel renderer in Chromium. Browser interactions cannot evaluate
again because those kernels are already closed. The script checks:

- Actual text ranges at 16, 20 and 28 px with 980 and 1400 px viewports;
  common Variables and printed-output edges whenever both columns fit.
- Short-guide endpoints at the inner heading's text center, with a 7 px gap;
  a local second-sibling elbow and the same pattern through three levels.
- The approved first-folded, second-expanded six-line fixture, including
  `base = 10`, printed `base: 10`, and the three `y`/`v` rows.
- Narrow layouts at 300 and 560 px, at 16 and 28 px: body readings remain
  visible and printed output stacks below with its own label.
- Keyboard selection of the body reading, distinct target/body focus keys,
  whole-result folding that clears and restores guides, and iteration folds
  that keep original output ordering. There are no browser script errors.

The actual renderer screenshots were inspected: `renderer-base.png`,
`renderer-siblings.png`, `renderer-deep.png`, `renderer-changed.png` and
`renderer-missing.png`. `renderer-results.json` records their geometry;
`renderer-base.html` preserves one complete rendered document. Theme variables
come from the extension's contributed dark colors. No substitute layout CSS
is used in these captures.

Reproduce from the issue worktree:

```sh
npm --cache /private/tmp/evalens-npm-cache ci
npm --cache /private/tmp/evalens-npm-cache test
npm --cache /private/tmp/evalens-npm-cache run test:kernel
node docs/reviews/205-aligned-loop-guides/verify-renderer.cjs
```

The browser script defaults to the macOS Chrome installation; set
`EVALENS_CHROME_PATH` to another compatible Chromium executable if needed.

## Verification boundary

The implementation worker verified real kernel data and compiled Chromium
rendering, not an installed extension package. The main session inspected
#206's native VS Code draft and confirmed the primary approved layout. Final
native acceptance, public screenshot provenance and installed-package checks
belong to the main session and #206. Physical Windows interaction and a human
screen-reader session were not performed by this worker.
