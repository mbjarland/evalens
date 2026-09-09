# Learning documentation acceptance for #206

The Marketplace example and user guide now show the approved aligned nested
loop layout with matching source. Iteration 1 is folded with `base = 0` in
its summary. Iteration 2 is open with `base = 10` beside printed `base: 10`,
a short guide to the inner loop, and `y`/`v` readings beside the printed
pairs. Both pages put dark native source imagery and a copyable example
before the result. The eval·lens branding and editorial voice are retained.

## Native evidence

The two public PNGs were captured from runtime commit
`e81ff994c4db747cf8088f34538de9f4a6374abf` after reloading its dedicated native
VS Code Extension Development Host. The helper asserted the loaded extension
path and disposable workspace before driving it. Source and rendered editor
text exactly match `nested-loops-base.py`; the same six lines are copyable in
README and the user guide. Only this disposable fixture was evaluated.

| Image | Native pixels | Normal display |
| --- | --- | --- |
| `media/demo/nested-loop-code.png` | 1422 × 384 | 711 × 192, 18px Menlo |
| `media/demo/nested-loops.png` | 1424 × 606 | 711 × 303, approximately 16px Menlo |

The source uses the native Default Dark Modern background and syntax colors.
Occurrence and selection highlighting were disabled only in the disposable
capture profile. The result keeps its neutral background and orange bar.
No pixels, values, or chrome were drawn or retouched.

The coordinating session visually accepted the native draft. The final
captures after the runtime commit have identical image bytes to that draft.
`native/captures.json` records source, fold state, guides, geometry, hashes,
and runtime revision. The complete native windows are
`native/native-source-full.png` and `native/native-result-full.png`.
`native/previous-captures.json` preserves the replaced images' metadata;
the original four-line fixture remains intact.

## Page and asset checks

`preview.cjs` renders the README inside the actual public Marketplace page's
CSS with the new local image bytes. It also creates a standalone preview
with the same `ms-Fabric` typography ancestor and a user-guide preview.
The measured live and standalone typography match: 14px body text, the same
Segoe UI font stack, and the same heading and copyable-code sizes.

Both source examples precede their results and match the fixture exactly.
README content was checked at 711px and 488px; the user-guide loop section
was checked at those same widths. Images fit the content area and retain
their aspect ratios. The agent inspected both Marketplace sizes and the
normal-width guide. The PNGs and `marketplace-preview.json` record these
checks; the coordinating session owns final merged-page acceptance.

`audit.md` lists the affected copy and images. `asset-audit.json` confirms
that only the two nested-loop public PNGs changed: the other ten demo images
and all eight walkthrough images retain their exact previous bytes. The
walkthrough screenshots were visually checked; none contains the nested
explorer. Existing screenshot-integrity and documentation-link tests cover
the updated manifest and references.

The developer vocabulary entry also resolves #204 by keeping capture timing
under the single About these values disclosure. Missing readings and capture
limits remain visible. Two outdated loop comments in the demonstration
files were corrected without changing their Python statements.

## Verification limits

The documentation worktree passes **969 extension tests and 718 kernel
tests**, unchanged from its supplied baseline. It was branched before the
runtime work; the coordinating session reruns the combined runtime and
documentation suites after integration. This change adds no runtime code.
Native capture was on macOS, not a physical Windows keyboard or human
screen-reader session. Packaging, commit-pinned image URLs, and the final
installed VSIX are checked by the coordinating release review. No
Marketplace upload was performed by this worktree.

## Reproduce

The scripts deliberately use the local review paths. Confirm ports 9434
and 9435 are unused before launching this dedicated window; adjust the paths
for another machine. The disposable profile must not replace personal VS
Code settings.

```sh
npm --cache /private/tmp/evalens-npm-cache ci
node docs/reviews/206-loop-learning-refresh/native/prepare.cjs

code --new-window \
  --user-data-dir /private/tmp/evalens-206/native-user-data \
  --extensions-dir /private/tmp/evalens-206/extensions \
  --extensionDevelopmentPath=/Users/mbjarland/projects/evalens-worktrees/205-aligned-loop-guides \
  --extensionDevelopmentPath=/private/tmp/evalens-206/bridge \
  --remote-debugging-port=9434 --skip-welcome --skip-release-notes \
  --disable-workspace-trust /private/tmp/evalens-206/workspace

EVALENS_CAPTURE_DRAFT=1 node docs/reviews/206-loop-learning-refresh/native/capture.cjs
node docs/reviews/206-loop-learning-refresh/native/capture.cjs
node docs/reviews/206-loop-learning-refresh/preview.cjs "$PWD"
```

Draft capture writes only to `/private/tmp/evalens-206/draft`. Final capture
updates the two public PNGs and their shared manifest after all native
checks pass. The helper accepts the runtime checkout as its first argument;
it must match the loaded extension path. After a runtime change, reload only
this dedicated host before capturing again. Close only this window after
review to stop its bridge.
