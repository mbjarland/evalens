# Coherent loop paging and remaining output

Issue: #175. Baseline: master f545020, 902 extension tests and 708 kernel tests.

Every paged loop invocation now uses the same Previous / More iterations
controls and shows the visible ordinal range against its actual iteration
count. Both controls stay visible at page boundaries. More is disabled when
no further captured records exist; a local notice says how many leading
iterations have individual details. A loop's source and enclosing iteration
identify the scope of that navigation. The total visible-entry budget can
shorten a page, and its range now reports only rows actually rendered.

Remaining captured output appears after the owning loop's navigation in its
own full-width section. The heading identifies stdout, stderr, or both;
the source caption identifies its loop and any enclosing iteration. These
sections start folded and retain their independent text pages. No exact
iteration range is guessed for output that can include `else` or other text
outside individual iteration boundaries. Redundant aggregate omission counts
were removed. No kernel, protocol, capture budget or execution trigger changed.

Pages mixing iteration rows with nested invocations outside iterations use
Previous / More rows and explain that distinction. Repeated nested invocations
inside an iteration keep their existing independent pages. If a paging control
becomes disabled after a rebuild, keyboard focus moves to the enabled control
in the same loop instead of disappearing.

## Automated verification

All **907 extension tests** and **708 kernel tests** pass. Five new extension
regressions drive the real kernel over its pipe and inspect the compiled
renderer. They cover the 100×100 allocation cutoff, complete nested traces,
silent partial traces, `for`–`else` output ownership and truthful visible spans
under the 120-entry DOM limit. Existing tests still verify Unicode, separate
streams, chunked text, million-pass bounds, independent sibling and repeated
invocations, source reanchoring, stale state, new evaluation identities and
exact captured export. Existing pagination copy assertions were updated,
including the Latest result regression; that feature is unchanged.

## Actual VS Code verification

The worker ran nine scenarios against the compiled worktree in its own
Extension Development Host on ports 9394/9395. All pass in
[host-results.json](host-results.json). The worker visually inspected
[nested-boundaries.png](nested-boundaries.png).

The 100×100 case confirms the outer strip reads 1–20 of 100 with both controls
disabled, while the last captured inner invocation pages its 59 saved entries
against 100 actual iterations. At 41–59, More disables and focus moves to
Previous. The inner remaining-output section belongs to that inner invocation
within outer Iteration 20. Its root counterpart is a direct child of the outer
loop invocation, outside every iteration group, and starts at `20 0`. Closing
Iteration 20 hides all its inner output. The root output remains independently
folded. Paging and reopening preserve the selected output part; export matches
all 58,000 original captured characters exactly.

The other scenarios cover complete 25×25 paging, silent capture limits,
`for`–`else` text, emoji and stderr, eight sibling loops, 150 repeated
invocations, and long per-iteration output. Sibling headers that exceed the
visible budget reappear when earlier groups close. No user teaching material
was modified or evaluated. Browser-protocol clicks and DOM focus were tested;
physical keyboard input, final merged packaging and CI remain primary-session
checks. Whole-result folding is outside this issue.

## Reproduction

Use the existing [Host bridge and client](../164-nested-loop-explorer/harness)
with the compiled worktree as `--extensionDevelopmentPath`. This run used
`/private/tmp/evalens-175-live`, CDP port 9394 and bridge port 9395. Change those
paths and ports in the bridge, client and
[verify-175.cjs](harness/verify-175.cjs) together if needed. The script creates
and evaluates only its own named fixtures in that private workspace.

The unchanged 2,000-entry shared capture budget still records a chronological
prefix: in 100×100 this saves 20 outer iterations and 59 inner iterations
within the twentieth. Making that sample more evenly distributed requires a
separate capture-policy decision. This change makes the existing boundary
legible rather than implying unavailable records can be recovered by paging.
