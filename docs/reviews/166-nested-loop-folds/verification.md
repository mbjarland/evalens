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

The primary session owns the isolated VS Code Host and is verifying the
compiled issue worktree with the reported example. Automated renderer tests
alone do not prove the installed panel or physical keyboard behavior. Actual
Host evidence and final package acceptance will be recorded before closure.
