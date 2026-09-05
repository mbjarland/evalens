# Evalens — Calva-style inline evaluation for Python in VS Code

## The idea

Put the cursor on a line, hit a key, and see the resulting value painted
**inline in the buffer** next to the code — not in a side panel, not in a
terminal, not in a notebook cell, and without starting a debugger.

```python
lst = [1, 2, 3]                    => [1, 2, 3]
y = lst
y.append(4)
lst                                 => [1, 2, 3, 4]
squares = [x**2 for x in range(5)]  => [0, 1, 4, 9, 16]
```

This is precisely what [Calva](https://calva.io) gives Clojure developers,
and what Python does not have.

## Why this doesn't already exist

Not because it's hard. Because the demand got absorbed by notebooks.

Clojure's inline evaluation exists because the community standardised on
**nREPL** — a network REPL *protocol*. Any editor can connect to a live,
stateful runtime, send a form, get a value back, and render it. REPL-driven
development is Clojure's defining cultural practice, so every editor
plugin implements it.

Python has an equivalent protocol — the **Jupyter kernel protocol**
(ZeroMQ, stateful out-of-process runtime). It's good. But the UX the
community built on top of it went to *notebooks* and the Interactive
Window (`# %%` cells), never to editor overlays. The energy that produced
Calva in Clojure produced Jupyter in Python.

### Marketplace evidence (September 2026)

The entire "live Python evaluation" category:

| Extension | Installs | Last updated |
|---|---:|---|
| `almenon.arepl` | 2,131,982 | 2024-11-19 |
| `xirider.livecode` | 1,355,020 | **2020-06-26** |
| `VentureCasserole.python-live-evaluator` | 1,486 | 2025-09-15 |
| `wuhy.live-coding` | 980 | 2026-02-07 |
| `srejv.python-inline-eval` | 63 | 2026-04-14 |
| `gideonnnalue.pyroo` | 18 | 2026-08-07 |

One project won the category (AREPL, 4.9★) and then stopped being
updated. Everything else is a rounding error. Critically, **none of them
render values inline** — AREPL's own `inlineResults` setting is
documented as *"(Currently just error icons)"*. Values go to a side panel.

So the gap is real, and it is not crowded.

## Architecture

Three pieces. All three are available; two were verified before writing
this document.

### 1. A live, stateful runtime

Two viable options:

**(a) Roll your own — ~30 lines, zero dependencies.** A subprocess running
a loop: read code over a pipe, `exec()` it into a persistent namespace
dict, write back the `repr()` of the requested target.

You do **not** need the notebook protocol for this. Jupyter kernels buy
rich display (images/HTML), interrupt, restart, and multi-language
support — none of which inline scalars and collections require.

That held until Cancel. **The kernel now runs two pipes, not one**, and
the reason is worth recording because it is not obvious from the outside:
the pipe carrying requests has exactly one reader, and while user code is
running that reader is busy. Anything that must be dealt with *during* an
evaluation — an interrupt, above all — cannot travel on it, because the
only code that could read it is the code you are trying to interrupt. So
requests keep the standard streams and a control channel gets a second
pair of descriptors, serviced by a thread that is never blocked.

That is the shape of Jupyter's shell and control channels, arrived at the
same way. It is not the notebook protocol and does not want to be: no ZeroMQ,
no message signing, no session identities, four message kinds. The lesson
taken from Jupyter here is the channel split, not the wire format.

**(b) Borrow Jupyter's kernel.** The `ms-toolsai.jupyter` extension
exposes `IExportedKernelService` / `getKernelService` to third-party
extensions (verified present in the shipped bundle of
`ms-toolsai.jupyter-2025.8.0`). This hands you a managed kernel rather
than babysitting a process, at the cost of depending on the notebook
stack.

Start with (a). Graduate to (b) only if rich display becomes worth it.

### 2. Deciding what to evaluate

This looks like the hard part, because Clojure gets it free from
s-expressions: "the current form" is unambiguous when everything is
parenthesised. Python needs real parsing.

It turns out to be easy. `ast` has exact end positions (`end_lineno`,
`end_col_offset`) since Python 3.8. Roughly 40 lines of stdlib resolves
the form under a cursor — see `prototype/form_at_cursor.py`, which was
run against real files and produces:

```
cursor line 9   ->  exec 'tup = (1, 2, 3)'                  then show  tup
cursor line 33  ->  exec 'evens = [x for x in range(20)...]' then show  evens
```

This also solves the **statement-vs-expression problem**. In Clojure
everything returns a value; in Python `x = [1, 2, 3]` is a statement that
returns nothing. The resolution: exec the statement, then separately
evaluate the assignment *target* and display that. For a bare expression
statement, just display its value.

A `for` loop is the exception, and the interesting one. Its target holds
only the last element once the loop is over, so reading it afterwards
throws away every iteration but one — which is the thing you ran the loop
to watch. The body is instrumented instead: a recorder injected as its
first statement takes `repr()` of the target as each iteration begins, and
the annotation shows the sequence, bounded — `p: 1, 2, 3, 4`, or
`p: 0, 1, 2, 3, 4, … (+9,994 more) … 9999` for a long one. It is the one
place a value is shown without the target being re-read afterwards;
`kernel/loops.py` carries the reasoning.

A second recorder, injected as the **last** statement of the body, watches
the names the body binds — because the target is usually the *input* being
iterated and the body binding is usually the *computed result*, which is
the half the reader came for. `for v in x:` with `u = 4 * v` inside
annotates `v: 1, 2, 3   u: 4, 8, 12`, where `u` used to be one value read
out of the namespace, sitting beside a history and reading as its last
entry. Last rather than first, because `u` does not exist yet at the top of
the first pass. The consequence to design for rather than paper over: an
iteration that hit `continue` or `break` computed no result, so the two
sequences are **not** the same length — and a filter loop is where anything
that renders them as parallel columns gets caught.

**One value per statement is the wrong unit**, though, and that is the
second half of the answer. It is right for a binding and has nothing to
say for everything else, which is most lines: `print("y unaffected by
rebind:", y)` returns `None`, and `None` is true, useless and misleading
on the line whose whole point is `y`. So Rider's model rather than a
REPL's — annotate the *names on a line*, several of them, as separate
`name: value` pairs:

```
x = [1, 2, 3]                              x: [1, 2, 3]
y = x                                      y: [1, 2, 3]   x: [1, 2, 3]
y.append(4)                                y: [1, 2, 3, 4]
print("y unaffected by rebind:", y)        y: [1, 2, 3, 4]
```

The names come from the AST — what the statement binds, then what it
reads — and their values from a plain dictionary lookup in the namespace,
which cannot run user code and so is safe to do unbidden. Bare names
only, for that reason: `obj.attr` may be a property with a body. Callables
and modules are skipped as noise, and the count per line is capped — with
the line saying `…+1 more` where the cap bit, since a reader who counts
five names on the line and four values beside it cannot otherwise tell
whether the fifth was omitted, unreadable, or somehow not a name.

`=>` survives for a genuine expression that is not a binding, because
`sum([10, 20]): 30` would repeat the line back at the reader. A produced
`None` gives way when the line has anything else to show, and stays when
it does not — `d.get('missing')` on its own really did answer `None`. What
is suppressed moves to the hover rather than away.

**A pair already shown above is not repeated.** Annotating every statement
makes repetition, not the annotation, the dominant visual problem: four
consecutive lines calling methods on one dict each restate it, and the
file reads as a log rather than as a worked example. So a `name: value`
pair whose value has not changed since that name was last painted above is
dropped, and a line left with nothing new carries nothing at all. Three
parts of that are load-bearing. A **changed** value always appears — it is
the most interesting thing this can show, and `lst` becoming
`[1, 2, 3, 4]` above is the example the whole design is built on. The
comparison is on the **rendered string**, not on object identity: a line
calling a method may have mutated what it read, and what the reader needs
to know is whether the shown value changed. And **above means earlier in
the file**, scrolled into view or not — annotations that appeared and
vanished as the file scrolled would be worse than the repetition they
removed.

**An explicit evaluation is exempt from it.** The rule belongs to bulk
annotation, where nobody is waiting on any particular line. When somebody
puts the cursor on a line and presses a key, something must visibly
happen: silence because the value is unchanged and mentioned above is
indistinguishable from the keypress being ignored.

**An annotation earns its place by differing from what the reader can
already see.** That is the one rule the paragraph above and several others
are each an instance of — a docstring annotated with its own text, a value
repeated from a line above, and a `def` annotated `greet: greet(name)`,
which says the name twice and what kind of thing it is not at all. The
rule itself, and the three separate arrivals at it, are recorded as rule 2
of [`docs/development/design-rules.md`](docs/development/design-rules.md);
what belongs here is what it decides about the display.

Three consequences, all from that one sentence. A description leads with
Python's own keyword — `def greet(name)` beside `class Config(name,
port=8080)` — because the word is the part a signature cannot say, and it
is what makes `f = greet` read `f: def greet(name)`. The `name:` label is
dropped when the description already opens with that name. And an
annotation whose text merely restates its own line is not painted at all;
the evaluated-region highlight is what still reports that the statement
ran.

**The last of those compares rendered text, never the kind of statement.**
A `def` is where the shortcut looks safest and would do the most damage:

```
@shout
def greeting():        greeting: def <lambda>()
```

The decorator *replaced* the function, the line cannot show that, and this
is the most valuable annotation on the page. A rule that skipped function
definitions would have deleted exactly it. What is redundant is a piece of
text, so text is what gets compared.

### 3. Rendering the overlay

`vscode.window.createTextEditorDecorationType({ after: { contentText: ' => [1, 2, 3]' } })`
followed by `editor.setDecorations(...)`.

This is the same mechanism Calva uses, and Error Lens, and inlay hints.
Well-documented, well-trodden.

## The genuinely hard parts

- **Ordering and state.** Evaluating line 40 requires lines 1–39 to have
  run. Calva has this exact problem and solves it socially: you evaluate
  top-down and the REPL holds state. The same answer works here. An
  optional "run everything above this line" command covers the rest.
- **Side effects on re-evaluation.** Re-running `db.execute(...)` is bad.
  Manual trigger (Calva's model) sidesteps this entirely — which is
  exactly why AREPL, running continuously, needs its `unsafeKeywords`
  blocklist hack. Prefer explicit evaluation.
- **`input()` settles the continuous-vs-manual argument.** Beginner and
  course code is full of `input()` prompts, and beginners write infinite
  loops constantly. Any evaluate-as-you-type mode relaunches a program
  that is *blocked waiting on stdin* every time the user pauses typing.
  This is not a tuning problem, it is a category error: continuous
  evaluation is only coherent for pure, terminating code. **Manual
  trigger must be the default**, and any continuous mode should be
  opt-in per file rather than global.

  This was discovered empirically while setting up a first-year student's
  environment: a `watchfiles`-based run-on-save loop had to be abandoned
  for exactly this reason, on a file named `intrprog.py`.

  With manual triggering settled, prompting is answerable, and it is
  answered: a `sys.stdin` that asks the extension for a line and blocks
  for the reply. **The interception point is stdin and nothing else** —
  one object, through which `input()`, `readline()` and `read()` all
  pass. Anything demanding a real terminal (`getpass` where a tty exists,
  `curses`, GUI toolkits) is out of scope and stays out; the failure to
  avoid was never "too many functions to hook", it was hooking something
  that needs a terminal and half-succeeding.

  Both commands prompt, because in both cases someone is sitting there.
  Loading a file refused to for a while, citing Jupyter — where the flag
  is false for `nbconvert` and `papermill`. That was a misreading:
  those are *unattended*, and the flag exists so that a batch conversion
  nobody is watching fails loudly instead of deadlocking. `Cmd+Alt+Enter`
  is a person pressing a key. Refusing produced a red `EOFError` on the
  prompt line and a cascade of `NameError` under it, because nothing
  downstream had the value — the command that exists to set up a session
  refusing to, on exactly the teaching files it was built for.

  Twenty prompts in a file is still a real worry, and it is answered
  where the person is: the blocked line is marked and revealed so the box
  is never disembodied, and from the second prompt of a load the box
  carries a way to skip the rest. Cancelling one prompt still sends
  end-of-file and raises `EOFError` for that statement alone; the load
  continues, because a broken line is not a broken load.

  The box stays at the top of the window. A genuinely inline editable
  field needs the Comments API, whose zone widget pushes every line below
  it down — reflowing the column of values the reader is in the middle
  of. `WebviewEditorInset` is the right shape and is not in the stable
  API.
- **Value formatting.** Truncation limits, nesting depth, hover-for-full,
  and sensible `repr()` handling of large or cyclic structures.
- **Decoration lifecycle.** Reposition annotations as the document
  changes, dismiss on Escape, and *mark* what an edit touched rather than
  clearing it. Fiddly rather than difficult.
- **Staleness, which is the price of the trace.** An annotation shows
  what a statement produced when it ran and is never re-read, so an edit
  puts the value and the code out of step — the notebook's oldest
  failure, reproduced in a text file with two statements. The answer
  every tool that met this converged on is *mark stale, never re-run*:
  CIDER turns its green fringe marker amber when a form is edited,
  meaning "out of sync with what the REPL has" rather than "wrong", and
  Mathematica has carried per-unit state in the cell bracket since 1996.
  So Evalens paints a three-state marker — evaluated, stale, error — in
  the **gutter**, and not on the annotation: dimming the value would put
  a claim about the value in competition with the value, in the one place
  on screen the reader is reading. JupyterLab was asked for exactly that
  and declined. Re-evaluating clears the mark and nothing else does, undo
  included — the buffer can be put back, the kernel cannot, and only an
  evaluation is entitled to say the two agree again.

  Marking an annotation when its own text changes catches the obvious
  case and misses the common one. `x = 1` / `y = x + 1`: edit and re-run
  the first line and the second still reads `y: 2`, untouched by the
  edit, correctly positioned, and describing a world that no longer
  exists. Its own text never changed, so nothing about it can catch this.
  So the kernel also reports, per statement, the module-level names it
  bound and the ones it read — the same `ast` walk that resolves the
  form, asked a second question — and re-evaluating a statement that
  binds `x` marks every annotation *below it in the file* that reads `x`.
  Same marker, same vocabulary; the reader does not need to know which of
  the two reasons produced it.

  **It marks and it never runs anything.** That boundary is the whole
  design and it is one increment from being lost: a marker plus "and
  re-run the dependant" is a reactive notebook, which #40 ruled out and
  which cannot be made reliable in Python anyway. The analysis is
  deliberately unsound in the safe direction — aliasing and mutation
  defeat it, and `lst = [1, 2, 3]` / `y = lst` / `lst.append(4)`, this
  document's own opening example, is precisely the case it cannot see.
  That is affordable because the output is one grey pixel. It would not
  be if the output were an execution, which is exactly why marimo's
  documentation says tracking mutations reliably is impossible in Python,
  and why nbsafety pays a 1.44× median slowdown for the version that
  catches them.

## Prior art: take the display approach from Calva

**Calva is the reference implementation for the rendering, and we should
follow its lead rather than rediscover any of this.** Not by copying code
— by reading how it solves each problem and being guided by it. Calva is
MIT licensed, so even direct reuse with attribution would be permitted,
but the value here is the design, not the lines.

Attribution to Calva for the rendering approach is intended and welcome.

### Where to look

`BetterThanTomorrow/calva`, file **`src/providers/annotations.ts`** — 217
lines, and it is essentially the entire feature. Related:
`src/results-output/` for result formatting and
`src/debugger/decorations.ts`.

### What it already solves that we listed as hard

Reading that one file collapses several open questions:

- **Whitespace is eaten.** VS Code collapses ordinary spaces in
  decoration `contentText`. Calva substitutes non-breaking spaces
  (`U+00A0`) into the result string before rendering. This is
  non-obvious, and without it any alignment or indentation inside a
  rendered value collapses.
- **Decorations smearing as you type.** Solved with
  `rangeBehavior: vscode.DecorationRangeBehavior.ClosedOpen` on the
  result decoration, which controls whether the decoration absorbs text
  inserted at its boundaries. This was on our "fiddly" list; it is a
  one-liner.
- **Theming.** Colours come from `new vscode.ThemeColor(...)` rather than
  hardcoded values, so results adapt to the user's theme and remain
  overridable through `workbench.colorCustomizations`.
- **Two decoration layers, not one.** The result text is an `after`
  decoration; the *evaluated region* gets a separate background
  highlight. Keeping them separate is what makes the UX legible.
- **Evaluation state is visible.** An `AnnotationStatus` enum
  (`PENDING` / `SUCCESS` / `ERROR`) drives distinct region colours, so
  the region greys while evaluating and then reads green or red. This is
  most of what makes the feature feel alive rather than static.

  Two departures from Calva, both forced by loading a file painting every
  value. **Pending goes on at the keypress**, before the kernel is asked,
  because otherwise the fast path — nearly every evaluation — has no
  transition at all and re-running a line repaints an identical string.
  And **success is a brief flash rather than a standing colour**: once
  every line carries a value, a permanent green distinguishes nothing,
  so what says which statement just ran is the emphasis decaying. Julia's
  extension flashes the evaluated range for about 200ms; that is the
  shape.

  **One flash mechanism, two uses.** Showing how far a selection snapped
  outward is the same gesture over a longer window — 1,500ms, in the
  evaluated-region colour — so it is one class parameterised by a colour
  and a duration rather than two. Two implementations would mean two
  timers over the same editor, and a snap highlight and a success
  emphasis can land on the same statement; whichever expired second
  would clear decorations the other had just painted.

  Pending carries an optional message rather than being a boolean.
  "Still running", "the kernel has not started this yet" and "waiting for
  you to answer `Enter a value:`" are three different things the reader
  has to tell apart, and Jupyter's inability to separate them is its
  best-known interface complaint.
- **Overview ruler marks.** `overviewRulerColor` +
  `OverviewRulerLane.Right` puts evaluated regions in the scrollbar, so
  they are visible at a glance in a long file.
- **Per-document decoration state**, keyed by `document.uri`, so
  decorations clear and restore correctly per editor.
- **Errors get their own colour and hover text**, rather than a separate
  presentation mechanism.

### Also worth reading

- **AREPL** — `almenon/AREPL-vscode`. Solves the continuous-execution and
  value-serialisation problems (`repr()` handling, truncation, nesting
  depth), even though it renders to a panel rather than inline.
- **VS Code itself.** Setting `"debug.inlineValues": "on"` makes the
  editor paint variable values inline, greyed, beside the code while a
  debug session is paused. That is a *first-party* implementation of
  precisely the rendering this project wants, already solving placement,
  theming, truncation and update-on-step. It is worth studying how the
  debug adapter feeds it before designing a decoration layer from
  scratch — and it is also the honest answer to "what can I use today",
  its only cost being that it requires a paused debug session.

### The author is reachable

Calva is written by Peter Strömberg (Pez), who is known to the owner of
this project. Design questions about *why* something is done a particular
way can be asked directly rather than reverse-engineered — likely the
single cheapest way to de-risk the rendering work.

## Scope of a first prototype

The smallest thing that proves or kills the idea:

1. 30-line subprocess kernel holding a persistent namespace.
2. The AST resolver (already written and working).
3. `Cmd+Enter` → evaluate the statement under the cursor → paint the
   value inline as a decoration.

No continuous mode, no rich display, no kernel management. If that feels
good to use, the rest is incremental. If it doesn't, very little was
spent finding out.

Estimated effort: a weekend for the prototype, a few more to reach
something daily-drivable. `yo code` scaffolds the TypeScript extension.

## Naming and marketplace positioning

The name is **Evalens** (eval + lens). A marketplace search for "evalens"
returns zero results, so it is unclaimed.

The reasoning: **Error Lens has 9,780,508 installs**, and `*-Lens` has
become recognised shorthand for "paints information into your editor."
Landing in that mental category is free positioning. As a second data
point, `TylerLeonhardt.vscode-inline-values-powershell` has 115,525
installs — the "inline values for X" framing demonstrably sells, in a
language with a fraction of Python's user base.

### Use both name fields

`package.json` exposes two separate fields, so brandability and
searchability are not a trade-off:

```jsonc
"name":        "python-inline-values",           // id + marketplace URL slug: pure SEO
"displayName": "Evalens — Inline Python Values",  // shown to humans: brand + keywords
```

### Other listing metadata that matters

- **`keywords`** are indexed by marketplace search:
  `python, repl, inline, live, values, evaluate, calva, nrepl, arepl,
  print debugging`. Including `calva` and `arepl` is deliberate — people
  searching those terms are precisely the target audience.
- **`categories`**: `["Debuggers", "Visualization", "Programming Languages"]`
- **`description`** renders as the single line under the name in search
  results, so it should be the pitch rather than a summary. Something
  like: *"See values inline as you type. No print(), no debugger, no
  notebook."*

### What actually converts

For a visual extension, an **animated GIF at the top of the README**
outsells the name by a wide margin. Every extension that has won this
category leads with one above the fold, Error Lens included. A viewer
scrolling search results decides in about two seconds, and a five-second
loop of values appearing on `Cmd+Enter` does that work. This deserves
more effort than the naming did.

## Motivation

Written while setting up a Python development environment for a student
beginning a five-year university programme. The absence of this workflow
in Python — coming from Clojure, where it is table stakes — was the
prompt.
