# Marketplace page refresh — native capture evidence

The stable 0.2.0 page uses eleven actual VS Code captures. The main page
shows inline results, the Values panel, the nested-loop explorer, and the
native learning walkthrough. The detailed user guide uses the other seven
inline examples as well as the hero. No editor chrome, code, or result pixels
were recreated or retouched. The old simulated screenshot generator was
removed so it cannot overwrite these images.

`captures.json` records each source fixture, PNG dimensions and hash, native
clip rectangle, and inspected output. Captures use device scale factor 2.
The main images were captured at 620, 742, 713 and 524 CSS pixels wide;
inline reference images are at most 856 CSS pixels wide. They replace wide
captures whose labels shrank below legibility in the Marketplace column.
The nested-loop screenshot crops the actual result surface; the panel image
also shows source, linking and the independent Latest result marker.

`learning-guide-native.png` separately records the actual wide walkthrough
with its embedded native image and Mac-first shortcuts. It verifies
Cmd+Enter (Ctrl+Enter on Windows/Linux) and Cmd+Shift+P (Ctrl+Shift+P on
Windows/Linux) as rendered by VS Code. The five existing learning guides
retain their eight actual extension screenshots. Physical Windows keypresses
and human screen-reader or learner usability sessions were not performed.

## Capture again

The helpers use a disposable workspace and profile, port 9354 for the native
window and a loopback command bridge on 9355. Close earlier review hosts using
those ports first. Never point these helpers at a personal VS Code profile.
The bridge can run commands and change the disposable profile's editor
settings; it is review tooling, excluded from the VSIX.

From a clean issue worktree, install dependencies and compile:

```sh
npm --cache /private/tmp/evalens-npm-cache ci
npm --cache /private/tmp/evalens-npm-cache run compile
node docs/reviews/196-marketplace-page-refresh/harness/prepare.cjs
```

Open the real Extension Development Host with that worktree as the extension:

```sh
code --new-window \
  --user-data-dir /private/tmp/evalens-196/user-data \
  --extensions-dir /private/tmp/evalens-196/extensions \
  --extensionDevelopmentPath="$PWD" \
  --extensionDevelopmentPath=/private/tmp/evalens-196/bridge \
  --remote-debugging-port=9354 --skip-welcome --skip-release-notes \
  --disable-workspace-trust /private/tmp/evalens-196/workspace
```

Run the helpers sequentially; they drive one native window. The code capture
starts a new manifest, then the panel and learning captures extend it.

```sh
node docs/reviews/196-marketplace-page-refresh/harness/capture-code.cjs
node docs/reviews/196-marketplace-page-refresh/harness/capture-panels.cjs
node docs/reviews/196-marketplace-page-refresh/harness/capture-learning.cjs
```

The screenshots capture only these small, disposable examples. The watch
example adds `n * 2` through the real Add Inline Watch input. The loop example
folds its second outer iteration through the actual disclosure control.
Opening the learning walkthrough does not execute its exercise. The helpers
move the mouse out of the result to avoid recording incidental hover styling.
Close the disposable host after capturing, which also stops its bridge.

Review every image visually and at the width used in the Marketplace. Run
both repository suites. PNG hashes and link checks detect accidental changes;
they do not prove a native origin, semantic correctness, or legibility.
Future runtime changes require a fresh native review before these images are
claimed to represent a new release.

## Marketplace layout review

The unpublished README was rendered locally inside the actual public
Marketplace page using its existing styles. The browser did not upload or
change server content. `marketplace-preview.json` records a 711px content
column at a 1360px viewport and a 488px column at 900px. All five images
(including the icon) loaded at both sizes; the document had no horizontal
overflow. The adjacent preview screenshots record those two layouts.

At normal Marketplace width, main result labels render at approximately
15–18px. Smaller windows scale the screenshots; each image remains a PNG
that can be opened at full size. The page replaces three broken raw HTML
relative links with Markdown links that vsce rewrites to the release commit.
The release artifact is checked separately for those rewritten URLs and for
stable-channel metadata.
