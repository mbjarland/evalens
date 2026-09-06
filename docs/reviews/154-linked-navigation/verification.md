# Linked navigation verification — #154

Verified on 2026-09-06 in a real macOS Extension Development Host, using
an isolated user-data directory and extension directory. The fixture contained
65 lines with assignments, a compound statement, an unannotated blank line
and output tall enough to overflow the Values pane. The compiled extension
ran its real Python kernel to populate the trace.

The live run checked editor-to-panel reveal without focus theft, no scrolling
for an already-visible target, actual row clicks and ArrowDown key events,
retained keyboard focus on Values rows, and the follow-cursor checkbox.
With cursor following off, passive navigation preserved independent browsing
and Enter still revealed source. Compound-body matching, blank-line clearing,
large output already spanning the viewport, keeping a closed panel hidden,
reopening at the current cursor, and clearing results also passed.

The screenshots show the same source and Values row selected in
[dark](dark.png), [light](light.png), and [high contrast](high-contrast.png).
Both implementation and review agents inspected these actual Host captures.
The frames remain prominent without shifting source text; the Values arrow
provides an additional cue. This is an agent visual check, not a learner
usability study or a screen-reader review.

The [navigation recording](navigation.mp4) (819 KB, 10.6 seconds) and the
three screenshots are committed evidence. The raw local capture is at
`/private/tmp/evalens-154-live/navigation.webm`, with the run's assertion
summary at `/private/tmp/evalens-154-live/results.json`.
Editor selections were driven through the real VS Code API because Electron's
native editor did not honor synthetic keyboard events. Physical editor
arrow-key interaction, Windows/Linux, and screen-reader behavior were not
verified. Actual DOM keyboard events in the Values pane were verified.

Automated suites passed: **801 extension tests** (baseline 790) and
**674 kernel tests** (baseline 674). Added coverage executes the generated
webview script, checks provider navigation and marker lifecycle, and exercises
compound, stale and error results through the real kernel. Final settings and
README checks also passed (28 tests).
