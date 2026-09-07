# Nested-loop explorer verification

Issue: #164, bounded nested-loop exploration. User selected X5 on 2026-09-07.
Y2's shared amber result surface is inherited from master 5a230b7.

## Automated acceptance

Baseline: 841 extension tests and 678 kernel tests. The completed branch has
857 extension tests and 691 kernel tests. All pass on Python 3.11.6; all 691
kernel tests also pass on Python 3.9.25, the supported floor.

`kernel/test_loop_explorer.py` drives the real kernel pipes. It checks explicit
parent identity for silent/repeated/sibling iterations, three nested levels,
`continue`, `break`, user `finally`, iterator and `else` output, stderr, errors,
watch/file requests, capture exhaustion, and no additional user `repr` calls.
The 5,000-name unpacking fixture confirms target-name metadata does not bypass
the statement budget. A loop in `else` retains parent-invocation identity when
there is no active parent iteration. An async instrumentation fixture closes
all retained entries at each tested allocation boundary.

`src/test/loopExplorer.test.ts` uses real kernel replies and the compiled
renderer. It checks exact Unicode slices and parentage, separate final values,
flat fallback, capture notices, repeated nested invocations reached through
pages, stderr-only counts, mixed `else` pagination, and known silent intervals
after stdout retention is exhausted. The real million-iteration fixture
retains exactly 2,000 combined entries, with metadata below 400,000 bytes;
initial HTML is below 6,000 characters and the expanded first page below
20,000. The huge-output fixture retains 65,536 Unicode characters per stream
and places less than 24,000 HTML characters in its expanded view.

Provider tests exercise actual evaluation commands with a simulated VS Code
API: prefix edits preserve folds and shift both source links and line labels;
intersecting edits withdraw navigation; re-evaluation resets folds. Failed
single/file evaluations retain their original printed text under the error.
Flat million-character values and multiline output cap expanded text at
16,000 UTF-16 units in a scrolling container and offer `Show more` when an
expansion cannot show everything. Original captured output remains available.

## Actual VS Code Host acceptance

The primary session drove VS Code 1.136.1 on macOS arm64 through the isolated
Extension Development Host, with the compiled issue branch loaded. All ten
cases in [x5-host-results.json](x5-host-results.json) pass. Both the primary
session and the implementation agent inspected [the small-run screenshot](x5-small-host.png):
the shared bar is amber, iteration headings are gold with blue disclosures,
values and printed output occupy separate columns, silent leaves say
`No output`, and final values sit separately below the iterations.

The Host checks exercise exact stdout export, source selection and keyboard
folding without moving the editor cursor, Unicode and repeated sibling values,
100-page output per iteration with bounded paging, one million nested
iterations, the last of eight sibling groups, the last page of 150 repeated
inner invocations, loop `else` placement, separate stderr counts/export, known
silent iterations after capture fills, and prefix-edit reanchoring while
preserving folds. The million-iteration view initially has 25 DOM elements and
328 visible characters; the large-output view has 74 elements and 717 visible
characters. Screenshots of both are retained beside this document.

The harness uses only its own generated Python fixtures. It does not evaluate
the maintainer's teaching files. These Host checks use browser-protocol input;
they are not a claim about physical keyboard dispatch or a final installed
package. Final package and remaining theme/regression acceptance belong to
the primary session before issue closure.

## Reproducing the Host checks

The [harness](harness/) is preserved here because the original temporary copy
was lost in a computer restart. Its scripts use the repository path
`/Users/mbjarland/projects/evalens`, scratch root
`/private/tmp/evalens-learning-live`, CDP port 9354 and bridge port 9355.
Adjust those explicit paths for another machine. `prepare.cjs` writes only the
isolated scratch profile and fixtures; it copies the current user's keybinding
file into that profile, without changing the source file.

Copy the four scripts to the scratch root, run `node prepare.cjs`, then launch:

```sh
code --new-window \
  --user-data-dir /private/tmp/evalens-learning-live/user-data \
  --extensions-dir /private/tmp/evalens-learning-live/extensions \
  --extensionDevelopmentPath=/Users/mbjarland/projects/evalens-worktrees/164-nested-loop-explorer \
  --extensionTestsPath=/private/tmp/evalens-learning-live/bridge.cjs \
  --remote-debugging-port=9354 --skip-welcome --skip-release-notes \
  --disable-workspace-trust /private/tmp/evalens-learning-live/workspace
node /private/tmp/evalens-learning-live/verify-x5.cjs
```

Compile the selected extension path first. The final command writes the JSON
results and screenshots in the scratch root; `browser.disconnect()` leaves the
Host available for further checks. A reload closes this test-mode Host, so
relaunch it with the same command after recompiling. The browser focus
emulation in `client.cjs` is required for reliable background rendering.

## Additional actual Host regression checks

The final compiled build also passed the long single-line and multiline
output checks: initial text is bounded, expanded text contains at most
16,000 UTF-16 units inside a 235.2px scrolling area, and Open in editor
exposes the full retained 60,000/50,000-character outputs.

An output-only Y2 row has a 20px result surface, with its printed label
starting 3px below the top (padding only) and the amber bar intact.
Cursor movement from source line 1 to line 60 and back scrolls each matching
Values row fully into the viewport. Measurements are in
[panel-regression-results.json](panel-regression-results.json); rerun
`harness/verify-panel-regressions.cjs` in the same isolated Host.


## Node 20 acceptance follow-up

The first merged CI run exposed an eager allocation in the existing inline
formatter: collecting every `Intl.Segmenter` record for the unchanged
million-character Values fixture exhausted Node 20's 4 GB heap before the
panel could fold it. The formatter now retains only a grapheme count and the
prefix boundary. ASCII uses an exact linear scan, treating CRLF as one
grapheme; Unicode still uses ICU segmentation, streamed without collecting
records. The original Unicode boundaries, omitted counts, and wire-truncation
notices stay intact.

The new regression runs with the current test runtime in a separate process
limited to a 96 MB heap. It checks one million ASCII characters, 1.2 million
characters of CRLF text, and 30,000 graphemes mixing flags, combining accents,
and family ZWJ emoji. The original million-character panel fixture is unchanged.
A measured Node 20.20.2 million-character preview takes about 13 ms, with about
4.2 MB heap used and 40 MB RSS; [node20-preview.json](node20-preview.json)
records a repeat measurement. Exact timings vary by machine.

Full extension suites pass on Node 26.8.1 (857 tests) and Node 20.20.2 (858
reported tests, including an extra empty harness-file subtest counted by that
runner). All 691 kernel tests pass again on Python 3.11.6. The earlier complete
Python 3.9.25 run remains applicable: this follow-up changes only TypeScript
formatting, one test, and evidence.

## Installed-package themes

The primary session tested the installed package from master d6c89f7 in Dark
Modern, Light Modern, High Contrast and High Contrast Light, and inspected all
four screenshots. [theme-results.json](theme-results.json) records the expected
amber bars and distinct heading/disclosure text colors. Screenshots are the
four `x5-installed-*.png` files; `harness/verify-themes.cjs` reproduces the
checks. That package precedes the bounded inline-preview follow-up above;
the follow-up leaves layout and theme styling unchanged. The primary session
will package the corrected commit for final installation.


## Approved background refinement

After reviewing the installed screenshots, the maintainer chose a neutral
background for X5. Nested-loop rows and their shared result surface now use
the panel background, including when the source cursor follows that row.
The orange evaluated bar, grey stale bar and stale explanation, statement
navigation frame, and local selected-iteration fill remain. Ordinary Y2
results retain their existing tint. The preceding installed screenshots
record the earlier fill; the primary session is checking the refined build.

## Approved neutral background

The maintainer approved removing the large result tint after seeing the live
explorer. The final compiled Host shows transparent row and result surfaces,
retains the amber bar and statement frame, and applies a local fill/outline
to the selected iteration. Ordinary Y2 result tints remain. Measurements are
in [background-results.json](background-results.json); the final appearance
is [x5-neutral-background-host.png](x5-neutral-background-host.png). Earlier
theme images above verify the palette before this background refinement.
