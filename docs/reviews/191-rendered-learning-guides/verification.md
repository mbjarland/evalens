# Rendered learning guides verification

Issue: #191. Reviewed on 2026-09-08.

The five native walkthrough guides now use eight screenshots of the running
extension. Each guide pairs its exercise with prediction steps, default
Windows/Linux and macOS keys, a Command Palette fallback, alternative text,
and a caption explaining the recorded result. The exercise templates and
evaluation behavior are unchanged.

## Capture provenance

The root agent captured the actual installed extension at commit
`3f8627eaa733c028fb11418e3c5d6503fd88ea40` in an isolated VS Code profile on
macOS. VS Code was 1.136.1, arm64. The editor used Default Dark Modern, Menlo
20px, and a 30px line height. Screenshots were captured at twice the CSS
resolution and clipped to the relevant code rows. The images contain genuine
editor text, line numbers, current-line styling, gutter markers, and Evalens
decorations. No annotations were reconstructed or composited into the images.

The temporary capture documents used the packaged exercises, with their
platform-generated comments outside each crop. The only code edits were the
exercise's accumulator correction and stale-answer edit. The root agent and
the implementation agent inspected all eight final images.

[`captures.json`](captures.json) records the source revision, exact source,
visible line ranges, captured annotation strings, screenshot clip bounds, and
PNG hashes. The reproducible actions are also listed in
[`learning-walkthrough.md`](../../development/learning-walkthrough.md).

## Automated verification

Baseline: 962 extension tests and 718 kernel tests.

After this change: **963 extension tests and 718 kernel tests passed**.
The new check verifies guide command titles and Windows/Linux and macOS key
tables against the contributed manifest bindings. Existing checks still
verify platform-generated exercise comments and actual exercise values through
the running Python kernel, including both accumulator histories.

The existing packaging check now follows every Markdown image reference
through the real `vsce ls` output, verifies that its PNG is present and has
drawable dimensions, and checks for alternative text. This guards against
shipping guides whose screenshots exist only in the development checkout.

## Native walkthrough review

The root agent opened all five guides in the actual native walkthrough with
the issue worktree loaded in the Extension Development Host. All eight images
loaded, and both Windows/Linux and macOS key columns were readable. The root
agent inspected every screenshot, including the accumulator's two histories
and the stale-answer before/after pair.

The first aliasing image alternative text included literal Python list
brackets. VS Code's native walkthrough rewrote that image to an empty source;
changing the alternative text to "three-item list" and "four-item list" fixed
the image after reloading. The existing packaging check now guards against
literal square brackets in image alternative text. Detailed list values remain
in the prose and screenshot.

After adding that final guard, the focused learning and packaging checks passed
**14/14**. Opening an exercise from the native guide created an editable
untitled Python document; clicking its code placed the cursor on the first
expression. Its comments contained the platform's default key. All five
walkthrough steps remained unchecked, and opening the exercise did not evaluate
it.

The live check is recorded in
[`native-walkthrough.json`](native-walkthrough.json), with inspected screenshots
of the [prediction guide](native-predict.png),
[accumulator guide](native-accumulator.png), and
[stale-answer guide](native-stale.png).

This review used the guide in a full-width editor group. The native walkthrough
hides its media when the editor group becomes narrow; this change does not
alter VS Code's walkthrough layout. An installed-VSIX repetition follows the
clean commit as the root session's final delivery check.

## Verification limits

No Windows machine was available. Windows/Linux default bindings and generated
comments were checked against the manifest, but physical Windows/Linux keys
were not exercised. The screenshots intentionally contain no platform-specific
key instructions; those remain readable and testable text in the guides.

This was an agent-operated review. No human learner participated, and the
results do not establish learning outcomes or beginner usability.
