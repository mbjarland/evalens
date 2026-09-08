# Recorded comparison: use native text tools first

> Status: Decision — defer a dedicated comparison feature
> Audience: Maintainer and implementation agents
> Source of truth for: the scope decision for issue #189
> Last reviewed: 2026-09-08, integrated source `173ef23` and exports `e28143b`

## Decision

Do not add a pin, comparison toolbar, or run-history store now. Use recorded
text opened in VS Code for occasional before/after comparisons, and the
existing loop table for adjacent saved iterations. Revisit this decision if
observed tasks show repeated, costly manual comparison with the clarity,
inspection, and session explanations available.

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
- Captured source and bounded value/output strings. The panel opens these
  as read-only native documents without contacting Python. Numbered tabs
  identify source, statement range, and recorded kind. A lock status item
  supplies scope, known staleness when opened, and a frozen source preview.
  This metadata is separate from the compared text. See
  [`ValuesViewProvider`](../../src/panel/values.ts) and
  [`RecordedTextDocuments`](../../src/panel/recordedText.ts).
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

The reviewed implementations supply the following supporting behavior:

- [#185 result evidence](https://github.com/mbjarland/evalens/issues/185)
  makes timing, missing readings, and saved-detail limits explicit.
- [#186 native text inspection](https://github.com/mbjarland/evalens/issues/186)
  gives opened recorded text source/stream context and bounded lifetime.
  Its source review is against `e28143b`; actual Host confirmation of the
  manual comparison workflow is recorded at the end of this decision.
- [#188 session clarity](https://github.com/mbjarland/evalens/issues/188)
  explains reset/load choices and the difference between clearing answers
  and discarding the Python namespace.

These dependencies improve the evidence accompanying a comparison. They do
not make text equality a proof of equal Python objects or equal execution.
No first-time learner or experienced-user study was performed for this
decision. The tradeoffs below are design judgments, not participant findings.

### Native export lifetime and provenance

An opened recording is immutable and its tab is pinned against preview
replacement. It remains available across reruns, Clear Inline Results, and
Restart Kernel. Those actions affect current answers or Python state, not
the historical text already open. Closing its last text or diff tab releases
the provider data, even if VS Code caches a document. A language-mode change
does not release a recording with an open tab. Window reload discards these
transient recordings.

The provider caps all open recordings at **32 documents and 8 Mi UTF-16 code
units**, counting payload and retained source/label metadata. It refuses
another export at the bound instead of evicting a document being read.
This is a string-storage bound, not a total VS Code heap measurement.

The recording number identifies an opened export, not a Python evaluation;
opening one result twice produces two export numbers. Its range describes
the statement's panel position when opened. The source preview is bounded
to roughly 2,000 UTF-16 units and visibly clipped when necessary, so it is
not always a complete source snapshot. Staleness metadata describes what was
known when the export opened; it does not track subsequent changes or certify
that inputs were equivalent. Preserve the original source separately when a
full reproducible experiment matters.

The original captured text is supplied without adding contextual prose.
Existing capture omission markers remain; native text models can normalize
line endings. This is text inspection, not a byte-preserving file export.
Each loop output action opens the whole statement's saved stream, including
all its loops, rather than only the selected iteration. Short flat results
have no separate export link when they fit in the panel; the workflow below
uses the loop's always-available stream action.

## Workflow 1: a changed transformation

Question: "Did filtering blank names remove the empty output line?"

Evaluate this loop with Cmd+Enter:

```python
for name in [" Ada ", "", " Lin "]:
    print(name.strip().lower())
```

Choose **Open statement printed output** in the loop result. Keep its
recording tab open and copy its text. Change the statement and deliberately
evaluate it again:

```python
for name in [" Ada ", "", " Lin "]:
    if name.strip():
        print(name.strip().lower())
```

Open the new statement output. Run **File: Compare Active File with Clipboard**
while the clipboard still contains the earlier output. Keep both source
contexts available in their recording tabs; the clipboard carries no source
context. Native file comparison is another route if the user chooses to
save the two outputs.
Evalens should never save those files automatically or modify the `.py` file
to retain results.

The two observations are:

```text
Earlier printed output             Later printed output
ada                                ada
                                   lin
lin
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
  Reuse the native provider; comparison documents also count toward its
  existing 32-document/8-Mi-unit budget. Do not create a second archive.
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
  user is reading. Clearing the comparison pin would not close unrelated
  native exports. The stricter comparison lifecycle and ended-session
  metadata described here are proposed; ordinary exports currently remain
  fixed historical documents across resets, as described above.
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

- Transformation output: `ada\n\nlin\n`, then `ada\nlin\n`.
- Accumulator: target strings `2`, `3`, `4`; the matching iteration IDs each
  contain captured `total` strings `2`, `5`, `9` and output `2\n`, `5\n`,
  `9\n`. The pairing was read from each entry, never array-index inference.

The source review was refreshed against integrated `173ef23` and native
exports `e28143b`, including the provider's ownership/release paths and
source-context tests. The literal-input transformation above deliberately
uses a loop because its stream action is available even for short output.
Both scratch examples were rerun over the real kernel pipe after rebase.

No production code or tests changed. Full suites were not rerun for this
documentation-only branch. Root-session native clipboard diff verification
is pending and will be recorded here when available. The separate #190
agent walkthrough is developer evidence, not a participant study; neither
that work nor this review establishes the user observations required by the
go criteria.
