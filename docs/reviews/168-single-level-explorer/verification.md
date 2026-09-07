# Single-level loop explorer

Issue: #168. Baseline: master c552548, 870 extension tests and 700 kernel tests.

Supported single-level `for` loops now use the existing bounded explorer
capture. Short target/output pairs render as compact rows. At most three
logical lines and 160 characters across stdout and stderr stay visible;
larger iteration output starts folded. Nested-loop thresholds and grouping
remain unchanged. No command, setting, protocol shape or evaluation trigger
was added. Single-loop inline body histories and saved hover still use the
existing trace, rather than inventing body-variable readings for each row.

## Automated verification

All 877 extension tests and 708 kernel tests pass. Seven extension regressions
exercise the real kernel, compiled renderer and loaded extension with a
simulated VS Code API. Eight kernel regressions verify target/output pairing,
body history retention, continue/break/finally, empty-loop else ownership,
unsupported/disabled/failure fallbacks, a million passes and single async-for
boundaries. A direct comparison with the prior single-loop instrumentation
checks identical iterator/body events, output, repr calls and body histories.

The provider tests verify manual output folds/pages, page replacement, source
selection after a prefix edit, resetting after a new evaluation and rejection
of obsolete controls. Existing nested tests retain their previous thresholds,
parent ownership, bounded output, omission notices and independent sibling
folds. The ordinary flat-output expansion test now uses one multiline print
expression, since a supported single-level `for` deliberately enters the
explorer instead.

## Actual VS Code acceptance

The primary session ran ten scenarios against this worktree in the isolated
Extension Development Host. All pass in [host-results.json](host-results.json).
Both sessions inspected [single-level.png](single-level.png): three compact
`n`/square-output rows, no individual disclosure arrows, a transparent result
surface and a square orange leading bar. Actual interactions verify source
selection, saved hover, exact stream export, silent and skipped iterations,
empty-loop else output, short multiline output, Unicode/stderr separation,
100-pass paging, million-pass bounds, long-output folds/pages and reanchoring.

The inherited Host checks also pass:

- [Source-associated inline histories](inherited-165-results.json).
- [Nested folding and exact 10,000-line export](inherited-166-results.json).
- [All ten X5 scenarios](inherited-x5-results.json), including eight siblings,
  150 repeated invocations, output capture exhaustion, Unicode and else.

These checks use browser-protocol input and our own fixtures. They do not
execute the maintainer's teaching files. Physical keyboard input, the final
merged package and CI remain the primary session's integration checks.

## Reproducing the Host checks

Use the existing [X5 Host setup](../164-nested-loop-explorer/verification.md#reproducing-the-host-checks)
and [client.cjs](../164-nested-loop-explorer/harness/client.cjs), pointing the
Host's extension development path at the compiled `168-single-level-explorer`
worktree. The local bridge uses ports 9354/9355 and scratch root
`/private/tmp/evalens-learning-live`. Adjust paths for another machine.

Copy the [fixtures](fixtures) into that scratch root's `workspace` directory
and [verify-168.cjs](harness/verify-168.cjs) beside `client.cjs`. Run:

```sh
node /private/tmp/evalens-learning-live/verify-168.cjs
```

The harness writes its result JSON under `/private/tmp`. It temporarily edits
the dedicated reanchor fixture in the editor, then reverts that change.
