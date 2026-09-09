# Native source capture for #202

`media/demo/nested-loop-code.png` is a direct rectangular capture of actual
Python source rendered in a dedicated native VS Code window on macOS.
`native-source-full.png` records the surrounding window. No source, syntax
colors, background, or pixels were drawn or retouched.

The image uses Menlo at 18px and a 28px line height in Default Dark Modern.
Its 1422-by-272 pixels display at 711-by-136 CSS pixels in the README,
retaining the native 18px text size at the normal Marketplace image width.
The neutral editor background is `#1f1f1f`. The crop includes 16px of native
space before the first character and 12px above and below the four lines.
Native indentation guides remain visible.

The source text was checked against both the open VS Code document and the
rendered editor rows. It exactly matches
`docs/reviews/196-marketplace-page-refresh/fixtures/nested-loops.py`, the
four-line fixture that produced the existing loop-results image. The same
source remains copyable in the README's **Copy this example** disclosure,
before the result image. No source was evaluated for this new capture.

The existing installed Evalens 0.2.0 runtime was loaded from the isolated
`/private/tmp/evalens-198/extensions` directory. The new window uses its own
profile and `/private/tmp/evalens-202/workspace`. The bridge and capture
helper check those paths before driving the window. They only use ports
9424 and 9425; no personal VS Code window or teaching material was opened.

## Reproduce

From this issue's repository checkout, install its development dependencies
with the repository npm cache. Confirm ports 9424 and 9425 are both unused
before starting the dedicated window. These helpers intentionally use the
local review paths; adjust them for a different machine.

```sh
npm --cache /private/tmp/evalens-npm-cache ci
node docs/reviews/202-marketplace-source-styling/native/prepare.cjs

code --new-window \
  --user-data-dir /private/tmp/evalens-202/native-user-data \
  --extensions-dir /private/tmp/evalens-198/extensions \
  --extensionDevelopmentPath=/private/tmp/evalens-202/bridge \
  --remote-debugging-port=9424 --skip-welcome --skip-release-notes \
  --disable-workspace-trust /private/tmp/evalens-202/workspace

node docs/reviews/202-marketplace-source-styling/native/capture.cjs
```

`prepare.cjs` creates the disposable fixture, bridge, and capture profile.
`capture.cjs` records the public PNG, full native window, source and style
measurements, and image hash. It also updates the shared public-image
manifest. Close only this dedicated window after visual acceptance.

The agent inspected the native crop and surrounding window. Both repository
suites passed with the unchanged baseline of 969 extension tests and 718
kernel tests. Runtime files and the existing result images were not changed.
Marketplace-width inspection and packaged-asset checks belong to the
coordinating review; this native capture alone does not verify those.
