# One interface across experience levels: task script

## Purpose and evidence boundary

This script checks whether the same recorded-result workflow can support
learning and focused Python investigation. It is part of #190 and plan #182.
Use the integrated #183 through #188 implementation for the final pass.

A developer-led, agent-operated walkthrough can verify that actions work and
that relevant explanations are present. It cannot show whether a first-time
learner discovers them, understands them, or prefers this workflow. Record
that limitation in the outcome. No simulated participants, proficiency
scores, invented quotations, or claims of a human usability study.

If actual participant sessions are arranged later, give both experience
levels the same interface and task prompts below. Offer the same optional
help. Record requested help and misunderstandings, not a speed competition.
Do not recruit, message, or record people without explicit arrangements.

## Setup

Use an isolated Extension Development Host, profile, and disposable Python
fixtures. Record the extension commit, OS, theme, font, and panel width.
Leave the user's ordinary VS Code windows and teaching files untouched.

Start with default preferences and an empty Values panel. Repeat the core
inspection tasks after explicitly dismissing the introduction. Keep the
three follow/display preferences available in both passes. Change only the
isolated profile when testing alternatives.

Execute only the supplied fixtures and existing optional learning examples.
Each fixture below is independent: restart the isolated Python session before
changing fixtures. Do not silently run prerequisites for someone doing a task.
A fixture with several top-level statements must be evaluated in source order
unless the task deliberately asks about session persistence.

## Shared prompts and observable criteria

### 1. Find a learning example, then put guidance aside

Prompt: "Find an example you can edit to practise Python. Open it and locate
how to evaluate a statement with and without moving to the next one. Then
hide the introduction and find the help again."

Observe whether the empty state reaches an existing editable exercise and
whether results remain empty until an explicit evaluation. Reload the Host:
the dismissal choice should persist, and Help and learning should remain.
The buttons, headings, and shortcuts must be accessible by keyboard.

For a future participant session, record the route taken and help requested.
An agent following known selectors is not evidence of discoverability.

### 2. Explain variables versus output and recording time

Fixture:

```python
for v in [1, 2, 3]:
    u = 4 * v
    print(u)
    u = 99
```

Prompt: "Explain why the first row shows u = 99 beside printed output 4.
Which value did this loop print, and when was each variable reading saved?"

Expected evidence: the values and output occupy distinct labelled columns.
The explanation names v at iteration start and u at iteration end. Final
values remain separate. Dismissing introductory guidance must not hide this
information. The row is not a history of every assignment to u.

### 3. Recognize an old result without rerunning it

Fixture:

```python
scale = 4
answer = scale * 3
print(answer)
```

Evaluate in order, then edit scale to 5 and evaluate only its assignment.

Prompt: "Can the old answer be assumed to reflect this change? Find the
reason the saved answer is marked and the source it refers to."

Expected evidence: the result keeps its historical value with a specific
stale reason; navigation does not rerun answer or print. Absence of a stale
warning must not be described as complete dependency validation. Changing an
input by mutation is not guaranteed to be detected by name analysis.

### 4. Explain a missing reading

Fixture:

```python
for v in [1, 2, 3]:
    u = 4 * v
    if v == 2:
        continue
    print(u)
```

Prompt: "Was u zero, undefined, or None in the second iteration? What can
this recording actually tell you? Find the explanation without a mouse."

Expected evidence: u is explicitly not recorded for iteration 2 because the
normal body-end capture was not reached. The explanation does not claim the
assignment failed to run: u was assigned before continue. The iteration's
absence of output is distinct from its missing variable reading.

Repeat with a conditional assignment and no continue:

```python
for v in [1, 2, 3]:
    if v == 1:
        u = 4
    print(u)
```

The saved end values can carry over. They must not imply an assignment to u
occurred on every pass. Capture only records the existing proven reading.

### 5. Distinguish folding, another page, and unavailable detail

First use a fully saved paged loop:

```python
for x in range(25):
    for y in range(25):
        print(x, y)
```

Prompt: "Find a later outer iteration and a later inner iteration. Collapse
the whole result, then reopen it and return to what you were examining."

Expected evidence: both levels have recognizable Previous/More navigation.
The compact leaf rows need no redundant second fold. Whole-result folding
preserves source height, inner pages, and selected detail when reopened.

Then use the same fixture with both ranges changed to 100.

Prompt: "Which detail is folded, which is on another page, and which was
never saved? Explain the separate remaining-output section and its owner."

Expected evidence: counts describe actual iterations and the bounded saved
subset. Disabled navigation is not an invitation to recover unsaved detail.
Remaining output belongs to its named loop, not the last displayed iteration.
No even-per-run distribution may be inferred from the shared capture budget.

### 6. Inspect long saved text using native tools

Fixture:

```python
print(''.join(f'{i:03d}: café 🚀\n' for i in range(150)), end='')
```

Prompt: "Find output line 120, copy that complete line, and return to the
same folded or paged result without running Python again."

Expected evidence: a contextual open action opens the saved text, with source
and stream identity outside the copied payload. Native Find reaches text
beyond the panel preview. The copied line is exactly `120: café 🚀` plus its
newline. Reopening inspection must not mutate the recording or panel state.
Repeat against nested-loop output and a bounded long value representation.
Distinguish the saved representation from a complete or current object.

### 7. Evaluate, inspect, and return using the keyboard

Fixture:

```python
counter = 0
counter += 1
counter
```

Prompt: "Evaluate the increment and stay, evaluate it and advance, browse
the result, then return to editing. Explain which row matches your cursor
and which one contains the latest result."

Use physical Cmd/Ctrl+Enter and Shift+Cmd/Ctrl+Enter. Enter the panel through
the documented command, browse with its keys, operate folds and help, then
return to source. Repeat with linked navigation and new-result scrolling
disabled. Verify help Escape does not clear results. Confirm that navigation
alone leaves counter unchanged using a deliberate final evaluation.

Keep debugger keys F5/F9/F10/F11 outside Evalens bindings. Actual debugger
coexistence must be identified as verified or unverified in the outcome.

### 8. Distinguish clearing results from restarting Python

Fixture A:

```python
remembered = 7
remembered
```

Fixture B:

```python
remembered
```

Prompt: "Clear the recorded results. Predict whether Python still has the
name remembered. Then restart Python and explain what changes. Does switching
files create a new Python session?"

Expected evidence: clearing removes the display but preserves the binding;
a deliberate evaluation after restart raises NameError. Switching ordinary
files alone does not clear the shared namespace. Optional session help
explains this without inspecting live variables or resetting the session.

Also inspect the documented effects of Evaluate File with resetOnLoad on and
off, selection evaluation, Run File as Script, Evaluate Above Cursor, and
input replay. Compare the prose against actual lifecycle verification for
#188. Record exactly which actions this pass operated and which evidence it
reused; do not claim observing every path from reading the explanation.

### 9. Choose Evalens or the debugger for the question

Reuse task 2 and ask: "What was u immediately before its second assignment?
How would you watch the execution move through those assignments?"

Then read this independent example:

```python
def convert(value):
    return int(value)


def total(values):
    return sum(convert(value) for value in values)


total(['2', 'oops', '4'])
```

Prompt: "You want the sequence of calls and the variables in the active
caller when conversion fails. Where would you investigate that?"

Expected evidence: optional help directs execution-order, intermediate-state,
breakpoint, and call-stack questions to the Python debugger. Evalens' advance
command runs a statement and moves the editing cursor; it does not pause
inside a loop or function. Opening guidance must not launch debugging,
transfer a namespace, or promise continuation of the Evalens recording.

## Recording the outcome

For each task record the actual result, evidence path, and any friction.
Separate functional failures, wording judgments, and untested comprehension.
Do not treat passing a DOM assertion as evidence that a learner understood it.

Repeat representative result/help views at a narrow usable panel width and
an enlarged font. Note the existing #179 and #180 findings instead of calling
them regressions in this change set. Inspect contrast and controls by eye;
screen-reader names can be inspected without claiming screen-reader testing.

Prioritize verified defects affecting truth or access before extra controls.
Record follow-up tickets and explicitly defer features without demonstrated
need. In particular, the comparison decision in #189 should not infer demand
for pinning or a run archive from developer walkthrough success alone.
