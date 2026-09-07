# Nested-loop folding correction

Issue: #166. Baseline: master e3eafe7, 857 extension tests and 691 kernel tests.

The reported 100-by-100 nested print loop retains detail through outer value
`x = 19`. The separately captured tail starts at `20 0`; it is not output from
the last visible iteration. That tail now starts behind **Output without
retained iteration detail**. Opening it pages captured text using the existing
20-line and 2,000 UTF-16-unit limits. Text that was never captured keeps its
omission notice and is not offered as an expandable disclosure.

Opening an outer iteration directly shows the first page of its only inner
invocation. Eight sibling invocations and 150 repeated invocations still have
independent controls and remain reachable. Long output within an iteration
keeps its own fold. The kernel, capture limits, original stream, neutral X5
background, amber bar and source-selection behavior are unchanged.

## Automated verification

All 861 extension tests and 691 kernel tests pass. Four regression tests were
added to `src/test/loopExplorer.test.ts`, which drives the real kernel and the
compiled renderer. The focused explorer file passes all 19 tests.

The new checks verify the exact 10,000-line original stream, no initially
visible raw output with all groups folded, independent fallback output pages,
one-click access to inner rows, retained long-output folds, Unicode/stdout/
stderr separation, and honest omission notices after output capture fills.
The provider test uses the simulated VS Code API with a real kernel: gap folds
and pages survive prefix edits and collapse/reopen, a new evaluation resets
both, old-render messages are ignored, and browsing does not move the cursor.

The existing real-kernel cases retain coverage for silent iterations, true
`else` output placement, one million iterations, eight siblings, 150 repeated
invocations, capture bounds and exact parent IDs.

## Actual Host acceptance

The primary session drove the actual isolated VS Code Extension Development
Host against compiled commit `046993b`. All four checks in
[host-results.json](host-results.json) pass. Both sessions inspected the
[folded view](folded.png) and [single-click inner table](one-click.png): the
20 outer headings start collapsed with no raw output, the separately labeled
output disclosure remains closed, and opening an outer iteration reveals
`y = 0` through `y = 19` without another invocation arrow. The neutral
background and amber bar remain.

Actual Host controls replace the inner page with rows 21–40, close all output
when its parent closes, and retain the selected fallback output page across
collapse/reopen. Enter toggles the fallback disclosure while preserving its
keyboard focus and source cursor. Opening captured stdout produces exactly
58,000 characters and 10,000 lines, matching the original stream.

All ten inherited X5 Host scenarios also pass; results are recorded in
[x5-regression-results.json](x5-regression-results.json). These include the
last of eight sibling groups, the last page of 150 repeated invocations,
one million iterations under the visible-entry budget, large output,
Unicode, separate stderr export, true loop `else` ownership, known silent
iterations after capture exhaustion, and prefix-edit reanchoring.

The Host uses browser-protocol input against generated fixtures, not the
maintainer's teaching files. Physical keyboard dispatch, the final installed
package and CI remain the primary session's final acceptance work.

## Reproducing the checks

Use the existing [X5 Host setup](../164-nested-loop-explorer/verification.md#reproducing-the-host-checks)
and its [client.cjs](../164-nested-loop-explorer/harness/client.cjs), with the
extension development path set to the compiled `166-nested-loop-folds`
worktree. The Host bridge uses ports 9354 and 9355 and scratch root
`/private/tmp/evalens-learning-live` on this machine. Update those paths for
another machine.

Copy [harness/verify-166.cjs](harness/verify-166.cjs) beside `client.cjs` in that
scratch root. Create `workspace/x5-100x100.py` there with this fixture:

```python
for x in range(100):
    for y in range(100):
        print(x, y)
```

With the isolated Host running, execute:

```sh
node /private/tmp/evalens-learning-live/verify-166.cjs
```

The harness writes its four-case JSON and two screenshots under `/private/tmp`.
For the inherited scenarios, copy and run the existing
[verify-x5.cjs](../164-nested-loop-explorer/harness/verify-x5.cjs). Its million-
iteration expectation now asserts that the redundant invocation toggle is
absent before paging the immediately visible inner rows. The other nine
scenarios are unchanged.
