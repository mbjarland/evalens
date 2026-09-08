# Recorded comparison: use native text tools first

> Status: Decision — defer a dedicated comparison feature
> Audience: Maintainer and implementation agents
> Source of truth for: the scope decision for issue #189
> Last verified: 2026-09-08, source at `cffbf52`

## Decision

Do not add a pin, comparison toolbar, or run-history store now. Use recorded
text opened in VS Code for occasional before/after comparisons, and the
existing loop table for adjacent saved iterations. Revisit this decision if
observed tasks show repeated, costly manual comparison after the clarity,
inspection, and session explanations have shipped.

This closes the investigation, not an implementation promise. No comparison
feature is shipped by this document, and no follow-on build ticket is needed
until its go criteria are met.

The lasting purpose is to help someone ask increasingly sophisticated
questions about Python. A first-year learner and a proficient developer can
both use deliberate evaluation and recorded answers. Stepping, breakpoints,
call stacks, and inspection of a paused frame remain the Python debugger's
job. A comparison must never suggest it can resume, restore, or step through
an earlier Evalens recording.

## Evidence and dependencies

The implementation already provides:

- A completed result identity, distinct from its source coordinates. The
  identity survives unrelated source shifts and stale marking; a new
  evaluation produces a different identity. It is an in-memory object,
  not a persistent run identifier. See
  [`Annotation`](../../src/render/decorations.ts) and
  [`ResultFolds`](../../src/panel/resultFold.ts).
- Captured source and bounded value/output strings. The existing panel
  opens these strings as untitled text without contacting Python. See
  [`ValuesViewProvider`](../../src/panel/values.ts).
- Explicit site, invocation, and iteration IDs with stream intervals. Loop
  targets are read at entry and selected body names at normal body end.
  These are not assignment-by-assignment states. Missing body readings must
  remain missing; independent history arrays cannot be joined by index.
  See the [wire contract](../../src/kernel/protocol.ts).
- A shared maximum of 2,000 loop invocation/iteration entries, up to three
  selected body names, and body text capped at 1,000 code points. Each
  statement retains at most 65,536 characters per stream plus its omission
  notice. None of these limits can be lifted by opening or comparing text.
  See [loop capture](../../kernel/loop_explorer.py) and
  [output capture](../../kernel/capture.py).

The plain-text comparison commands are native VS Code facilities. The
[editing documentation](https://code.visualstudio.com/docs/editing/codebasics#_compare-files)
describes comparing with the clipboard and other files. Locally installed
VS Code also registers `vscode.diff`; the installed API defines read-only
`TextDocumentContentProvider` documents and release on document close.

Three related work items improve the manual workflow. At the time of this
source review, these behaviors are planned, not verified as shipped:

- [#185 result evidence](https://github.com/mbjarland/evalens/issues/185)
  makes timing, missing readings, and saved-detail limits explicit.
- [#186 native text inspection](https://github.com/mbjarland/evalens/issues/186)
  gives opened recorded text source/stream context and bounded lifetime.
  Its final document lifetime must be checked against keeping a baseline
  open while deliberately producing a second result.
- [#188 session clarity](https://github.com/mbjarland/evalens/issues/188)
  explains reset/load choices and the difference between clearing answers
  and discarding the Python namespace.

These dependencies improve the evidence accompanying a comparison. They do
not make text equality a proof of equal Python objects or equal execution.
No first-time learner or experienced-user study was performed for this
decision. The tradeoffs below are design judgments, not participant findings.

## Workflow 1: a changed transformation

Question: "Did filtering blank names change anything except the empty item?"

Evaluate this single statement with Cmd+Enter:

```python
print([name.strip().lower() for name in [" Ada ", "", " Lin "]])
```

Open its recorded printed output in the editor and keep that document open.
Copy its text. Change the statement and deliberately evaluate it again:

```python
print([name.strip().lower()
       for name in [" Ada ", "", " Lin "] if name.strip()])
```

Open the new printed output. Run **File: Compare Active File with Clipboard**
while the clipboard still contains the earlier output. Keep both source
contexts available; the clipboard itself carries no provenance. Native file
comparison is another route if the user chooses to save the two outputs.
Evalens should never save those files automatically or modify the `.py` file
to retain results.

The two observations are:

```text
Earlier printed output             Later printed output
['ada', '', 'lin']                  ['ada', 'lin']
```

This workflow has a real cost: retaining the first export, preserving or
recopying clipboard text, and identifying both recordings. The cost is
acceptable for an occasional question, pending evidence that it becomes a
repeated obstacle. A command-only shortcut would not remove provenance and
lifetime requirements.

The answer is limited to the available text. A difference might arise from
changed inputs, carried-over state, output ordering, or custom `repr()`, not
just edited source. An identical truncated representation says nothing about
the omitted portion. Even complete matching representations are not Python
semantic equality. The side labeled "later" is another completed recording,
not a live watch. The example uses literal inputs to avoid hidden setup.

If the question becomes "Which branch removed this item, and what happened
inside the function?", set a breakpoint and step in the
[Python debugger](https://code.visualstudio.com/docs/python/debugging).
Its paused variables and call stack answer a different question from these
two output strings. Its session is independent of Evalens's namespace.

## Workflow 2: an accumulator across iterations

Evaluate the initialization, then the loop:

```python
total = 0
for n in [2, 3, 4]:
    total += n
    print(total)
```

The existing compact loop view already puts the useful observations beside
each other. This is a content sketch, not a new visual design:

```text
Variables                      Printed output
n = 2, total = 2               2
n = 3, total = 5               5
n = 4, total = 9               9

n at iteration start; total at iteration end
```

Question: "Why did total increase by four on the third pass?" The adjacent
rows and source answer it without a comparison control. If the goal is to
see the old `total`, evaluate the right-hand expression mentally, and watch
the assignment take effect, stepping over `total += n` is clearer. Evalens
does not retain that intermediate execution position.

For distant saved iterations, a future two-selection view could reduce
paging. It must use explicit iteration and invocation IDs from the same
recording, keep enclosing targets and timing visible, and label unavailable
body readings. It cannot recover an iteration omitted by the capture budget
or treat a final value as its missing body value. Rerunning the accumulator
also changes its initial state unless the user deliberately reruns the
initialization; selecting an older row would not undo that state.

## Options and likely cost

1. **Keep manual text comparison — recommended now.** No comparison runtime
   or permanent panel controls. Reuses native Find, selection, copy, and
   diff. The costs are manual provenance and an extra open/copy operation.
   Documentation and a real Host workflow check are sufficient for the
   initial decision; the inspection work has its own implementation cost.

2. **Pin one recording and compare later — conditional candidate.** Helps
   repeated transformation experiments by preserving the chosen baseline
   and naming both observations. A native diff avoids another renderer, but
   does not supply capture semantics, source identity, or lifecycle. Expect
   a work item of approximately **5 points**: a bounded snapshot owner,
   contextual commands, native documents with metadata, lifecycle wiring,
   tests for every invalidation path, and Host keyboard/return checks.
   This is an estimate, not a measured implementation duration.

3. **Select two saved iterations — defer.** No cross-evaluation baseline
   lifetime, but another selection model beside navigation, keyboard focus,
   folding, and paging. Expect **3–5 points**, depending on whether output
   and enclosing iteration context need native exports or a panel layout.
   It adds little to the accumulator above. Build only if comparing distant
   retained rows is repeatedly useful and paging demonstrably obstructs it.

## Conditional contract for a single baseline

These are proposed constraints for a future ticket, not current behavior:

- Three explicit contextual actions: **Pin recorded text**, **Compare with
  pinned text**, and **Clear pinned text**. One selected value representation
  or one statement stream per side. Do not silently combine values with
  output or compare unlike kinds. No per-variable diff, delta arithmetic,
  semantic equality, namespace snapshot, or automatic run history.
- Pin only completed available text, retaining its exact source statement,
  original URI/range, result identity, capture kind, and known stale/error/
  truncation facts. The later side is also frozen when explicitly chosen.
  Source hashes and line numbers alone cannot identify a recording. Any
  comparison ID is session-local and is never a saved runtime handle.
- Metadata lives outside the raw compared payload. Both sides show source
  and recording identity and distinguish their recorded text from current
  Python state. Later source edits must not relabel old text as the new
  statement. No stale marker means only that no tracked invalidation is
  known, not that every input dependency is unchanged.
- Proposed extension-owned budget: one baseline and one later snapshot,
  each at most **1 MiB of UTF-8 text plus metadata counted in that cap**.
  Include captured source in the budget. Refuse an oversized pin with an
  explanation; never silently shorten either side to fit. This cap is a
  proposal, not a claim about total VS Code heap use. Do not retain an
  entire loop model or live Python object behind a small text selection.
- Replacement requires an explicit new pin. Clear the pin on Clear Results,
  source document close, namespace reset/restart, and extension disposal.
  Do not add a new reset or evaluation trigger. A change to source leaves
  the old text fixed and its source difference visible.
- A native diff already open at clearing/reset may remain as explicitly
  historical text until closed, with the ended-session context visible.
  It cannot seed future comparisons after clearing. Such documents still
  count against the two-snapshot cap: until closed, reject new snapshots
  that would exceed the cap. Closing the last view releases its provider
  data. Never keep an invisible export archive or silently evict text the
  user is reading. Finalize this lifecycle against the export provider.
- Inspection, copying, pinning, and diffing send no `eval`, `inspect`, or
  reset requests. They cannot call `repr()` again, restore bindings, or
  replay statements. No stepping controls appear in the comparison.

## Go/no-go checks before filing a build ticket

Proceed only if all of the following hold:

- After the inspection and clarity changes, observed real tasks repeatedly
  require before/after comparison and the manual workflow is an obstacle.
  Record the task, the actual friction, and whether comparison changed the
  user's conclusion. One attractive mockup is insufficient evidence.
- Users can explain which result is older, what inputs/state remain unknown,
  and why a missing/truncated reading cannot be recovered. Include both
  early learners and proficient developers; report observations separately.
- A prototype beats native manual comparison for those tasks without
  complicating ordinary evaluate/read/return use. For two iterations, show
  value beyond the existing table and paging. Make stepping the comparator
  for questions about assignment order or intermediate state.
- The proposed caps, source/recording identity, and clear/reset/close behavior
  pass targeted tests and actual Host review. No extra Python calls, hidden
  persistence, text rewriting, or lost X5/Y2/R2 navigation state is allowed.

Defer if ordinary exports and the table suffice, if the requested answer
requires uncaptured state, or if most motivating tasks are better answered
by debugger stepping. A decision to defer is successful scope control.

## Verification record

Source review covered the modules linked above, the existing kernel pipe
harness, and the installed native VS Code API/command registrations. A fresh
kernel subprocess ran only the two scratch examples in this document:

- Transformation output: `['ada', '', 'lin']\n`, then `['ada', 'lin']\n`.
- Accumulator: target strings `2`, `3`, `4`; the matching iteration IDs each
  contain captured `total` strings `2`, `5`, `9` and output `2\n`, `5\n`,
  `9\n`. The pairing was read from each entry, never array-index inference.

No production code or tests changed. Full suites were not rerun for this
documentation-only branch. No native diff or new export lifecycle was driven
in an Extension Development Host during this investigation. The final
dependency integration needs that check; this record does not claim user
validation or visual verification.
