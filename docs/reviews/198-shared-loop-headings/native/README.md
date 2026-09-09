# Native acceptance for #198

The coordinating session reviewed implementation `8003abf` in the actual
VS Code Extension Development Host on macOS. `native-results.json` records
the loaded extension path, source revision and nine acceptance scenarios.
All code evaluated was a disposable fixture in this folder.

The review confirmed one shared Variables / Printed output heading, one
About these values control, aligned columns through deeper and sibling
loops, and no repeated timing or parent-context rows. Native Enter and
Space open the help and missing-value Why controls without changing the
source cursor or the recording token. The 100-by-100 example retains both
levels of paging and folded overflow output. The compact owner/source title
appears after its headings scroll away without changing document height.
The whole-result fold is 77px high, matching its source, and preserves the
inner page when reopened.

Dark, light and high-contrast native windows were inspected. At a 560px
window and 28px editor font, the initial implementation squeezed the source
title beside help. The follow-up gives the source a useful preferred width,
so it occupies two lines and help moves below. The final native run checks
title width as well as overflow and visible stacked variable/output labels.
The existing toolbar/disclosure stacking overlap seen while scrolling is
tracked separately in #200.

`native-marketplace-full.png` records the surrounding actual window for the
refreshed `media/demo/nested-loops.png`. The public image is a direct native
element capture with the first outer iteration open and the second folded.
No code, values, chrome or pixels were drawn or retouched. Its dimensions,
hash, fixture and captured text are in `marketplace-capture.json` and the
shared `docs/reviews/196-marketplace-page-refresh/captures.json` manifest.
The other ten public images were not changed.

## Reproduce

Compile the issue checkout with the repository npm cache. Copy `fixtures`
to `/private/tmp/evalens-198/workspace`, and this folder's `bridge` to
`/private/tmp/evalens-198/bridge`. Put `client.cjs`, `verify-native.cjs`, and
`capture-marketplace.cjs` in `/private/tmp/evalens-198`. The helpers record
the exact local paths used in this review; adjust checkout paths for another
machine. Start a dedicated window, after confirming both ports are unused:

```sh
code --new-window \
  --user-data-dir /private/tmp/evalens-198/native-user-data \
  --extensions-dir /private/tmp/evalens-198/extensions \
  --extensionDevelopmentPath="$PWD" \
  --extensionDevelopmentPath=/private/tmp/evalens-198/bridge \
  --remote-debugging-port=9414 --skip-welcome --skip-release-notes \
  --disable-workspace-trust /private/tmp/evalens-198/workspace

node /private/tmp/evalens-198/verify-native.cjs
node /private/tmp/evalens-198/capture-marketplace.cjs
```

Both helpers assert the workspace and loaded extension path before driving
the window. They use only dedicated ports 9414/9415. Run them sequentially;
both drive the same native window. Close that window after review to stop
the local bridge. Do not connect these helpers to a personal profile or
evaluate the maintainer's teaching files.

This is native macOS and keyboard verification, not a physical Windows
keyboard test, human screen-reader session or learner study. The separate
renderer report covers 64 width, font and theme cases. The complete suites
pass 969 extension tests and 718 kernel tests.
