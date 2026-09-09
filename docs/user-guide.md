# Evalens user guide

[Overview and first evaluation](../README.md) · [Commands](#commands) ·
[Keybindings](#keybindings) · [Settings and colors](#settings)

Evalens runs the Python statements you explicitly evaluate and records their
results beside the code. This guide covers the details: loop recording,
inspection, output, session state, keyboard controls, and display settings.

## Your first evaluation

```python
price = 8
quantity = 3
total = price * quantity
print(total)
```

Put the cursor on `price` and press **Cmd+Shift+Enter** (Windows/Linux:
**Ctrl+Shift+Enter**) to evaluate the statement and move to the next one.
Repeat for the remaining statements. The results stay beside their code:
`price: 8`, `quantity: 3`, `total: 24`, and `printed: 24`. **Cmd+Enter**
(Windows/Linux: **Ctrl+Enter**) evaluates without advancing the cursor.

<img src="../media/demo/hero.png" width="711" alt="Actual VS Code rendering of price 8 times quantity 3 producing total 24 and printed output 24">

## Read a sequence of results

```python
a = [1, 2]
b = a
b.append(3)
a
```

Evaluate these statements in order. The earlier readings remain beside the
assignments; the final `a` reading shows the mutation. Each annotation is a
recording from that statement's evaluation, not a live view of the object.

<img src="../media/demo/aliasing.png" width="711" alt="Actual VS Code rendering of list aliasing, with earlier assignment readings and a later mutated list">

Comparing histories can help diagnose a loop. If `total = n` replaces
`total += n` for the numbers `[2, 4, 6]`, both histories show `2, 4, 6`.
The accumulator should instead grow through `2, 6, 12`. The learning
walkthrough includes a similar accumulator exercise to predict, inspect,
and repair.

<img src="../media/demo/spot-the-bug.png" width="711" alt="Actual VS Code rendering of an accumulator bug, with matching loop-target and total histories">

## Learning and session help

For five optional hands-on exercises, choose **Evalens: Open Learning Walkthrough**
from the Command Palette, or **Try a guided example** in the empty Values panel.
Predict values, evaluate successive statements, explore list aliasing,
fix an accumulator, and see why an edited answer becomes stale. Each exercise opens
as an editable, unsaved Python document; nothing runs until you evaluate it.
**Evalens: Open Learning Exercise** opens an individual exercise. The walkthrough
is optional, and its checkboxes are yours to mark after trying each exercise.

The panel's **Help and learning** button stays available alongside its three
preferences. It explains recorded results, loop timing, missing readings, session
and reset actions, and
when to use the Python debugger. **Dismiss** hides the short introduction and
remembers your choice across reloads; **Show introduction** in Help brings it
back. Dismissing guidance never hides a result's error, stale marker, or capture
limit. Opening help or an exercise does not evaluate code or reset your session.

**Session and reset actions** shows the current `evalens.resetOnLoad` setting
and distinguishes clearing the display from discarding Python variables.
When that setting is off, a short notice remains visible above the results,
with **Session details** opening the explanation. This reports the setting;
it does not claim that a particular variable still exists. A non-resetting
file run's existing status-bar report names any detected leftover bindings.

**Evaluate and Advance** runs a statement and moves the editor cursor. To pause
inside a loop, step into a function, inspect the call stack, or examine variables
at a breakpoint, use the
[Python debugger](https://code.visualstudio.com/docs/python/debugging).
Starting a normal Python debugging session runs your program separately; it
does not resume an Evalens recording or carry over its variables.

## Values, loops, and output

### A loop tells you what it did, not just where it ended

<p align="center">
  <img src="../media/demo/loop.png" width="711" alt="A three-iteration for loop in VS Code: the header carries n's values 0, 1, 2 and square's values 0, 1, 4">
</p>

```python
for n in range(3):
    square = n * n
```

The loop target history, up to three selected body-name histories, and a
printed-output preview appear on the header line. Long histories are elided;
counts still report the number of observations. Each history puts
its values first and its own count afterward: `n: 0, 1, 2 · 3 iterations`
and `square: 0, 1, 4 · 3 iterations`. The quieter count distinguishes
a history from a single list or scalar value. A filtered body keeps its
actual count: `v: 0, 1, 2, 3, 4 · 5 iterations` beside
`kept: 1, 3 · 2 iterations`. A constant history can show one value and still
state how many iterations recorded it; hover explains that it was unchanged.

### Loops keep values beside the output they produced

In the editor, each loop's history appears beside its own `for` header. For
nested `range(100)` loops, the outer line shows
`x: 0, 1, 2, 3, 4, …, 99 · 100 iterations` and the inner line shows
`y: 0, 1, 2, 3, 4, …, 99 · 100 runs · 10,000 iterations total`.
A **run** is one execution of that `for` statement; an **iteration** is one
pass through its body. Values come first, followed by these counts in the
quieter label color. Runs appear only when there was more than one.
Outer loops, inner loops and body histories share the same compact elision.
The sequence preserves the first recorded values and the final observation
across all runs, including repeats and irregular values;
it does not imply a range or identical runs. Hover explains any omitted
values. A loop that was reached but drew nothing says **(no iterations)**
and still reports its counts when run more than once; one inside an outer
loop that never entered says **(not reached)**.

Open **Evalens: Show Values Panel** after evaluating a `for` loop. The
**Variables** column contains the loop variable at the start of that
pass and selected body values captured at the normal end of its body;
**Printed output** contains the text it produced. For example,
`for n in range(3): print(n * n)` shows three compact rows pairing `n = 0`,
`n = 1`, and `n = 2` with `0`, `1`, and `4`. Short single-level iterations
need no individual headings or arrows. Nested loops add outer headings such
as **Iteration 1 · x = 0 · printed 4 lines** around those same rows.
For `u = 4 * v` inside a loop over `[1, 2, 3]`, the values read
`v = 1, u = 4`, `v = 2, u = 8`, and `v = 3, u = 12`, beside their separate
printed output. Body values describe the end of the body, so repeated
assignments show the last value there, and conditional values can carry over
from an earlier pass. A `continue` or `break` that skips this capture point
shows **u: not recorded**. Unbound names and names that cannot yet be
distinguished from pre-loop state also say **not recorded**. Up to three body
names are captured; the loop heading reports any additional omitted names.
One **About these values** control explains when loop variables and body
variables are read, and how values can carry over between iterations.
**Why?** beside a missing reading explains what Evalens could record. A missing
reading does not establish that an assignment was skipped or that the Python
variable had no value. For `u = 4; print(u); u = 99`, the end reading is `u = 99`
and the printed output is `4`.
Silent passes say **No output**; an empty loop says **No iterations**, with
any `else` output shown separately.
`stderr` is labelled separately. **Final values after this loop** is the
final snapshot, not a claim about any selected iteration or a live watch.

The explorer uses the panel's neutral background with an orange leading bar.
Filled emphasis stays on the selected iteration, keeping large traces quiet.
One **Variables | Printed output** heading aligns the columns across nested
loops. While scrolling, the shared heading stays visible. Its title shows a
compact iteration and source reminder only after the corresponding headings
leave view; visible headings do not gain a repeated context line. Opening
**About these values** returns its explanation to ordinary scrolling;
oversized headings also stay in the normal flow so that results remain
reachable in a short panel. Narrow panels stack values and output with local
labels, keeping the two kinds of information distinct.

Short nested runs show neighboring outer iterations together. Long output
starts folded even in a single-level loop. Use the disclosure arrows for
nested or long content, **More iterations** or **More nested loops**
for another batch, and **More output** for the next output part. Selecting an
iteration value reveals its loop header. These controls only browse the
existing capture; they never run the code again. Folding survives unrelated
edits and starts fresh after another evaluation.

Opening an outer iteration also shows its only inner loop; sibling loops keep
separate arrows. Both inner and outer loops show the current iteration range
against the number that actually ran, with **Previous iterations** and
**More iterations** controls. A disabled control marks a page boundary; when
later iteration details were not captured, that loop says beside its heading
how many iterations ran and how many details were saved. Folding, another
saved page, and details that were never saved are distinct states.
Remaining captured output starts folded under **Remaining printed output**,
after its loop's navigation, with the source line identifying its owner. It
keeps the same bounded output parts when opened and may include `else` output;
it is not assigned to the last visible iteration.

A statement retains at most 2,000 loop invocations and iterations combined,
plus the existing 65,536-character limit for each output stream. The panel
states when iteration detail or output was not retained: expanding cannot
recover it. **Open statement printed output** and **Open statement stderr output** open the
original captured stream, including any capture-limit notice. Unsupported
loop targets, failed evaluations, and disabled loop tracing keep the ordinary
flat output rather than guess a history. The body readings in iteration
rows are captured directly for those iterations; they are not reconstructed by pairing independent histories.

### A comprehension stops hiding its loop

<p align="center">
  <img src="../media/demo/comprehension.png" width="711" alt="A list comprehension in VS Code: nums holds 0, 2, 4 and n shows the three values from its own loop">
</p>

```python
nums = [n * 2 for n in range(3)]
```

A comprehension shows both its result and the history of its loop target.
That history is captured inside the comprehension's own scope: a separate
module-level variable with the same name does not supply its values.

### What a line printed, beside what it produced

<p align="center">
  <img src="../media/demo/print.png" width="711" alt="Two evaluated statements in VS Code: total is 6 and the next line shows printed: total: 6">
</p>

```python
total = 6
print("total:", total)
```

`print()` returns `None`; Evalens shows the printed text in its place.
A statement that both binds a name and prints output shows both, with
distinct labels.

### Look inside a value without running it

Hover any annotated line. A list of records becomes a table — no pandas
required, and it works on list-of-dicts, namedtuples and list-of-lists too:

| name | born | field |
| :--- | :--- | :--- |
| 'Ada Lovelace' | 1815 | 'computing' |
| 'Grace Hopper' | 1906 | 'compilers' |

An object shows its fields, and `Explore ▸` opens a drill-down:

| Field | Type | Value |
| :--- | :--- | :--- |
| x | *int* | 3 |
| y | *int* | 4 |
| magnitude | *property* | *not evaluated* |

**Read that last row carefully.** `magnitude` is a `@property`. It is
listed and it is **not called** — and that is a rule this project enforces
rather than an omission. Annotating your code must never *run* your code, so
no getter fires, no `__getitem__` is invoked, no generator is consumed,
because you moved your mouse.

### Errors are answers

<p align="center">
  <img src="../media/demo/error.png" width="711" alt="A single failing
    statement, painted in the error colour with a matching gutter mark: the
    ValueError int() raised, on the line that raised it">
</p>

```python
int("x")
```

On the line that raised, in the error colour, with the whole traceback on
the hover. A file load carries on to the next statement rather than stopping,
so one bad line does not cost you the other forty.

The hover also explains Python's built-in `NameError` and `ValueError` in
plain language after the original traceback. For `NameError`, it suggests
checking spelling and whether a definition has run, and names **Evalens:
Evaluate Above Cursor** with its cost: resetting state and running earlier
statements. This is reading guidance; opening the hover runs nothing.
`ValueError` includes a clearly marked example and points back to Python's
original message. Other errors and user-defined exception classes keep their
existing presentation.

### `input()` that does not make you retype

The first statement evaluation asks for input; later evaluations reuse the
saved answer until its statement changes or the answers are cleared.
Whole-file evaluation resets saved answers by default. For a repeatable
example, you can also write a literal answer in the source:

```python
name = input("Your name: ")   # evalens: Ada
age  = int(input("Age? "))    # evalens: 34
```

Inert to `python3 yourfile.py`, which still asks a human. The value arrives
as a **string**, because `input()` returns a string — so `int(...)` is still
doing real work, which is the lesson that line is teaching.

### Run it the way Python would

**Evaluate File** clears the namespace by default and runs top to bottom, painting each
statement as it goes. **Evaluate Above Cursor** gets you to *here* and stops.
**Run File as Script** sets `__name__` to `"__main__"` so an
`if __name__ == "__main__":` block runs.

Clearing the namespace by default prevents a binding deleted from the file
from surviving its next whole-file evaluation. Statement evaluations share
one session across files, so clearing also prevents a file from reading
leftover variables created by an earlier file.

### Ask a loop a question it never states

A loop already records its target and selected body names. An inline watch
adds an expression you explicitly request. Put the cursor in the loop,
run **Evalens: Add Inline Watch**, and enter `n * 2`:

<img src="../media/demo/watch.png" width="711" alt="A loop in VS Code with an explicit n * 2 watch showing 0, 2, 4 alongside n's 0, 1, 2 history">

```python
for n in range(3):
    pass
```

Confirming the watch runs the loop again and evaluates the expression
inside each iteration. Its recorded sequence remains beside the loop;
nothing is reevaluated while you browse it. Unlike simply viewing an
existing result, adding a watch is an explicit execution action.

### It tells you when an answer is from before an edit

Change a line after it has run and the answer beside it goes **stale**. The
value does not grey out — it stays exactly as readable, because dimming it
would be one more claim competing with the one thing on the line worth
trusting. What changes is the chip around it: its tint fades to almost
nothing and its edge turns grey, so the surface visibly recedes while the
value keeps its own colour, and the marker in the gutter changes with it.
Re-run the line and it catches up.

Re-running a line that binds a name marks the lines **below** it that read
that name, too — re-run `x = 1` and `y = x + 1` below goes stale even though
its own text never moved, because it now describes a world that has changed.
Hovering a stale line says which of the two happened. Until you re-run,
nothing below is touched: those answers are still exactly what that code
produced. Comment a line out and its annotation disappears entirely, because
there is no statement left to describe.
### It can be heard

Results can be announced, and hover content is reachable through VS Code's
Accessible View. See [Screen readers](#screen-readers) for the controls and
verification limits.

### A panel for when the margin runs out

Every value so far sits in the margin, to the right of the line that
produced it — which works until there is no margin left. Lecture slides on
half the screen, a laptop-width window, a `repr()` longer than what is left
of the line: VS Code gives an extension no way to even ask how many columns
wide the editor is, so an inline value that runs past the edge cannot wrap,
cannot pin itself to what is visible, and cannot take a line of its own.

**Evalens: Show Values Panel** opens the same recorded results in the bottom
panel instead, one row per annotated line in file order, full width and wrapping.
A list long enough to have run off the screen now wraps onto a second line;
a `print()` spanning several lines keeps every one of them, not the inline
chip's first-line-and-a-count.

The file summary counts **recorded results**: one completed statement is one
result, even when it contains several variables or many loop iterations.
Running evaluations are counted separately until they finish.

Each statement's values and output share one background and a continuous
leading bar. A quiet divider separates values from output within that block;
the stronger separators across code and results mark different statements.
Labels stay beside their values, with the same variable and output colours
as the editor. Long output and multiline values retain **Show all**,
**Show less**, and contextual actions such as **Open recorded value** or
**Open statement printed output**.

A result taller than its source has a small disclosure arrow beside its
value heading, just after the leading bar. Click it, or focus it and press
Enter/Space, to fold the whole value area to the source's height. The code
stays visible, with a concise result summary and any stale, error or capture
limit warning. Reopening restores the inner folds, pages and selected
iteration; following the editor cursor never opens a folded result.
The choice survives file/view switches and source moving down the file.
Re-evaluating the unchanged statement keeps it folded but starts fresh inner
pages; changed source or cleared results starts a new choice.

Move the editor cursor to bring the corresponding row into view, marked with
a rightward arrow and a frame. The arrow marks source correspondence;
triangles disclose folded values. Click a row, or use Up/Down and Home/End after focusing
one, to reveal its source. A short amber gutter tick and a soft neutral wash
identify the editor's current line. Keyboard focus stays in the pane you
are using, so you can keep navigating there. A cursor inside a multiline
statement selects that statement's captured result; an unrelated blank line
selects none. With linking off, arrow-key browsing moves keyboard focus
without changing the source marker. Moving around never evaluates code.

For a keyboard workflow, use **Evalens: Show Values Panel**, then arrow keys
to browse rows and Tab to reach folds, pages, explanations and recorded-text
actions. Enter/Space activates the focused control. Focus stays with the
same control across page changes; replacing a recording returns it to a
surviving control in that row. Escape closes the current explanation, then
Help if pressed again; from another result control it returns to the row.
Use the native **Focus Active Editor Group** command to return to editing
(with one editor group, `Cmd+1` (`Ctrl+1` on Windows/Linux) also focuses it).
When a recorded-text tab is open,
revealing a panel row brings its Python source back into view while leaving
keyboard focus in the panel. Native Find, copy and tab navigation work in
recorded-text editors. The editor's Escape-to-clear and Python debugger
shortcuts remain unchanged.

The panel's sticky control row holds three checkboxes, each carrying its own
state rather than swapping an icon for a near-identical one — a toggle whose
state cannot be read has to be tested by clicking and then remembered, and a
checkbox does not have that problem:

- **Link code and values** — uncheck it to browse
  independently. Clicking a row or pressing Enter/Space still reveals its
  source. Controls `evalens.valuesPanel.followCursor`.
- **Scroll to new results** — controls `evalens.valuesPanel.follow`, following
  newly evaluated results into view separately from cursor navigation.
- **Hide inline values while this panel is visible** — check it, with
  `evalens.inlineValues` set to `whenPanelHidden`, to hide the editor's own
  inline value and error chips for as long as this panel stays open on its
  Values tab; they come straight back the moment it is not — never leaving
  you looking at a silent editor with the panel closed. Gutter markers, the
  evaluated region, and the running/asking marks keep painting regardless,
  and hovering a hidden line still shows its value: only the chip
  disappears, never the value itself.

All three round-trip: checking or unchecking one writes the matching
setting, and changing the setting elsewhere — the command palette, the
Settings UI, or `settings.json` — updates the checkbox back.

The most recently recorded result in this file has an amber edge and a
**Latest result** label. It stays visible after Evaluate and Advance moves
the cursor to the next statement, and remains separate from the cursor's
matching row. The label moves when another result arrives, including an
error; a running statement never receives it. These cues do not change
either follow setting or take keyboard focus.

It is the same trace read twice, not a second feature — the panel reads
what is already painted and asks the kernel nothing, so a row goes stale
exactly the way the inline chip does, in the same grey surface, for the
same reason. It is never opened for you: run the command once, or
*View → Open View… → Evalens: Values*, and reach for it whenever a narrow
editor or a long value is the actual problem, not the answer itself.

## Requirements

**VS Code 1.90 or later and Python 3.9 or later.** No additional Python
packages or launch configuration are required. Evalens uses the interpreter the Python extension has
selected if you have that extension, then `python3`, then `python`, and takes
the first that runs and reports 3.9 or later. Naming one in the
`evalens.pythonPath` setting overrides all of it.

## Install

Install [Evalens from the VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=mbjarland.evalens).
In VS Code, open the Extensions view — `Cmd+Shift+X`
(`Ctrl+Shift+X` on Windows/Linux) — search for **Evalens**, and select the
extension published by **mbjarland**. From a terminal instead:

```bash
code --install-extension mbjarland.evalens
```

Reload the window if VS Code asks, open a Python file, and press
`Cmd+Enter` (`Ctrl+Enter` on Windows/Linux) on a line. If nothing happens,
try **Evalens: Evaluate at Cursor** from the Command Palette and see
[Keybindings](#keybindings) for conflict fixes. You need VS Code and Python
(see Requirements above); no Node installation is needed to use Evalens.

**If someone handed you a `.vsix` file**, open the Extensions view's `···`
menu, choose **Install from VSIX...**, and pick the file. From a terminal:

```bash
code --install-extension evalens-0.2.0.vsix
```

**Building the `.vsix` yourself** — for anyone who already has Node and
wants the current source checkout:

```bash
npm ci
npm run package
code --install-extension evalens-0.2.0.vsix
```

`npm run package` writes `evalens-<version>.vsix` into the
repository root; the version comes from `package.json`. Use that version in
the install command, then open a Python file as above.

## Commands

**Every command is in the Command Palette** — `Cmd+Shift+P`
(`Ctrl+Shift+P` on Windows/Linux) — prefixed with `Evalens:`. Use the palette
if a shortcut is claimed by another extension or user binding.

| Command | What it does |
|---|---|
| Evalens: Evaluate at Cursor | Evaluates the form the cursor is in and paints its value beside it |
| Evalens: Evaluate and Advance | The same, then moves to the next top-level statement — hold the key to walk a file |
| Evalens: Add Inline Watch | Prompts for an expression — prefilled with the selection, or the identifier under the cursor when there is none — and traces it inside the enclosing loop at every iteration, alongside the loop's own sequence |
| Evalens: Evaluate File | Clears the namespace, then runs the file top to bottom, annotating each statement — or the selected statements, when there is a selection, which never resets |
| Evalens: Run File as Script | Runs the whole file the way `python3 file.py` would, so an `if __name__ == "__main__":` block runs |
| Evalens: Evaluate Above Cursor | Resets the namespace and runs everything above the statement the cursor is in, stopping at the first failure |
| Evalens: Clear Inline Results | Removes recorded results from all editors and the Values panel; keeps Python variables and saved input answers |
| Evalens: Announce Result at Cursor | Puts what is painted on the cursor's line into a notification, where a screen reader reads it |
| Evalens: Inspect Value | Opens a QuickPick over the fields of the value at the cursor, for going deeper than the hover's own table |
| Evalens: Interrupt Evaluation | Stops a running evaluation and keeps the namespace it built |
| Evalens: Restart Kernel | Stops Python and discards variables and saved input answers; the next evaluation starts a fresh interpreter |
| Evalens: Clear Input Answers | Forgets every replayed `input()` answer, keeping the namespace |
| Evalens: Show Output | Opens the Evalens output channel without taking the cursor out of the editor |
| Evalens: Show Values Panel | Opens the bottom-panel view listing the active file's annotations full width, wrapping, and synced to the cursor |
| Evalens: Toggle Scrolling to New Results | Flips `evalens.valuesPanel.follow`; also the **Scroll to new results** checkbox in the panel |
| Evalens: Toggle Inline Values in the Editor | Flips `evalens.inlineValues`; also the **Hide inline values while this panel is visible** checkbox in the panel |
| Evalens: Fix Keybinding Conflict | Hands you the user keybinding described below |
| Evalens: Open Learning Walkthrough | Opens the optional guided introduction and five exercises |
| Evalens: Open Learning Exercise | Chooses an editable Python exercise; opening it runs nothing |

**Evaluate File clears the namespace before it runs the whole file, by
default.** This removes bindings from deleted lines and earlier file loads.
`evalens.resetOnLoad` controls that reset and defaults to on. Turn it off to keep expensive setup — a slow import block, a
cache built at the top of the file — from being re-paid on every load;
Evalens then paints a status-bar note whenever the namespace still holds
something the file on screen no longer binds, so the cost stays visible
rather than silent. It governs a whole-file run only: a run over a
selection never resets, whatever this setting says, because resetting and
then running three lines would leave everything above them unbound.
**Evalens: Run File as Script** always resets too, for a reason of its own —
see below.

**Clearing results is not restarting Python.** Clear Inline Results removes
the recorded answers for every file without stopping running code or changing
variables or saved input answers. Restart Kernel stops Evalens's Python
process and discards that session; it leaves the recorded answers visible
as earlier readings. Neither those readings nor selecting an iteration tells
you which variables exist in the new session. Statement evaluations share
one Python session across files in a VS Code window. A normal Python debugger
session runs separately and does not resume an Evalens recording.

Resetting before a whole-file run, Run File as Script, and Evaluate Above
Cursor also clear saved input answers. Evaluate File with a selection keeps
them, as does a whole-file run with `evalens.resetOnLoad` off. Clear Input
Answers forgets saved answers without clearing variables; literal
`# evalens:` answers in the source are unaffected.

**Evaluate File runs a selection, and runs whole statements.** Select the
first twenty lines and press the key: those statements run, in order,
annotated exactly as a full load annotates them. A selection that begins or
ends halfway through a statement runs that statement whole and briefly
highlights how far it reached — a partial statement is never executed, because
a fragment can parse into something valid that means something else. A
selection with no complete statement in it — a comment, a blank line — says so
in the status bar and runs nothing.

**Add Inline Watch traces one more expression, not a live value.** A loop
already shows its target and selected body-name histories; type
`total * 2`, `len(seen)`, or anything else the loop's body can see into the
box the key opens, and pressing Enter runs that loop once more, this time
also capturing the nominated expression's value at every iteration — painted
the same way a body binding is. Select the expression first and the box opens
prefilled with it, so the older select-and-press gesture still works
unchanged. With nothing selected, the box prefills with the identifier the
cursor is on — placing the cursor on `total` and pressing the key is now as
fast as selecting it — but only when that word is one worth offering: a
Python keyword, a word inside a string or a comment, a number, or a name
immediately after a `.` (an attribute is essentially never itself a bound
variable) all leave the box empty instead, because a wrong prefill costs more
to notice and remove than typing from nothing does. The box is always titled
with the loop's own header line, so it is clear which loop is about to run
regardless of what filled it. It is a trace,
exactly like the rest of the line: each value is read the moment that
iteration produced it, not fetched afterwards, and nothing is kept between
presses — nominate again after editing the loop to see the new values. An
expression that raises partway through — `1/x` over a sequence containing a
zero — is reported once, and the loop still runs to completion. An expression
that does not even compile is shown as an error message rather than painted
anywhere, since there is no statement for it to stand beside. Cancelling the
box — Escape, or the close button — leaves nothing behind.

**Evaluate File never runs an `if __name__ == "__main__":` block, on
purpose.** Loading a file means *import this module*, which is what an
imported module's `__name__` genuinely is — the file's own name, not
`"__main__"` — so the guard is False and its body does not run, for the same
reason it would not run under a real `import`. That used to be silent: the
guard's own annotation showed nothing but the module name, which only reads as
"this is why" if you already know the idiom. It now says so directly —
`if __name__ == "__main__": => False -- not run as a script (Evalens: Run
File as Script)` — because a block that did not run must never look like one
that did.

**Evalens: Run File as Script is the separate, deliberate command that runs
it.** `__name__` is `"__main__"` for that one run and nothing else about the
file changes: it still runs top to bottom, into the same session. Unlike
Evaluate File, this always clears the namespace first, whatever
`evalens.resetOnLoad` says — it exists to answer whether the file matches
what `python3 file.py` would do, and a namespace carrying an earlier run's
leftovers makes that comparison meaningless. `sys.argv` is
`[the file's path]` for the run, matching what `python3 file.py` gives the
script. There is no default keybinding, deliberately: reaching for this command
is meant to be a choice, and it is always one press away in the Command
Palette.

**A file that is part of a real package resolves its relative imports on an
ordinary load, and loses that on a script run — on purpose, and matching a
real interpreter both ways.** Opening `demo_pkg/__init__.py` and pressing
Evaluate File runs `from .geometry import area` the way `import demo_pkg`
would, because a load's whole premise is *import this module*: Evalens works
out the package it belongs to and gives it the `sys.path` entry and
`__package__` a real import would. Run File as Script answers the same file
differently, because `python3 demo_pkg/__init__.py` does: running a file
directly never establishes package context, in a terminal or in Evalens, so
the same relative import fails there with the same `ImportError` it would at
a command line. Neither answer is a bug in the other's terms — they are two
different real commands, faithfully imitated.

Running as a script has one real limit worth knowing before you rely on it:
`multiprocessing.Pool` and `concurrent.futures.ProcessPoolExecutor` send a
worker a *reference* to the function to call, by looking it up on
`sys.modules["__main__"]` — the interpreter's real, singular main module,
which stays the Evalens kernel process throughout. A function your file
defines lives in the kernel's namespace instead, so a worker cannot find it and
the call fails with `PicklingError: ... not found as __main__.<name>`, exactly
as it would if the same function were defined in a Jupyter cell or a live
REPL. This remains an evaluation inside a persistent kernel, rather than a
new operating-system process for your script. Run the file with Python
itself when process startup and isolation are part of what you need to test.

**Evalens: Evaluate Above Cursor gets a specific line ready to evaluate,
without evaluating it.** Put the cursor on line 40 and press it: everything
strictly above the statement the cursor is in runs, in order, annotated as
it goes — and the statement the cursor is actually in never runs here, on
purpose, because that is what Evaluate at Cursor is for. A cursor inside a
multi-line statement is not a special case: whichever line of it the cursor
is on, the whole statement is the boundary and stays unrun, since a
statement never runs partway.

It resets the namespace first, unconditionally, with no setting to turn
that off. A partial run's only honest promise is that the namespace
afterward matches what running the file from the top through the cursor
would have produced, and a binding left over from an earlier keypress would
quietly break that promise. Unlike Evaluate File, which keeps going after a
broken line because a file being explored in is expected to have one,
Evaluate Above Cursor stops at the first failure and reports which
statement it was — a namespace built on top of a failure it did not stop
for is one nobody can reason about.

## Keybindings

| macOS | Windows / Linux | Command |
|---|---|---|
| `Alt+Enter` | `Alt+Enter` | Evalens: Evaluate at Cursor — the top-level form |
| `Cmd+Enter` | `Ctrl+Enter` | Evalens: Evaluate at Cursor — the same command |
| `Cmd+Shift+Enter` | `Ctrl+Shift+Enter` | Evalens: Evaluate and Advance |
| `Cmd+Alt+Enter` | `Ctrl+Alt+Enter` | Evalens: Evaluate File |
| `Escape` | `Escape` | Evalens: Clear Inline Results |

**Both evaluation shortcuts run the enclosing top-level statement.**
They do not evaluate just the subexpression under the cursor. `Alt+Enter`
has the same meaning on all platforms.

**Both keys are contested, and with AREPL installed either may do nothing at
all.** `almenon.arepl` binds *two* keys under exactly the condition Evalens
uses, `editorTextFocus && editorLangId == python`:
`extension.executeAREPLBlock` on `Ctrl/Cmd+Enter`, and `extension.printDir`
on `Alt+Enter`. VS Code breaks a tie between two *extension* keybindings by
load order — the last one registered wins — and nothing makes load order
deterministic, so which extension answers can change between reloads. It
presents as a dead key: no error, no notification, no log line.

The Jupyter extension overlaps too, in both places, but only inside a file
that has `# %%` cells (`jupyter.hascodecells`). `ms-toolsai.jupyter` puts
`jupyter.runcurrentcell` on `Ctrl+Enter` — that one ships no `mac` override
and `ctrl` stays `ctrl` on macOS, so there it never meets `Cmd+Enter` — and
`jupyter.runcurrentcellandaddbelow` on `Alt+Enter`, which ships no override
either. That second absence reads the opposite way: `key` is the
cross-platform default, so a binding with no `mac` entry applies on macOS
rather than being missing there.

**The fix is a user keybinding.** User keybindings are resolved after every
extension's, so the last match on a key is always yours — this is the only way
to settle the tie deterministically, and it is why Evalens cannot fix it from
its own manifest. Run **Evalens: Fix Keybinding Conflict**: it copies the
entry below and opens your `keybindings.json` so you can paste it. Nothing is
written to your settings on your behalf, and deleting the entry undoes it.

```jsonc
  // Evalens: a user keybinding is resolved after every extension's,
  // so this one wins the key whichever extension loaded last.
  {
    "key": "cmd+enter",
    "command": "evalens.evaluateAtCursor",
    "when": "editorTextFocus && editorLangId == python && !findWidgetVisible"
  },
  // The same command on the top-level-form key, which is where
  // Calva puts it. Uncontested by VS Code itself; not by AREPL.
  {
    "key": "alt+enter",
    "command": "evalens.evaluateAtCursor",
    "when": "editorTextFocus && editorLangId == python && !findWidgetVisible"
  },
  // Removes AREPL's extension.executeAREPLBlock from cmd+enter. Delete this
  // entry to keep it -- the one above already wins where both apply.
  {
    "key": "cmd+enter",
    "command": "-extension.executeAREPLBlock",
    "when": "editorTextFocus && editorLangId == python"
  },
  // Removes AREPL's extension.printDir from alt+enter. Delete this
  // entry to keep it -- the one above already wins where both apply.
  {
    "key": "alt+enter",
    "command": "-extension.printDir",
    "when": "editorTextFocus && editorLangId == python"
  }
```

Use `ctrl+enter` in place of `cmd+enter` on Windows and Linux; `alt+enter` is
the same on every platform. The removal entries are not redundant: an Evalens
binding only wins where its `when` holds, so without them AREPL still answers
while the find widget is open.

**Installing Evalens is what makes that entry matter.** While the extension
only ever ran in an Extension Development Host, a user keybinding scoped with
`isDevelopment` was enough — it applied in the dev host, which was the only
window Evalens existed in. An installed extension exists in ordinary windows
instead, where `isDevelopment` is false, so a binding carrying that clause now
excludes exactly the windows the extension runs in: AREPL wins `Cmd+Enter`
back and the key goes dead again, silently, for a reason that reads like a bad
install. The entries above are unscoped on purpose; if you wrote one against
the dev host, drop the `isDevelopment` clause.

If the key stops working again, run **Developer: Toggle Keyboard Shortcuts
Troubleshooting**, return focus to the Python editor, and press the key once.
The output opened by that command shows which command VS Code matched and
whether the binding came from a user override or an extension.
`Cmd+Enter` / `Ctrl+Enter` should match `evalens.evaluateAtCursor` and leave
the cursor in place; adding `Shift` should match `evalens.evaluateAndAdvance`
and move to the next statement. Turn troubleshooting off with the same
command afterwards. Check this in the ordinary window where you use Evalens:
a successful development-host check can conceal an `isDevelopment` override.

If you use AREPL too, assign distinct user shortcuts to the two extensions,
or disable the one you are not using in this workspace. A single key cannot
choose both commands in the same context.

Evalens says all of this itself. When it activates and finds AREPL enabled it
writes the conflict and the snippet to its **Evalens** output channel every
time, and offers the fix in a notification once — once per installation, never
again, whatever you answer. If you dismissed it, **Evalens: Fix Keybinding
Conflict** in the palette hands you the same thing at any time.

### The advance key, and why it is not `Shift+Enter`

**Evaluate and Advance is on `Cmd+Shift+Enter` / `Ctrl+Shift+Enter`, and
`Shift+Enter` is deliberately not used.** `Shift+Enter` is what the convention
wants — it is run-and-advance in Jupyter, Spyder, MATLAB and VS Code's own
Interactive Window — and in a Python file it is claimed four times over, by
`python.execSelectionInTerminal`, `python.execInREPL`,
`jupyter.execSelectionInteractive` and `jupyter.runcurrentcelladvance`. Taking
it would reproduce the AREPL defect above exactly, and against extensions even
more widely installed. A key that dies on load order is worse than a key
nobody's fingers know yet.

In the installed extensions examined for the keybinding audit,
`Cmd+Shift+Enter` had no extension conflict. VS Code also binds it to
`editor.action.insertLineBefore` as a core default; Evalens's Python binding
takes precedence there. Other installed extensions or user shortcuts may
change the result, so use Keyboard Shortcuts Troubleshooting if needed.

**`Ctrl+Shift+Enter` is contested, so Windows and Linux need the same fix
AREPL needs.** `ms-toolsai.jupyter` binds `jupyter.runAndDebugCell` there with
**no `when` clause at all**, so unlike its two bindings above it is not gated
on `# %%` cells: it matches unconditionally, in any editor, in any file. The
user keybinding that wins:

```jsonc
  {
    "key": "ctrl+shift+enter",
    "command": "evalens.evaluateAndAdvance",
    "when": "editorTextFocus && editorLangId == python && !findWidgetVisible"
  },
  {
    "key": "ctrl+shift+enter",
    "command": "-jupyter.runAndDebugCell"
  }
```

The removal carries no `when` because the binding it cancels carries none;
a removal only cancels a binding it matches exactly. On macOS neither entry is
needed for that particular Jupyter binding. **Evalens: Evaluate and
Advance** is in the palette on every platform regardless.

## What print() shows

Printed output goes on the line, next to the code that printed it:

```python
print("hello")                    printed: hello
x = compute()                     x: 42   printed: warming up …(3 lines)
```

`printed:` is a label in the same `name: value` grammar as `x: [1, 2, 3]`, so
there is nothing new to read. One line of output *is* the annotation — the
`None` that `print` returns is suppressed, the way a `None` gives way to
anything better on the line — and several lines show the first with a count of
the rest. The whole text is on the hover, along with the link that opens the
**Evalens** output channel; the channel is also where output appears live
while a long loop is still running.

Set `evalens.printedLabel` to `»` if you want the marker terse instead of
spelled out. Python normally writes printed output to a stream called
`stdout`. A separate stream, `stderr`, often carries warnings and diagnostic
messages; output there does not by itself mean the code failed. `stderr:`
keeps its own name and is not painted in the error colour. The loop explorer
uses **Printed output** as its column heading and **Open statement printed output** /
**Open statement stderr output** as its actions regardless of the inline label setting.

The output channel never opens itself or takes keyboard focus. Use it for
streaming output during an evaluation, or the Values panel for structured
recorded results beside their source.

## Looking inside a value

An annotation is one line, which is exactly right for `[1, 2, 3]` and not
enough for a value with fields. Hover it, and if it is a plain name — `config`
in `config = {...}`, not `self.x` or `d['key']` — the hover adds a table of one
level of its children, type in braces, next to the value it belongs to:

```
config: {'host': 'localhost', 'port': 8080}

| Field    | Type    | Value          |
| -------- | ------- | -------------- |
| 'host'   | {str}   | 'localhost'    |
| 'port'   | {int}   | 8080           |
```

Nothing here is evaluated to build the table. A `@property` shows as a row
marked *not evaluated* rather than being read, and a field whose own class
overrides how it is indexed is left alone rather than walked — see
[design rule 3](development/design-rules.md#3-annotating-must-never-execute-user-code). Fields with their own children get
an **Explore ▸** link, which opens **Evalens: Inspect Value** as a QuickPick:
picking a field goes one level deeper, `$(arrow-left) Back` goes up, and
`Escape` closes it — a keyboard-driven way to walk a nested structure without
ever leaving the editor for a panel.

**Inspect Value reads the current namespace when explicitly requested.**
Its deeper readings can differ from an earlier annotation. For an immutable
recording, use **Open recorded value** in the Values panel.

Every level is fetched only when asked for and capped at 100 rows. Larger
structures show a bounded preview instead of walking every element.

## Answering input()

A file with `input()` in it prompts the first time a statement reaches it.
Later statement evaluations reuse the saved answers, so
iterating on the twenty lines below a prompt does not mean retyping it twenty
times. The stored answers are the running kernel's, keyed to the statement
that asked rather than to its line number, so inserting a line above a prompt
never shifts a saved answer onto the wrong one; editing the statement itself
starts it asking again. Whole-file evaluations also clear saved answers
when `evalens.resetOnLoad` is on (the default). **Evalens: Clear Input Answers** forgets everything
stored without touching the namespace, and restarting the kernel forgets it
too.

For an answer you never want to type, or one that should travel with the
file, write it in a comment instead:

```python
name = input("Your name: ")   # evalens: Ada
age  = int(input("Age? "))    # evalens: 34
```

The comment is never evaluated — the text after `evalens:` is taken literally,
so it is exactly as inert as any other comment even if it looks like code —
and it wins over a stored answer whenever both exist. `a, b = input(),
input()` reads a comma-separated list in order: `# evalens: Ada, 34` answers
the first read with `Ada` and the second with `34`. The value is always a
string, the same as `input()` itself always returns one, so `# evalens: 34`
gives `int(input(...))` a real `"34"` to convert rather than a number it never
had to.

Because the comment is ordinary Python, `python file.py` runs the file
exactly as written and still asks a person for real.

## The marker in the gutter

An annotation is a record of what a statement produced *when it ran*. Nothing
re-reads it, and nothing re-runs your code to keep it current — so editing a
line can leave an earlier reading beside code that has changed. The gutter
marker identifies that reading as stale; it does not infer the edited code's
result.

| Marker | Means |
|---|---|
| Unbroken bar | A recorded result from the last evaluation of this statement |
| Broken bar | Stale. The source changed or a dependency was rebound; this is an earlier reading, not a prediction of the next result |
| Bar and dot | The evaluation raised, and the message is the annotation |

**Only evaluating the statement again clears a stale marker.** Undo does not,
and that is deliberate: putting the text back does not put the value back,
because the kernel was never told anything. Whitespace-only edits — a
reindent, a formatter on save, a trailing space — do not mark anything, and an
edit that adds or removes lines inside a statement removes its annotation
outright, because there is then no statement for the value to sit beside.

**A value also goes stale when something it was computed from changes.**

```python
x = 1        x: 1
y = x + 1    y: 2
```

Edit the first line and re-run it, and the second is out of date without its
own text having changed at all. So Evalens marks it: re-evaluating a statement
marks every annotation *below it in the file* that reads a name it just bound.
Hover or look in Values to see the names and the first statement that re-bound
them. Rebinding means assigning a name again; the value itself may be
unchanged. **Go to variable change** navigates to that source without
evaluating it.
The link follows inserted or removed lines above the source; editing or
removing the source withdraws the link while keeping the named explanation.
Later changes do not replace this first cause. Re-evaluating the stale
statement clears it.

**Nothing is re-run to resolve staleness.** Evalens checks which names a
statement writes and reads. This dependency analysis does not track mutations
through aliases: `y = lst` followed by `lst.append(4)` can leave the earlier
`y` recording without a stale marker. An unbroken bar therefore does not
prove that a recorded object is unchanged in Python's current session.

## Screen readers

An inline result is a text decoration, and **the VS Code API gives a
decoration no accessibility label of any kind** — no `label`, no `role`,
nothing. `AccessibilityInformation` exists and is accepted by status bar
items, tree items and notebook cell status items; it is accepted by no
decoration type. So without a second channel, pressing the evaluate key
produces silence that sounds exactly like a dead keybinding.

Evalens adds that second channel. **The annotation is unchanged** — the answer
still goes on the line, and this is an addition for readers the line cannot
reach rather than a panel that moves it.

- **Evalens: Announce Result at Cursor** reads out what is painted on the
  cursor's line, whenever you ask for it. It needs no setting, it says
  `no result on this line` when there is nothing there, and it says `stale,
  edited since it ran` when the value no longer describes the code beside it —
  the caveat the gutter marker carries in a picture.
- **`evalens.announceResults`** makes that automatic for `Evaluate at Cursor`
  and `Evaluate and Advance`: each result is put into a notification, which VS
  Code raises an aria alert for, and the last one is kept in the status bar
  with an accessibility label on it. Set it to `always` to turn it on. It is
  on already if `editor.accessibilitySupport` is set to `on`, which is what VS
  Code's own accessibility documentation tells you to set when its detection
  does not find your screen reader.
- **A file load never announces.** Two hundred annotations from one keypress
  would be worse than announcing nothing.

Three limits are worth knowing before you rely on this.

**Notifications filtered to Do Not Disturb are not announced.** VS Code marks
them silent and skips the alert, so the announced channel goes quiet with
them.

**Announced results accumulate in the notification centre.** Each toast
dismisses itself after a few seconds, but the bell keeps a copy. Nothing about
`always` is free: the notification center retains these messages after the
toasts disappear.

**The status-bar summaries are silent.** `Evaluate File` reports what it
loaded through `setStatusBarMessage`, and that is backed by a shared status bar
item with no accessibility label — the status bar footer is rendered
`aria-live="off"`, so nothing there is announced when it changes. Reach the
last announced result with `workbench.action.focusStatusBar` and arrow onto
the Evalens entry; the load summary itself is not reachable at all yet.

Spoken text is not the painted text with the glyphs left in. `=>` is
punctuation a screen reader skips or spells out, a colon is silent, and the
three non-breaking spaces that separate two values on a line are heard as one
pause — so the announced form says `lst is [1, 2, 3]. x is 5`, leads a failure
with the word `error` because the colour carrying that distinction is
invisible, and stops after about three hundred characters rather than reading
out an eight-thousand-character list.

The command has **no default keybinding**. Every chord worth having in a
Python file is already claimed by something (see above), and picking one
without checking what owns it is how this project shipped a dead `Cmd+Enter`.
Bind it yourself:

```json
{
  "key": "ctrl+alt+a",
  "command": "evalens.announceResultAtCursor",
  "when": "editorTextFocus && editorLangId == python"
}
```

**A human screen-reader session has not been performed.** The wording, the
truncation and the caveats are covered by unit tests, and that VS Code fires
an aria alert for every notification was read out of its source — but those checks do not establish how usable the experience is with
VoiceOver, NVDA, or JAWS.

## Settings

All of these are under **Settings → Extensions → Evalens**, where each
description says what the option *costs* rather than what it is called.

| Setting | Default | What it buys, and what it costs |
|---|---|---|
| `evalens.pythonPath` | `""` | The interpreter to run the kernel with. Empty tries the Python extension's choice, then `python3`, then `python`. A path set here is never quietly replaced — if it does not work, Evalens says so instead of falling back |
| `evalens.progressDelay` | `750` | Milliseconds before a still-running evaluation earns a cancellable notification. Higher is a quieter window, at the cost of a longer silence before anything confirms the keypress and before there is a Cancel button |
| `evalens.resultColumn` | `0` | Column to line results up on. `0` follows the code, so nothing is pushed further right than it has to be. A fixed column tidies a file of plain assignments and wastes width after every short line |
| `evalens.loopValues` | `true` | Whether a `for` loop records target and body-name histories, or shows only final values. **Off is how you silence loop sequences**, and it stops the loop being instrumented rather than just hiding the result |
| `evalens.loopIterations` | `5` | Iterations listed before the rest are elided. More shows the shape of a run more clearly, at the cost of an annotation that pushes code off the right of the window |
| `evalens.readNames` | `true` | Whether the names a line merely reads are annotated. **Off is how you silence those**, at the cost of having nothing to say on any line that is not a binding — most lines in a real file |
| `evalens.readNamesPerLine` | `4` | Names annotated per line. More names, at the cost of a longer annotation on busy lines; the ones dropped are the ones furthest right |
| `evalens.printedLabel` | `"printed"` | What the annotation calls the output a statement printed. The word keeps the `label: value` grammar the rest of the line uses; `»` is the terse marker, and the one that survives every font VS Code falls back to |
| `evalens.advanceSkipsComments` | `true` | Whether Evaluate and Advance steps over comment lines. Off, it stops once per comment block — one more press each, and that press evaluates nothing |
| `evalens.announceResults` | `"auto"` | Whether a result is announced as well as painted, for a screen reader. `auto` follows `editor.accessibilitySupport`; `always` announces every one; `never` announces none. See above |
| `evalens.resetOnLoad` | `true` | Whether Evaluate File clears the namespace before running the whole file. On, a deleted binding is actually gone and a second file cannot read back an earlier one's leftovers. Off keeps expensive setup from an earlier load, at the cost of the namespace remembering more than the file defines — Evalens then notes it in the status bar. A selection never resets regardless; Run File as Script always does |
| `evalens.valuesPanel.follow` | `true` | Whether the values panel scrolls the row that just changed into view on every evaluation. On, each new recorded result is brought into view. Off stops evaluations from scrolling the panel. Cursor navigation is controlled separately by `evalens.valuesPanel.followCursor`. Flip evaluation following from the panel's own **Scroll to new results** checkbox as well as from here |
| `evalens.valuesPanel.outputLines` | `20` | Lines of a printed stream or a long value the panel shows before folding. Fewer lines fold sooner; more lines show a longer stretch at the cost of a taller row. Long single lines also fold. `Show more` keeps large expanded previews bounded; `Open recorded value` and stream actions open the available recording in a read-only editor. Nested-loop output uses bounded parts and shows at most 20 lines per part |
| `evalens.valuesPanel.followCursor` | `true` | Reveal the matching value when moving the editor cursor, and reveal source when navigating Values rows. Keyboard focus stays in the pane you use. Turn off with **Link code and values** in the panel to browse independently; clicking a row or pressing Enter/Space still reveals source. Use Up/Down or Home/End to browse rows. Navigation only reads captured results |
| `evalens.inlineValues` | `"always"` | Whether inline value and error chips paint in the editor while the Values panel is also visible. `always` paints both; `whenPanelHidden` hides the inline chips while the panel is open on its Values tab and brings them back the moment it is not. Gutter markers, the evaluated region, and the running/asking marks are unaffected either way, and the hover keeps showing a hidden value |

Two of them are off switches on purpose. Loop sequences and read-name
annotations are the two things Evalens adds that a reader might not want, and
uninstalling is not an adjustment. Turning either off stops the work as well
as the display: an uninstrumented loop costs nothing per iteration.

Setting names are one shape: `evalens.` followed by a camelCase noun phrase
naming the thing configured, subject first, so the alphabetical settings list
keeps `loopIterations` beside `loopValues`. `alignColumn` was the odd one out
and is now `resultColumn`.

### What is deliberately not a setting

Everything here was considered and declined. Each is a constant in the source
with the reason written beside it, so the next person can argue with the
reason rather than guess whether anyone thought about it.

There is deliberately **no setting for the keybindings**. VS Code rebinds keys
natively and does it better than a setting could — a user keybinding is the
only thing that wins the load-order tie described above, and an
`evalens.keybinding` would lose it exactly as the manifest does.

Nothing hides **printed output**. `evalens.printedLabel` renames it and no
setting suppresses it, because the output is the statement's own doing: hiding
it would hide what your code did rather than what Evalens added. The two off
switches above exist precisely because loop sequences and read names are the
opposite — things Evalens says on a line that you did not ask it to say.

Nothing hides the **`(partial: line 19)` caveat** a value carries when the rest
of the file did not parse. An annotation without it claims to have been
computed with the whole file, and a value that asserts more than we know is
the defect this project exists to stop.

There is no setting to turn the **values panel's fold** off. A statement that
prints ten thousand lines still gets a bounded preview. Ordinary text starts
at 2,000 characters or `evalens.valuesPanel.outputLines`, whichever comes first.
`Show more` raises the preview to at most 16,000 characters in a scrolling area;
`Show all` is offered when that includes everything. The contextual open action opens the
available recording in a read-only editor. Its tab names the source file,
statement lines and value or stream. The lock item in the status bar explains
the scope and capture limits. Native **Find** searches the opened recording,
including text beyond the panel preview. Selection and copy use the recorded
text, without added headings; VS Code may normalize line endings.

Stream actions open the whole statement's available printed or stderr output,
including all its loops. They do not limit the text to a selected iteration.
A recorded value is a saved representation or history summary, which can
already be truncated; opening it does not inspect the live object. Existing
capture-limit notices remain visible. Recordings stay unchanged when code is
run again, and panel folds, pages and selection remain available on return.
Close a recording's tab to release it. Recordings do not survive reloading VS
Code, and opening many recordings eventually asks you to close one first.
This is separate from **Evalens: Inspect Value**, which reads the current
namespace when explicitly requested.

Nested loops page retained entries and output parts
instead of expanding an arbitrarily large tree.

**Evaluate and Advance** stops at the last statement rather than wrapping to
the top, and centres its destination only when that destination is off screen.
Wrapping would re-run every side effect in a file somebody has just finished
walking; the reveal alternatives either scroll on every press or land the next
statement on the bottom edge with none of its code visible.

The numbers left over are transport guards and runaway guards rather than
taste — how large a value may be on the wire, how long a prompt may be, how
many annotations one file load may paint. A cap the far end is allowed to
raise is a suggestion rather than a guard, and someone who hits the annotation
limit does not want a bigger number: they want to know their first import
failed.

### Colours

Every colour Evalens paints is a contributed theme colour, which means all of
them are already overridable in `settings.json` — per theme, if you like —
without the extension offering a setting of its own:

```jsonc
"workbench.colorCustomizations": {
  "evalens.resultForeground": "#d1a35c",
  "evalens.resultBackground": "#00000000",
  "evalens.labelForeground": "#8d7a5a",
  "evalens.outputLabelForeground": "#5c7fa6",
  "evalens.errorForeground": "#f14c4c",
  "evalens.errorBackground": "#00000000",
  "evalens.evaluatedRegionBackground": "#4a9c8c22",
  "evalens.currentLineBackground": "#ffffff0d",
  "evalens.pendingForeground": "#8c8c8c",
  "evalens.pendingRegionBackground": "#8c8c8c26",
  "evalens.askingForeground": "#e8963c",
  "evalens.askingRegionBackground": "#e8963c66",
  "evalens.flashRegionBackground": "#4a9c8c66",
  "evalens.annotationBorder": "#e6ad45",
  "evalens.annotationTint": "#d1a35c1a",
  "evalens.chipDivider": "#d1a35c66",
  "evalens.staleTint": "#8c8c8c0d",
  "evalens.staleBorder": "#8c8c8c"
}
```

Those are the dark-theme defaults, so the block above changes nothing until
you edit it. If you dislike the gold, the first line is the whole fix.
`resultBackground` and `errorBackground` are contributed but not currently
painted anywhere: #95 moved every state's background onto the shared
`annotationTint` below, so setting either of the first two no longer changes
anything. They stay contributed rather than removed, so a customization
already made against them does not silently start failing.

`currentLineBackground` adds a neutral wash to the exact source line linked
to the visible Values panel. A short square amber gutter tick marks the same
line, beside any evaluated, stale or error symbol. It leaves syntax colors
intact. The gutter images have light and dark variants, like the existing
state icons. Finished statements keep the editor background;
`evaluatedRegionBackground` remains the scrollbar mark and temporary
selection-snap highlight. Pending, input and brief success feedback remain.

`askingForeground` and `askingRegionBackground` are the one line on screen
that is blocked on `input()` rather than merely slow — orange rather than
grey because nothing moves until the reader answers, and never red, because a
prompt is not a failure.

An annotation is painted in three colours rather than one, because it carries
two kinds of thing. Values -- what the program produced, including the text
after `printed:` -- take `resultForeground`. The labels that introduce them --
`x:`, `y:`, the `=>` separator, the `…+N more` footnote -- take
`labelForeground`, a desaturated version of the same hue, so a name and its
value read as one unit. `printed:` and `stderr:` take
`outputLabelForeground`, which leaves that hue family entirely because output
is a different kind of thing from state. Text labels also distinguish values
from output, so interpreting them does not depend on recognizing the colors
alone.

Two more things mark an annotation as a distinct surface, rather than a
second comment sitting next to one you typed. A faint `annotationTint`
washes behind the whole of it, one continuous surface from its first
character to its last — a tint is what a glyph cannot have, which is what
makes the annotation read as structure rather than as a stray character. On
its leading edge, a 3px `annotationBorder` bar, corners squared rather than
rounded so it cannot be mistaken for a parenthesis, with 8px of breathing
room at each of the annotation's two outer ends so the tint does not hug the
text it introduces; the trailing edge rounds instead. The evaluated bar is
amber in both the editor and Values panel, darker on light themes so its
edge stays visible. `workbench.colorCustomizations` can still override it.
The tint takes `resultForeground`'s own hue at low opacity,
with the opacity defined by the theme. The bar takes on the
colour of whatever state the annotation is actually in: `pendingForeground`
while still running, `staleBorder` when stale, and `errorForeground` on a
raised statement. A bare line with no annotation never gets either.

Where a line carries several values — a label and the value it introduces,
or `printed:` and its text — a 1px `chipDivider` hairline separates one from
the next, with 8px of clear space on each side of the rule. It is its own
colour rather than `annotationBorder`, because the two answer different
questions: the bar says what state the line is in and changes with it, the
divider says where one fact ends and the next begins and does not, whatever
state the line is in. The tint stays continuous straight through it, so the
line still parses into distinct facts without the surface itself breaking
into separate boxes the way an earlier revision painted it.

## License

MIT — see [`LICENSE`](../LICENSE). The inline rendering approach is taken from
[Calva](https://github.com/BetterThanTomorrow/calva), which is MIT as well;
matching the licence is the plain form of the attribution
[`IDEA.md`](../IDEA.md) records as intended.
