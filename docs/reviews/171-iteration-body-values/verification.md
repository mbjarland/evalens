# Loop-body values in their own iterations

Issue: #171. Base: `f1a6fd0` (`178-hide-inline-values` included).
Verified on 2026-09-07 with the real Python pipe, compiled extension, and an
isolated VS Code Extension Development Host loading this issue worktree.

The example now shows `v = 1, u = 4`, `v = 2, u = 8`, and
`v = 3, u = 12` in the values column, beside the separate printed output.
[The Host screenshot](body-values.png) was inspected by the main session and
implementation worker. The amber square bar, neutral loop background,
current-row marker, Latest result label, and whole-result disclosure remain.

## What each value means

The target is the existing representation from iteration entry. Body values
reuse the representations already captured at the normal end of that body.
They are attached immediately to its active iteration ID. No extra frame
read, representation call, assignment observation, or evaluation was added.
Conditional values can carry over from an earlier pass; repeated assignments
show the value when the body capture point was reached. User `finally` suites
complete before a normal body capture.

A `continue` or `break` that bypasses that point says `u: not recorded`.
An unbound name, a value not yet distinguished from pre-loop state, or an
interpreter without frames also gets explicit missing capture. A failed
evaluation still keeps its existing flat error/output result; this change
does not introduce partial error explorers. Nested and reused names stay with
their own lexical loop and iteration identity. The footer remains a separate
final snapshot.

The existing three-name recorder cap and 2,000-entry statement budget remain.
Body text is reused from the existing 200-character representation capture,
whose truncation or failure suffix may be longer. Additive explorer text is
bounded to 1,000 code points, clipping only that captured string if necessary.
Names over 120 code points are omitted from additive metadata. Omitted names
are counted once at their loop heading. No body list is allocated for an
unretained iteration. Optional version-1 fields preserve older captures;
malformed additive metadata falls back to the original flat result.

## Automated evidence

Baseline: **926 extension tests / 708 kernel tests**, both passing.
Final: **933 extension tests / 718 kernel tests**, both passing.

Commands, run from this worktree:

```sh
npm --cache /private/tmp/evalens-npm-cache test
npm --cache /private/tmp/evalens-npm-cache run test:kernel
```

New real-pipe tests cover exact iteration/body/output association, early
exits, conditional carry-over, unbound/deleted/preexisting values, repeated
assignments, user `finally`, nested/reused names, mutable snapshots, bounded
large traces, overlong names, and long/custom/failed Unicode representations.
Direct instrumentation comparisons assert identical user call/representation
events with and without the explorer, and unavailable frame capture is
explicit. Renderer tests also check older metadata and reject invalid names,
statuses, values, duplicate bindings and excessive lengths.

## Actual Host evidence

[Host results](host-results.json) cover the exact reported example, R2
fold/reopen preservation, skipped and conditional iterations, nested loop
ownership, and the once-per-loop three-name limit. The extension-path entry
is sampled before the first evaluation activates it.

[Integration results](integration-results.json) additionally cover the
`whenPanelHidden` inline-visibility preference and physical Shift-Cmd-Enter
re-evaluation while R2 is collapsed. Closing the panel restores editor chips;
opening it retains the newly captured `u` values.

The recorded [Host harness](harness/verify-171.cjs) and
[integration harness](harness/verify-171-integration.cjs) use the existing
isolated bridge on ports 9354/9355 through [client.cjs](harness/client.cjs).
They create and evaluate only their own temporary Python fixtures. They are
environment-specific evidence, not a new runtime dependency or general test
launcher. The main session operated that Host; this worker did not manipulate
the normal VS Code window or the user's teaching files.

The worker did not package, install into normal VS Code, merge, push, or run
post-merge CI. Those checks belong to the main session after review. No
additional theme or screen-reader matrix was run for this change; the existing
theme variables and interaction controls were preserved.
