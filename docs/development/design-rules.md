# Design rules

> Status: Current
> Audience: AI agents and the maintainer
> Source of truth for: the principles this project has settled, and why
> Last verified: 2026-09-05

These are decisions the project arrived at, usually the hard way, and the
reasoning that makes each one worth keeping. They are not style preferences.
Each was reached because something was built the other way first and turned
out wrong in use.

Read this before designing a feature. If a proposal conflicts with a rule
here, that is a signal to stop and argue the rule explicitly rather than
route around it.

## 1. An annotation must never assert more than we know

The single most common defect in this project, found in five separate
disguises before it was named:

- a value left beside code that has since changed (#51)
- a value left beside code whose *inputs* have since changed (#59)
- a loop's final value rendered in the same style as a history (#60)
- a comprehension's variable annotated with an unrelated variable that
  happened to share its name (#63)
- a syntax error on line 19 reported as a failure at line 1 (#14)

Every one of them shows the reader something that looks more true than it is.
That is precisely the failure this project exists to stop notebooks
committing, so it is not merely a bug class — it is the bug class.

**Apply as a review question:** *does this make state more visible or less?*
A feature that hides, flattens or over-claims is off-strategy even when it is
convenient.

## 2. An annotation earns its place by differing from what the reader can see

Arrived at independently three times before being written down:

- a docstring annotated with its own text (#41)
- a value repeated on four consecutive lines (#28)
- `def greet(name):` annotated `greet: greet(name)` (#50)

If the annotation restates the line, it is noise competing with the code. If
it restates a value already visible above, the same.

**"The same characters" is not the test; "the same claim" is.** Definitions
are the exception, and #87 is what taught it: `def greet(name)` beside `def
greet(name):` is character-for-character the line, and a different assertion.
The source says *bind a function to this name when this runs*; the annotation
says *it has run, and the name holds this*. Those coincide only after an
evaluation — the fact the reader cannot see and most needs, since a definition
edited and not re-evaluated is the standing hazard of working this way. So
every definition annotates: `def`, `async def`, `class`, decorated or not.
Before that, the family split on an accident of prefix matching, and the one
form a first-year student writes on page one was the only thing on screen
saying nothing at all.

## 3. Annotating must never execute user code

Reading a bare name is a dictionary lookup and cannot run anything. `obj.attr`
may be a property with a body; `area(3, 4)` would have to be called again.

This has been violated three times, each time by a different mechanism: an
expression statement exec'd and then re-evaluated for display (#4), the
`display` path evaluating an attribute or subscript target (#68), and the
temptation to re-read a value to check whether it is stale (#40).

Where a value must be observed, capture it **during** execution the way
`loops.py` does — never by running something a second time.

## 4. Annotations are a trace, not a watch

An annotation shows the value at the moment its statement ran. It is never
re-read. Settled in #40, and the reasoning is worth keeping because it is
asked by everyone arriving from a debugger:

- **Position is a claim.** Beside `x = [1, 2, 3]`, a reading of
  `[1, 2, 3, 4]` asserts that statement produced a four-element list.
- **A watch erases the lesson.** In a file teaching aliasing, showing final
  state everywhere makes the mutation invisible.
- **A watch smuggles continuous evaluation back in**, which `IDEA.md` records
  as a category error rather than a tuning problem.
- **There is no "now".** Between evaluations the kernel is idle. A debugger's
  inline values are live because execution is *paused at a point*; this has
  no such point.

The cost of a trace is staleness, and the answer to staleness is a marker,
never a re-read.

## 5. Evaluation is explicitly triggered, never continuous

This is what makes side effects the user's decision. AREPL runs continuously
and therefore needs a blocklist guessing which code is unsafe to re-run;
Calva's manual trigger sidesteps the problem rather than managing it.

`IDEA.md` records the empirical finding that settles it: beginner code is
full of `input()` and infinite loops, so any evaluate-as-you-type mode
relaunches a program blocked on stdin every time typing pauses. That is a
category error, not a debounce interval to tune.

Changing this needs a decision ticket, not a commit.

## 6. Nothing is configured before a value appears

Earned by watching the alternatives fail on the maintainer's own machine:
Smart Send needs a selected interpreter and a working terminal, and produced
*"invalid arguments to create terminal"*; the Interactive Window needs
`ipykernel` in the environment and `# %%` markers in the file. Evalens ran in
the same window throughout, because #29 probes interpreters and uses the
first that actually runs rather than trusting what the environment reports.

The audience is a first-year student. The tool has to work before they know
what an interpreter *is*.

**Any feature requiring configuration before a value appears is
off-strategy.** This has already decided one architectural question: the
debug-session route in #33 had to pass this test before its UI cost was even
worth weighing.

## 7. The answer goes on the line

Not in a panel, not in a terminal, not in a side view. A panel puts the
answer somewhere other than the code, which is the notebook's mistake, the
Interactive Window's, and the terminal REPL's — and closing that gap is the
entire product.

The output channel is overflow, never the destination, and must not
auto-open or steal focus.

## 8. The file is only ever Python

No cell markers, no saved outputs, no artifacts. Annotations are decorations
and they evaporate; what is on disk is byte-for-byte what gets committed and
shipped.

This is the whole answer to "why not the Interactive Window", and it is why
the pedagogical argument holds: a notebook saves results from a state nobody
can reconstruct, and this cannot.

## 9. The kernel's own choices must not be observable from user code

Evalens must not change the semantics of the code it runs. Violated twice:

- the kernel's `from __future__ import annotations` leaking into every
  `compile()`, turning every annotation in the user's file into a string
  (#44) — fixed with `dont_inherit=True`, which is now load-bearing on every
  compile call in the kernel
- `sys.path[0]` being the extension's own directory, so local imports failed
  and a user's `import resolver` silently got *ours* (#69)

The general form: anything the kernel imports, sets, or arranges for itself
is a leak if user code can observe it.

## 10. Verify against reality, not against reasoning

Measurements that changed a decision this session:

- font coverage for candidate glyphs, which disqualified every loop arrow
  outside Menlo — and the failure is not a tofu box but a fallback glyph of
  different advance width, which misaligns the column (#36)
- scanning all 61 installed extensions for keybinding conflicts, which found
  AREPL owning `Cmd+Enter` after two wrong diagnoses (#45)
- driving a real Python course through the real kernel, which found five
  defects that no test and no hand-written fixture had (#68–#74)
- running the kernel suite on 3.9 through 3.14, which showed eleven broken
  builtins on the support floor where 3.14 showed seven (#47)

**A clean merge is not evidence that both sides survived.** Re-run everything
after a rebase.

## 11. Say what was not verified

Every agent that could not launch an Extension Development Host has said so.
Every claim about rendering that rests on an asserted string rather than a
human looking has been labelled. `refs #N` rather than `fixes #N` when the
acceptance is "somebody sees it".

The habit matters more than any individual instance: this project has been
wrong about its own behaviour often enough that unverified confidence is
expensive.
