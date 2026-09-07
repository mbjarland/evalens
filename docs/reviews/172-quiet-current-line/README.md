# Quiet source navigation (#172)

The selected design is C's short square amber gutter tick plus E's neutral
current-line wash, slightly stronger than the mockup. It replaces the blue
frames around every line of the selected statement.

The source marker follows the exact active line inside an annotated statement,
including inner loop headers and body lines. A panel source link marks the line
it reveals. The existing visible-panel lifecycle remains: unmatched lines,
hidden/disposed views, switching editors and clearing results remove the mark.
The source marker does not indicate which statement most recently evaluated.

`evalens.currentLineBackground` contributes a neutral wash in all four theme
kinds. Its dark default is white at 13/255 opacity, approximately `#292929`
over `#1e1e1e`; native editor decorations can also contribute to that surface.
No foreground override, source border or user editor-setting change is applied.

The gutter tick occupies x=1..3.5 in the existing 16-pixel icon space. State
symbols keep their original geometry at x=6..10. On a line that needs both,
one combined SVG contains both shapes so competing gutter images cannot hide
either meaning. Body and inner-header lines use the tick alone. Moving away
restores the evaluated/stale/error symbol. The SVGs have the same light/dark
selection as the existing state assets.

Finished statements no longer retain a source background tint. Their result,
state symbol and overview-ruler mark persist. Pending, input, success flash and
selection-snap feedback retain their existing ranges and lifetime.
`evalens.evaluatedRegionBackground` still colors the overview-ruler mark and
temporary selection-snap highlight.

## Automated verification

The compiled extension uses the real kernel through the existing fake-editor
harness. Focused checks cover exact compound/body ranges, stale/error targets,
gutter state transitions, nested lines, prefix edits, scrollbar retention and
the existing visibility/clear/editor-switch/no-evaluation navigation cases.
The color asset check also verifies that every combined/plain icon exists.

- Extension baseline: 877 tests. Branch: 880 tests, all passing.
- Kernel baseline: 708 tests. Branch: 708 tests, all passing.
- Focused panel, color and README checks: 97 tests, all passing.

These checks prove ranges, options, state and actual captured results. Actual
pixel placement and theme appearance were separately inspected in the Host.

## Actual Host inspection

The main session drove an isolated Extension Development Host against this
worktree and inspected Dark Modern, Light Modern, Default High Contrast and
Default High Contrast Light. It verified one wash and tick on the exact inner
header, body and root lines. Syntax foregrounds matched the pre-change token
colors exactly. The source frames and permanent teal fill were absent.

The combined evaluated glyph and standalone tick remained visible. Selecting
an inner iteration in the panel marked the inner header. An unrelated line,
hiding the panel and clearing results removed both markers; reopening the
panel restored them. See [the recorded results](host-results.json) and
[the captured Host](current-line.png). Stale/error composition and prefix
edits were covered in the automated harness; their actual pixel appearance
was not separately exercised in this Host run.

The reproduction script and client are under `harness/`; `fixtures/` contains
the agent-owned Python input. They expect the existing isolated Host bridge on
ports 9354/9355 and scratch workspace `/private/tmp/evalens-learning-live/`.
The script compares foregrounds against `source-baseline.json` copied to
`/private/tmp/evalens-source-baseline.json`. Neither the script nor this review
authorizes execution of teaching/user files.

## Further acceptance checks

Use agent-owned short and nested loop fixtures, including silent and error
statements. Check header/body movement, panel iteration source links, an
unrelated line, hiding/reopening the view, switching files, clearing results,
and prefix/body edits. Exactly one source line should have the tick and wash;
successful surrounding source should retain its original syntax/background.

Check the current tick beside stale/error glyphs at normal editor size.
Verify custom current-line wash colors in an isolated profile, and verify that
brief pending/success feedback still clears normally. These checks were not
part of the recorded Host run; neither behavior was changed by this branch.
