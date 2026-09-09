# Stacked printed output clears loop guides

Issue: [#207](https://github.com/mbjarland/evalens/issues/207).

Only the existing stacked-layout container rule changes. Printed cells now
keep their variable cell's nesting inset. Populated parent rows and direct
parent output use the parent inset, including at deeper levels. The wide
layout, guides, capture semantics, output order and folds are unchanged.

Baseline `58eb629` and the fix both pass **972 extension tests and 718 kernel
tests**, following a fresh `npm ci` in the issue worktree.

`verify-renderer.cjs` uses #205's real-kernel and compiled-renderer approach,
with four fresh disposable kernels. It reproduces **36 printed label/text
readings entering the guide gutter before the fix, and zero afterward**.
Actual text rectangles are compared with each vertically overlapping guide;
both labels and printed text must remain at least 7 px to its right.

The cases cover the approved base fixture, missing parent-body readings,
three levels with body readings, and three levels with direct output but no
body reading. Viewports are 480 and 560 px at a 28 px editor font, 480 px at
16 px, and 1400 px at 20 px. All remain within the viewport width. At narrow
widths, variable and printed text start together. At the wide width, the
entire measured text/guide geometry equals the baseline exactly.

`before-geometry.json` and `after-geometry.json` contain the measurements.
The four `after-*-480-28.png` images were rendered from saved real kernel
responses and inspected. `before-*-480-28.png` records the initial overlap;
the primary native failure is separately recorded by the main session in
`/private/tmp/evalens-release-refresh/native/geometry-inspection.png`.

Run the geometry regression from the compiled issue worktree:

```sh
npm --cache /private/tmp/evalens-npm-cache test
npm --cache /private/tmp/evalens-npm-cache run test:kernel
node docs/reviews/207-stacked-loop-guide-gutter/verify-renderer.cjs
```

The browser defaults to the macOS Chrome installation; `EVALENS_CHROME_PATH`
can select another compatible Chromium executable. To reproduce the initial
failure, use the baseline renderer with this script and `--expect-overlap`.
No replacement layout CSS is injected; the page receives theme variables.

This worker inspected compiled Chromium rendering. The main session owns
the rebuilt VSIX and native installed verification; those steps are pending
at this commit. Public images, copy, version and capture code are untouched.
