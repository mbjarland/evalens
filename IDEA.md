# Evalens — inline evaluation for Python in VS Code

> Status: Current
> Audience: AI agents, the maintainer, and anyone deciding whether this is
> worth building
> Source of truth for: what Evalens is, what it is not, and why it exists
> Last verified: 2026-09-05

## The idea

Put the cursor on a line, press a key, and see what that line produced painted
**in the buffer beside the code**. Press it again on the next line. Keep
going, and the file fills up with its own values, top to bottom, each one
sitting where it was computed.

```python
lst = [1, 2, 3]        lst: [1, 2, 3]
y = lst                y: [1, 2, 3]   lst: [1, 2, 3]
y.append(4)            y: [1, 2, 3, 4]
lst                    lst: [1, 2, 3, 4]
```

That is real output, not a sketch: it is what the kernel, the resolver and the
renderer produce end to end, and `src/test/integration.test.ts` asserts those
four annotation strings against the running kernel.

Read the block rather than the mechanism. Four lines, four answers, all
visible at once, in the order they appear in the file — and the fourth line is
the lesson, because `lst` changed without `lst` ever being on the left of
anything. A terminal shows those four values one after another and then
scrolls them away. A debugger shows the last one. Neither shows the *shape* of
what happened, which is what someone learning aliasing is trying to see.

## The claim

> **The notebook feedback loop, on a file that never stops being source code,
> with the state visible instead of hidden.**

Every part of that has to be earned, and two thirds of it is already available
from Microsoft. What follows says exactly which.

## What already exists

This category is not empty. It is occupied differently than an earlier draft
of this document claimed, and being precise about the difference matters,
because a plan built on "nothing does this" is a plan built on a falsehood.

### Smart Send — the closest thing, and it ships turned on

`python.REPL.enableREPLSmartSend`, in `ms-python.python`, default `true` since
the November 2023 release. Verified here against the installed extension
(`ms-python.python-2026.4.0`), whose own description reads:

> "Toggle Smart Send for the Python REPL. Smart Send enables sending the
> smallest runnable block of code to the REPL on Shift+Enter and moves the
> cursor accordingly."

Read that carefully, because it describes most of this project. It resolves
the smallest runnable chunk under the cursor using stdlib `ast` — the
implementing ticket is titled *"Implement smart shift+enter using AST"*
(microsoft/vscode-python#21778) — sends it to a live, stateful REPL, and
advances the cursor. One key, cursor-based, persistent namespace, no changes
to the file, first-party, already installed on every machine that has the
Python extension.

**So AST form resolution is not the clever part, and this document used to
claim it was.** It is forty lines of stdlib, and Microsoft shipped it first.
`kernel/resolver.py` is 861 lines rather than forty because of what it decides
*after* resolving — which value may be read back without running user code,
which names a line should report, where a compound statement's answer belongs,
how to answer from a file that does not parse — not because finding the
statement is hard. Anyone proposing work on the grounds that form resolution
is the differentiator should be pointed here.

What Smart Send withholds is the answer's location. It goes to a terminal:
somewhere other than the code, in execution order rather than file order, and
gone as soon as the next thing scrolls past. Evaluate line 5, then line 20,
and line 5's answer no longer exists anywhere.

There is a second thing, which is evidence rather than argument and belongs in
the record because of who this is for. **On the maintainer's machine, Smart
Send did not work at all.** `Python: Run Selection/Line in Python Terminal`
answered *"Invalid arguments to create terminal"*, and selecting an
interpreter did not fix it. Evalens ran in the same window, because #29 made
interpreter resolution probe each candidate and use the first that actually
runs rather than trusting what the environment reports. One machine is not a
study and this is not offered as one; it is offered as the reason design rule
6 exists.

### The Jupyter Interactive Window — a notebook wearing a `.py` extension

`# %%` cells give a `.py` file the notebook loop: a persistent kernel, rich
output, run-this-block-and-move-on. It ships with the Python extension and it
genuinely works.

An earlier version of this document had it in the competitor table as "the
persistent namespace on a plain source file", and that was wrong. The
maintainer's reaction on being shown how to use it settles it:

> *"oh you are essentially talking about making a notebook and just using the
> code blocks"*

Exactly so. Without percent markers the context key `jupyter.hascodecells` is
false and the Run Cell keybindings do not fire at all; the markerless route is
to select code and press `Shift+Enter`, which is not a cursor workflow, because
you must say what runs every single time. Using it properly means
notebook-ifying the file: markers that exist only for the tool, that Black
merges or destroys inside indented blocks (jupytext#562), and the habit of
running blocks in whatever order you like while the state that results is
visible nowhere. And the answers still land in a side panel.

### `debug.inlineValues` — first-party inline values, and stronger than assumed

VS Code paints variable values inline, greyed, at the end of lines. This is
not a plan; it shipped, and it is **on by default**. Verified in VS Code
1.136.1: `debug.inlineValues` has `enum: ["on", "off", "auto"]` and
`default: "auto"`, where auto means *"Show variable values inline in editor
while debugging when the language supports inline value locations"*. Python
supports them — both `ms-python.debugpy` (2026.6.0) and `ms-python.python`
call `registerInlineValuesProvider`.

The honest position is therefore worse for Evalens than the ticket that
commissioned this rewrite assumed. There is no flag to set. Put a breakpoint
in a first-year student's short top-to-bottom script, press F5, and values
appear inline, with a Variables pane, hovers and a debug REPL alongside,
having installed nothing.

What it is not, statable from the API rather than from argument — from the
`@types/vscode` in this repository's own `node_modules`:

- `InlineValuesProvider.provideInlineValues` is documented as called
  *"whenever debugging stops in the given document"*.
- `InlineValueContext` requires a DAP `frameId` and a `stoppedLocation`.

It is structurally step-shaped. It repaints when execution halts somewhere and
it shows the current frame's current values — the state *now*, not what each
line produced when it ran. A paused frame has exactly one moment and it is the
last one, which is why this document's own opening example is invisible to it:
by the time you are stopped after `y.append(4)`, `lst` and `y` both read
`[1, 2, 3, 4]` and the thing worth learning has already happened.

Underneath sits the property a debug session structurally cannot have: **the
namespace survives edits.** A debug session cannot redefine a function and
carry on; it restarts and re-runs from the top. That is the Lisp workflow, and
it is why this is a REPL rather than a viewer.

That said, this is where the margin is thinnest, and pretending otherwise
would defeat the purpose of rewriting this document. On the exact motivating
case — a beginner's short script that runs top to bottom — a breakpoint on the
last line and F5 gets a long way for free, and the two advantages left are a
value per line rather than final state, and a namespace that survives edits,
the second of which a first-year student barely exercises. The first
advantage is real and is the aliasing lesson in the opening example. Whether
it is worth an install to somebody who is not already convinced is a question
for #77 and its real course, not for this paragraph.

### AREPL and the rest of the marketplace category

The extensions that set out to do this specific thing. The install counts
below were gathered when this document was first written, in September 2026,
and have **not** been re-verified since; treat them as an order of magnitude
rather than a measurement.

| Extension | Installs | Last updated |
|---|---:|---|
| `almenon.arepl` | 2,131,982 | 2024-11-19 |
| `xirider.livecode` | 1,355,020 | 2020-06-26 |
| `VentureCasserole.python-live-evaluator` | 1,486 | 2025-09-15 |
| `wuhy.live-coding` | 980 | 2026-02-07 |
| `srejv.python-inline-eval` | 63 | 2026-04-14 |
| `gideonnnalue.pyroo` | 18 | 2026-08-07 |

One project won the category and then stopped being updated; the rest are
rounding errors. None of them render values inline — AREPL's own
`inlineResults` setting is documented as *"(Currently just error icons)"*, and
its values go to a side panel. AREPL also runs continuously, which is why it
needs an `unsafeKeywords` blocklist guessing which code is unsafe to re-run: a
hack that exists only because it made the opposite trigger decision. Design
rule 5 is the same finding from this side.

AREPL matters to this project for a second, entirely practical reason. It
binds both of the keys Evalens wants, under the same `when` clause, and VS
Code breaks extension-against-extension ties by load order, which nothing
makes deterministic. The symptom is a silently dead key. `README.md` carries
the diagnosis and the fix; `src/keybindings.ts` carries five such conflicts
read off shipped manifests, so the fix cannot drift from what the extension
hands out.

### Hydrogen — the encouraging fact

`nteract/hydrogen`, for Atom: *"Run code interactively, inspect data, and
plot. All the power of Jupyter kernels, inside your favorite text editor."*
Inline result bubbles, watch expressions, completions from the running kernel,
interrupt and restart, rich output, roughly 4k stars.

**This exact UX already succeeded in Python once.** Hydrogen was not abandoned
for lack of interest and did not lose on the merits; its repository carries an
Atom Sunset Notice and points users at nteract, VS Code with the Jupyter
extension, or PyCharm. The workflow lost its editor, not its argument. That is
the single most encouraging data point available to this project — and also a
warning about what the competition looks like, because the displaced Hydrogen
users went to the notebook stack rather than to a replacement.

### What none of them do

Three things, and the claim is only ever in the combination:

1. Evaluation is **explicitly triggered** — the user decides when their code
   runs.
2. Values are painted **in file order, beside the code that produced them**,
   and they stay there.
3. The file stays a plain `.py` that anyone can `python file.py` — no cell
   markers, no saved outputs, nothing on disk that exists for the tool.

Smart Send has 1 and 3 and puts the answer in a terminal. The Interactive
Window has 1 and something like 2, and buys them by turning the file into a
notebook. `debug.inlineValues` has 2 and 3 and needs a paused debug session,
which is a different activity with different ergonomics, and shows now rather
than then.

State it narrowly and it is defensible: **nothing shows what each line of an
ordinary Python file did, in place, without changing the file first.** State it
as "see values inline" and it is false, and this document has to keep saying
so, because the broad version is what a marketing sentence naturally collapses
to.

One more property was earned rather than designed and belongs in the claim:
**nothing is configured before a value appears.** No interpreter selection, no
`ipykernel`, no terminal profile, no `launch.json`, no cell markers. Python
3.9 or later on `PATH` is the whole requirement. That is now design rule 6,
and it decides architecture questions rather than describing them — an
approach that needs configuration first is off-strategy however elegant it is.

## Who this is for, and the constraint that decides everything

The first user is a first-year university student, at the start of a five-year
programme, who is **forbidden notebooks for the first few years**.

The maintainer considers that rule correct, and the reasoning is why this
project exists rather than a preference about editors:

> *"we are creating a generation of python programmers who think that you can
> submit an algorithm that is to be shipped on the mars lander as a
> notebook... or a trading app in real time trading"*

A generation that learns to ship an algorithm as a notebook will try to ship a
lander that way. So the tool has to teach on real source files, or it teaches
the wrong habit.

This is what removes the squeeze. The deflating argument against this project
is that the cases where a persistent namespace matters already belong to
Jupyter — true, for people who may use Jupyter. For someone who must edit a
real source file, by policy now and by professional necessity later, nothing
covers it. Design rule 8 is the same sentence from the other end: the file is
only ever Python, annotations are decorations, and they evaporate. A notebook
saves its outputs into the document, which is the reproducibility failure in
one line — the file carries results computed in a state nobody can
reconstruct. This cannot.

Three obligations follow, and they are commitments rather than opinions:

- **Stale marking is core, not polish.** Hidden state is the notebook's
  original sin; a value out of sync with its code has to be visibly out of
  sync. Shipped as #51 and #59.
- **Load-versus-re-evaluate semantics have to be decided rather than
  defaulted.** "Restart and run all" is the discipline notebook users are
  supposed to remember and mostly do not. Decided in #56: loading resets by
  default and takes the load keybinding; keeping the namespace across a load
  is the deliberate, palette-only choice. See design rule 12 and
  `docs/development/namespace-reset.md`. Not yet built.
- **Out-of-order execution is inherent to a REPL and cannot be prevented, so
  it must be legible.** A standing obligation on every feature, not a ticket.

## What got built

All of this is in the repository and runs. Where a claim has not been checked
by a human looking at a screen, it says so — design rule 11.

### The kernel

`kernel/evalens_kernel.py` is about 2,100 lines, `resolver.py` 861 and
`loops.py` 562: roughly 3,500 lines of Python with 4,200 lines of tests behind
them. Stdlib only — no ZeroMQ, and `package.json` has no runtime dependencies
at all. One process, one namespace dict, alive across requests until told to
reset. The persistence is the whole point: it is what lets line 40 see what
line 3 bound, and it is the difference between this and a fancier `print()`.

The protocol is newline-delimited JSON — one request per line in, one response
per line out; JSON escapes newlines, so line framing is safe for arbitrary
source text. The ops are `ping`, `reset`, `eval`, `eval_file` and `outline`.
`eval_above` is reserved and answers an explicit not-implemented error naming
#13, which is the ticket that would land it.

**It runs two pipes, not one**, and the reason is the part worth recording
because it is invisible from outside. The request pipe (descriptors 0 and 1)
has exactly one reader, and while user code is running that reader is busy.
Anything that must be dealt with *during* an evaluation — an interrupt, above
all — cannot travel on it, because the only code that could read it is the
code you are trying to interrupt. So a control channel gets descriptors 3 and
4, serviced by a daemon thread that is never blocked:

```
fd 0 -> requests    fd 3 -> interrupt, input_reply
fd 1 <- responses   fd 4 <- interrupt_ack, status, input_request, stream
```

Nothing on the control channel is ever a reply to anything on the request
channel, which is what makes a server-initiated message unmistakable: it is
not told apart from a stale response by a rule applied to a shared stream, it
arrives somewhere a response never can. That is the shape of Jupyter's shell
and control channels, arrived at independently and for the same reason. The
lesson taken from Jupyter is the channel split, not the wire format — no
ZeroMQ, no message signing, no session identities.

**Everything the user's code prints leaves on the control channel, and it does
so for the life of the process rather than the life of a statement.** That
correction cost a wedged session to learn. Replacing `sys.stdout` only while a
statement runs leaves a thread started on line 4 still writing on line 40 —
onto the pipe every response travels on, where a trailing newline gets the
user's own `print` reported back to them as a kernel fault, and the absence of
one splices their text onto the front of the next response and destroys it.
Concurrency is on the syllabus this is aimed at, so a `print` inside a thread
is not an edge case. Output that arrives with nothing running is marked
unattributed: which statement started the thread is not knowable, and the
reader needs to see the text more than they need it labelled.

Design rule 9 — the kernel's own choices must not be observable from user code
— has two implementations here worth knowing about before touching either. The
evaluated module is named after the file's own stem rather than after Evalens,
so `__name__` reads the way it would if Python had run the file. And the
kernel's own directory is removed from `sys.path` at startup, with `resolver`
and `loops` lifted out of `sys.modules`, so a user's `import resolver` cannot
silently get ours.

Every form is compiled with the source module's explicit future flags and
`dont_inherit=True`: source directives apply even to a selection, while
the kernel's own directives and other documents' flags never leak.

Python 3.9 is the support floor, set by `ast.unparse`. CI runs the kernel
suite on 3.9, 3.11 and 3.13; it was run locally on 3.9 through 3.14 before
that claim was made.

Jupyter's `IExportedKernelService` remains the documented escape hatch if rich
display ever justifies the dependency — `ms-toolsai.jupyter` exposes it to
third-party extensions, verified present in the shipped bundle of
`ms-toolsai.jupyter-2025.8.0`. It is deliberately not the starting point and
nothing has since made it more attractive.

### Deciding what to evaluate, and what to say about it

`kernel/resolver.py` resolves the enclosing top-level statement from a cursor
position using `end_lineno` / `end_col_offset`, which is the part Smart Send
also does. Everything else it does is the part that is actually load-bearing.

The statement-versus-expression problem: in Clojure everything returns a
value; in Python `x = [1, 2, 3]` returns nothing. Exec the statement, then
show the assignment *target*. But **that holds only while the target is a bare
name.** Reading `x` back is a dictionary lookup and cannot run anything;
reading `acct.balance` back calls a property getter the assignment never
called, and `led['a']` calls `__getitem__` — user code the *annotation* chose
to run, in a design whose premise is that the user chooses. So there are three
sources for a value rather than one: read the display name back out of the
namespace; evaluate an expression statement exactly once and report that; or,
for an attribute or subscript target, report what was stored, captured as it
was stored. `resolver._value_source` decides which applies, per statement
kind, and the kernel obeys it rather than deciding for itself. This is design
rule 3, and it has been violated three times by three different mechanisms.

**One value per statement is the wrong unit.** It is right for a binding and
has nothing to say for most lines: `print("y unaffected:", y)` returns `None`,
which is true, useless and misleading on the line whose whole point is `y`. So
Rider's model rather than a REPL's — annotate the *names on a line*, several
of them, as separate `name: value` pairs. The names come from the AST (what
the statement binds, then what it reads) and the values from a plain namespace
lookup, which cannot run user code. Bare names only, for the same reason.
Callables and modules are skipped as noise, the count per line is capped, and
the line says so where the cap bit — a reader who counts five names on the
line and four values beside it cannot otherwise tell whether the fifth was
omitted, unreadable, or not a name at all. That last part is imperfect today
and is filed as #74 and #85.

A `for` loop is the exception, and the interesting one. Its target holds only
the last element once the loop is over, so reading it afterwards throws away
every iteration but one — the thing you ran the loop to watch.
`kernel/loops.py` instruments the body instead: a recorder injected as its
first statement takes `repr()` of the target as each iteration begins, and the
annotation shows the sequence, bounded — `p: 1, 2, 3, 4`, or
`p: 0, 1, 2, 3, 4, … (+9,994 more) … 9999`. A second recorder, injected as the
**last** statement of the body, watches the names the body binds, because the
target is usually the *input* being iterated and the body binding is usually
the *computed result*, which is the half the reader came for. Last rather than
first, because the result does not exist yet on the first pass. The
consequence to design for rather than paper over: an iteration that hit
`continue` or `break` computed no result, so the two sequences are **not** the
same length, and anything rendering them as parallel columns gets caught by a
filter loop. `repr()` is taken at capture time rather than the object being
kept, or a loop over mutables reports its final state N times; a million-row
loop leaves six strings behind, not a million.

What an annotation may say beyond that is design-rules territory rather than
architecture, and restating it here is how two documents drift apart.
`docs/development/design-rules.md` holds it: an annotation must never assert
more than we know (1), it earns its place by differing from what the reader
can already see (2), annotating must never execute user code (3), annotations
are a trace and never a watch (4), the answer goes on the line and the output
channel is overflow (7). Each rule records the defect that produced it. Read
them before designing anything that renders.

Two consequences of rule 2 belong here because they are about the display
rather than the principle. A description leads with Python's own keyword —
`def greet(name)` beside `class Config(name, port=8080)` — because the keyword
is the part a signature cannot say, and it is what makes `f = greet` read
`f: def greet(name)`. And the redundancy test compares **rendered text, never
the kind of statement**, because a `def` is where the shortcut looks safest and
would do the most damage:

```
@shout
def greeting():        greeting: def <lambda>()
```

The decorator replaced the function, the line cannot show that, and this is
the most valuable annotation on the page. A rule that skipped function
definitions would have deleted exactly it.

**But a plain, undecorated definition needed the opposite move.** `def
greet(name)` beside `def greet(name):` is the same characters and a
different claim: the line says *bind a function to this name when this
runs*, while the annotation says *it has run, and the name holds this*.
Comparing text answers that they are the same and withholds the
annotation — right about the text, wrong about what the reader needs,
because a definition edited and not re-evaluated is the standing hazard
of working this way, and `def` in Python is a statement that runs and
binds rather than a declaration. Left to the text comparison alone, the
family split on an accident of prefix matching: a class escaped it on
its parentheses, a generator on an arrow that runs past the end of its
own line, and the plain synchronous function — the one form a beginner
writes first — was the only thing on screen that said nothing at all. So
a `def`, `async def` or `class` is exempted at the call site, on the
*kind* of statement rather than on its rendered text, and everything
above about `@shout` is untouched: a decorated definition still earns its
annotation by differing, because there the difference is real.

### Rendering

Inspection uses a separate passive formatter and native storage reads.
It never calls a value's custom representation, getter, iterator, or
metaclass hook. Unsupported objects receive a type description; their
stored fields can still be inspected without extending their lifetime.

Live inspection is optional: it does not queue behind execution, and a hover
falls back to its captured trace after 100 ms. Current children are labelled
separately from that trace. Arbitrary value text is literal Markdown data.

Each statement retains at most 65,536 characters per output stream, followed
by an omission count. The complete output still streams to the output channel.
Prompt detection keeps a separate bounded last-line buffer, so prompts remain
accurate after a statement exceeds the capture cap.

`createTextEditorDecorationType({ after: { contentText } })` plus
`setDecorations` — the same mechanism Calva, Error Lens and inlay hints use.
`src/render/` carries it in seven modules: annotations, decorations, a flash,
formatting, presentation, a registry, and the repeat suppression. Most of them
have no `vscode` import at all, which is why they are testable.

Calva is the reference implementation and the prior-art section below says
what reading it settled. Two additions came from problems this project made
for itself by painting every line. **Pending goes on at the keypress**, before
the kernel is asked, because otherwise the fast path — nearly every evaluation
— has no transition at all and re-running a line repaints an identical string.
And **success is a brief flash rather than a standing colour**, because once
every line carries a value a permanent green distinguishes nothing; what says
which statement just ran is the emphasis decaying. One flash class is
parameterised by colour and duration and used for both the success emphasis
and the selection-snap highlight, because two timers over one editor would
clear each other's decorations.

Three-state gutter markers — evaluated, stale, error — live in `media/gutter/`
as light and dark SVGs, separate files rather than theme colours because
`gutterIconPath` takes an image and there is no gutter `ThemeColor`. The
marker goes in the gutter and not on the annotation: dimming the value would
put a claim about the value in competition with the value, in the one place on
screen the reader is reading. JupyterLab was asked for exactly that and
declined.

**No part of the rendering has been signed off in this document's record by a
human looking at a screen.** The suites assert ranges and strings, which prove
a range and a string. Design rule 11 and `CLAUDE.md` say the same thing:
anything that renders gets looked at, and a passing decoration test is not
that.

### The surface a user touches

Eight commands, all in the Command Palette under `Evalens:` — Evaluate at
Cursor, Evaluate and Advance, Evaluate File, Clear Inline Results, Interrupt
Evaluation, Restart Kernel, Show Output, Fix Keybinding Conflict. Five
settings — `pythonPath`, `progressDelay`, `advanceSkipsComments`,
`alignColumn`, `printedLabel` — and eight themeable colour ids. Keys, the
AREPL conflict, and the reason the advance key is not `Shift+Enter` are all in
`README.md`, which is the user-facing document and the one to change when any
of that moves.

**The advance question was decided against a default a great many people
already have installed.** Smart Send advances the cursor after sending;
`evaluateAtCursor` does not. Advancing is a separate command on a second key.
That follows Calva, whose evaluate commands do not advance, and Spyder and
Jupyter, which both put run-and-advance on a *second* binding rather than
changing the first. Making the primary key move the cursor would mean the same
key cannot be pressed twice on one line, which is the natural thing to do
while editing it. Recorded because it is a deliberate divergence from a
first-party default, not an oversight.

The build is deliberately plain, and the earlier plan to scaffold with
`yo code` was not followed: `tsc -p .` compiles, `node --test` runs the suite,
four devDependencies, no runtime dependencies, no bundler. `npm run package`
produces `evalens-0.0.1.vsix`, 35 files. There is no marketplace
listing.

### The prototype

`prototype/form_at_cursor.py` is 48 lines, still runs, and is now **history**.
It proved the piece that looked hard and isn't, before there was anything else
to run; `kernel/resolver.py` superseded it, and `kernel/test_resolver.py` pins
the two answers the prototype produced so that the superseding is checkable
rather than assumed. It has a rough edge — a cursor on a line holding no
statement crashes it instead of reporting nothing — which is acceptable for
what it now is, and would not be if anything depended on it.

### Navigating captured results

The optional Values panel shows the existing trace at full width. With
`evalens.valuesPanel.followCursor` on (the default), moving the editor cursor
reveals the matching row, and navigating rows reveals the corresponding source.
Both destinations carry a theme-aware frame; the row also carries an arrow.
Keyboard focus stays in the pane being used. Up/Down and Home/End browse rows;
Enter, Space or a click explicitly reveals source even with cursor following
off. The panel's checkbox controls this preference separately from
`evalens.valuesPanel.follow`, which follows newly evaluated results. Neither
navigation mode evaluates code or opens a hidden panel.

## The hard parts, and where each stands

**Ordering and state.** Evaluating line 40 requires lines 1–39 to have run.
Calva has the same problem and solves it socially: evaluate top-down, and the
REPL holds state. Evaluate File covers the bulk case; "run everything above
the cursor" is #13, and the kernel already reserves the op for it.

**Side effects on re-evaluation.** Re-running `db.execute(...)` is bad.
Explicit triggering sidesteps it rather than managing it, which is the whole
of design rule 5.

**`input()` settles the continuous-versus-manual argument.** Beginner and
course code is full of prompts, and beginners write infinite loops constantly,
so any evaluate-as-you-type mode relaunches a program *blocked waiting on
stdin* every time typing pauses. That is a category error, not a debounce
interval to tune. It was discovered empirically while setting up a first-year
student's environment, on a file named `intrprog.py`, where a
`watchfiles`-based run-on-save loop had to be abandoned for exactly this
reason.

With manual triggering settled, prompting became answerable and is answered: a
`sys.stdin` replacement that asks the extension for a line and blocks for the
reply. **The interception point is stdin and nothing else** — one object,
through which `input()`, `readline()` and `read()` all pass. Anything
demanding a real terminal (`getpass` where a tty exists, `curses`, GUI
toolkits) is out of scope and stays out; the failure to avoid was never "too
many functions to hook", it was hooking something that needs a terminal and
half-succeeding. Both commands prompt, because in both cases someone is
sitting there. Loading a file refused to for a while, citing Jupyter's flag
being false for `nbconvert` and `papermill` — a misreading, because those are
*unattended*, and the flag exists so a batch conversion nobody is watching
fails loudly instead of deadlocking. `Cmd+Alt+Enter` is a person pressing a
key, and refusing produced a red `EOFError` on the prompt line and a cascade
of `NameError` under it. Twenty prompts in one file is still a real worry and
is answered where the person is: the blocked line is marked and revealed so
the box is never disembodied, and from the second prompt of a load the box
carries a way to skip the rest. Cancelling one prompt sends end-of-file and
raises `EOFError` for that statement alone; the load continues, because a
broken line is not a broken load. The box stays at the top of the window,
because a genuinely inline editable field needs the Comments API, whose zone
widget pushes every line below it down and reflows the column of values the
reader is in the middle of, and `WebviewEditorInset` is the right shape and is
not in the stable API.

**A file load reports each statement on that channel as it finishes**, for
the same reason and one more. Collecting every outcome and answering once
made a load atomic on screen although it is sequential in the kernel, and the
case where that stops being a nicety is the prompt: a file blocking on
`input()` at line 47 has run lines 1–46, holds their values, and used to have
shown none of them — so the reader is asked to type a value into a program
whose behaviour so far is invisible. Marking the waiting line harder does not
answer that, because prominence is contrast and an empty screen offers none.
The frames carry the statement's index in file order and the response still
carries every outcome: the index is what lets a consumer paint whichever
reaches it first without ever painting one twice or out of order, which
matters because repeat suppression decides whether to paint a value by
reading what stands above it.

**A file that does not parse.** `ast` is all-or-nothing, so one half-typed
line makes every line in the file unevaluable — and a half-typed line is what
a file being explored in *has*, because that is why anyone is evaluating
anything. The recovery, `resolver.parse_prefix`, drops trailing lines until
what is left parses and answers from that. **From the end, and never around
the cursor.** A window that shrinks towards the cursor retreats into precisely
the constructs that defeat parsing in the first place: compound statement
headers, backslash continuations, a bracketed method chain, a dict literal
spanning a dozen lines. Microsoft enumerated that list from the other
direction in vscode-jupyter#1471 and answered it by parsing rather than
guessing. The dangerous outcome is not the window that fails to parse — it is
the window that parses into something valid meaning something *else*, because
that produces an answer instead of an error. Truncating from the end cannot
cut through a construct the cursor is inside, and it handles the case the
complaint is actually about: the broken line is the one being typed. Two
things follow and are not optional. A value computed without the rest of the
file is a weaker claim than one computed with it, so the annotation says so.
And the break is reported on the line that broke, not on whichever line the
cursor happened to be on.

**Staleness, which is the price of the trace.** An annotation shows what a
statement produced when it ran and is never re-read, so an edit puts the value
and the code out of step — the notebook's oldest failure, reproduced in a text
file with two statements. The answer every tool that met this converged on is
*mark stale, never re-run*: CIDER turns its green fringe marker amber when a
form is edited, meaning "out of sync with what the REPL has" rather than
"wrong", and Mathematica has carried per-unit state in the cell bracket since
1996. Marking an annotation when its own text changes catches the obvious case
and misses the common one. `x = 1` / `y = x + 1`: edit and re-run the first
line and the second still reads `y: 2`, untouched by the edit, correctly
positioned, and describing a world that no longer exists. So the kernel also
reports, per statement, the module-level names it bound and the ones it read —
the same `ast` walk that resolves the form, asked a second question — and
re-evaluating a statement that binds `x` marks every annotation *below it in
the file* that reads `x`. File order, not execution order; same marker, same
vocabulary. The hover and Values panel explain the first observed reason: an
own edit, or the names a later evaluation re-bound. Dependency explanations
link to that statement within the original document while its location is
reliable; disjoint edits shift the link, while edits touching its source
withdraw navigation and retain the historical names. This is static name
analysis, not a claim that a value changed or a complete dependency trace. Re-evaluating clears the mark and nothing else does, undo
included: the buffer can be put back, the kernel cannot, and only an
evaluation is entitled to say the two agree again. Design rule 4 carries the
reasoning for why this is a trace at all.

**Value formatting.** Truncation limits, nesting depth, hover-for-full, and
sensible handling of large or cyclic structures. Partly done, and the open
tickets are the honest status: #12 truncation, #54 (`repr()` builds the whole
string before the wire cap discards it), #73 (memory addresses inside
containers). #46 (the hover was built and attached to a zero-width range, so
nobody ever saw it) is fixed: a `HoverProvider` answers the position instead,
which is also the path VS Code's Accessible View and keyboard-triggered hover
use.

## Why reactive re-evaluation is closed

The adjacent question every contributor eventually asks — *why not re-run the
annotations that just went stale?* — has an answer, and it is evidence rather
than taste.

**Evalens marks and it never runs anything.** That boundary is the whole
design and it is one increment from being lost: a marker plus "and re-run the
dependant" is a reactive notebook, which #40 ruled out and which cannot be
made reliable in Python. The dependency analysis here is deliberately unsound
in the safe direction — it is a parse, not a trace, so aliasing and mutation
defeat it. **This document's own opening example is precisely the case it
cannot see.** `lst = [1, 2, 3]` / `y = lst` / `lst.append(4)` is a mutation
through an alias, the counterexample that defeats every reactive notebook in
existence. That is a useful thing to know about your own hero example.

Being unsound is affordable here because the output is one grey pixel. It
would not be if the output were an execution. marimo's own documentation says
so:

> "marimo does not track mutations to objects, e.g., mutations like
> `my_list.append(42)` … don't trigger reactive re-runs of other cells." …
> "Tracking mutations reliably is impossible in Python."

And it is now a benchmark rather than an opinion. Lu, Zheng, Crichton,
Narayan, Raghavan and Vasilakis, *When Do Reactive Notebooks Fail to React?*
(arxiv.org/abs/2511.21994) tested marimo, Observable and IPyflow: *"within any
definition, we find simple notebook modifications that can break each
system."* Mutation was the largest category in their real-world corpus, 25 of
38 modifications, and is exactly what marimo and Observable neither support
nor detect. nbsafety pays a 1.44× median slowdown for the version that catches
them.

Pluto.jl is the counterexample worth naming, and it does not transfer. Its
reactivity is sound because Julia code in a Pluto notebook is constrained —
one definition per cell, no hidden state — and because Pluto owns the document
format. Neither is available to something whose whole premise is that the file
stays an ordinary `.py` nobody agreed to constrain.

## Prior art worth reading before solving anything

### Calva, for the rendering

`BetterThanTomorrow/calva`, `src/providers/annotations.ts` — 217 lines, and it
is essentially the entire feature. Related: `src/results-output/` for result
formatting and `src/debugger/decorations.ts`. Calva is MIT licensed, so even
direct reuse with attribution would be permitted, but the value is the design
rather than the lines; attribution for the rendering approach is intended and
welcome, and matching the licence is the plain form of it. Its author, Peter
Strömberg, is known to the maintainer, which makes a design question cheaper
than a reverse-engineering session.

Reading that one file collapses several questions that look open. VS Code
collapses ordinary spaces in decoration `contentText`, so Calva substitutes
non-breaking spaces (U+00A0) — without which any alignment inside a rendered
value collapses. Decorations smearing as you type is
`rangeBehavior: DecorationRangeBehavior.ClosedOpen`, a one-liner. Colours come
from `ThemeColor` rather than hardcoded values, so results follow the theme and
stay overridable through `workbench.colorCustomizations`. There are two
decoration layers, not one: the result text is an `after` decoration and the
evaluated region gets its own background highlight, and keeping them separate
is what makes the UX legible. An `AnnotationStatus` enum
(`PENDING`/`SUCCESS`/`ERROR`) drives distinct region colours, which is most of
what makes the feature feel alive rather than static. Overview-ruler marks put
evaluated regions in the scrollbar. Decoration state is per document, keyed by
`document.uri`. Errors get their own colour and hover text rather than a
separate presentation mechanism.

One departure worth stating as a departure: pending here carries an optional
message rather than being a boolean, because "still running", "the kernel has
not started this yet" and "waiting for you to answer `Enter a value:`" are
three different things the reader has to tell apart — and Jupyter's inability
to separate them is its best-known interface complaint.

### CIDER, for staleness

The amber fringe marker, described above. The vocabulary matters as much as
the mechanism: *out of sync with what the REPL has*, not *wrong*.

### Hydrogen, for the shape of the win

Covered above. Read it as evidence that this UX has an audience in Python, and
as a caution that the audience goes back to notebooks when the tool
disappears.

### AREPL, for value serialisation

`almenon/AREPL-vscode` solves `repr()` handling, truncation and nesting depth
for a continuously-executing evaluator, even though it renders to a panel. Its
`unsafeKeywords` blocklist is the artefact to study rather than copy: it is
what continuous evaluation costs.

### Rider, for the annotation grammar

Several named values per line rather than one result per statement. This is
where the `name: value` model came from, and it is the single decision that
made annotations useful on the lines that are not assignments.

### marimo and Pluto.jl, for the road not taken

Covered above, under reactive re-evaluation.

## What would kill this

Named so the project can be stopped on evidence rather than drift.

**Microsoft points Smart Send's output at a decoration.** This is the real
one. Every piece is already first-party and shipped: the AST chunking, the
persistent REPL, the inline value rendering, the provider API. Nothing stands
between those and this product except somebody at Microsoft deciding to wire
them together. If that ships, the correct response is to stop, not to
differentiate.

**Nobody wants values in the buffer.** Plausible, and testable. The failure
looks like people trying it, liking the demo, and going back to `print()`
inside a week because the annotations are noise on a file they are trying to
read. #77 exists to measure this against a real course rather than by
impression, and it is the most important open ticket in the repository for
that reason.

**Annotations turn out to be untrustworthy in practice.** Not wrong in
principle — wrong often enough that people stop reading them. Design rule 1
exists because that defect has already appeared in five disguises. A tool that
shows a value which is not true is worse than no tool, because the whole pitch
is that the state is visible instead of hidden.

**The notebook prohibition goes away.** If universities stop forbidding
notebooks in first year, the motivating constraint evaporates and what is left
is a nicer Smart Send. Worth watching; not worth acting on pre-emptively.

**Or the project drifts into the market it says it is not competing for.**
The open epics for rich display — #24, a table view for DataFrames, and #23,
an inline object explorer — are aimed squarely at data-science work, and they
are the features most likely to make Jupyter's kernel worth the dependency.
Neither is wrong on its own; both should be weighed against the audience this
document names, because a plain-source-file tool that grows a DataFrame
viewer has started competing with notebooks on the ground notebooks win.

**Notebooks themselves are not the threat**, and that is worth saying
explicitly because the instinct is to fear them. The market they own is one
this is not competing for, and their users report this project's pitch as a
pain point in their own words: *"the only way to debug in most notebooks is
through the use of print statements"*, and *"Debugging is a horrible
experience, copying the code over to do the debugging outside [in the IDE],
and copying it back"* (Chattopadhyay et al., CHI 2020 — 20 interviews and a
156-person survey, alongside refactoring, deployment and history as the top
reported pains).

## What is not decided

One spike is open and could move architecture:

- **#33 and #52** — whether rendering should go through VS Code's debug inline
  values, and whether a debug session can be made genuinely invisible. Design
  rule 6 already constrains the answer: if it needs a `launch.json` or an
  interpreter selection before a value appears, it fails regardless of what
  the spike finds about UI leakage.

**#56** — whether loading a file resets the namespace — is decided rather
than open: see design rule 12 and `docs/development/namespace-reset.md`.
Loading resets by default; keeping the namespace across a load is a
deliberate, palette-only command. The kernel side already exists
(`Kernel.reset`); the command split and keybinding swap are not yet built.

And one thing is settled but unevidenced, restated because it is the easiest
claim in this document to start believing: **no part of the rendering has been
signed off by a human looking at it in this document's record.** Everything
above about how it looks is an assertion about strings and ranges.

## Naming and marketplace positioning

The name is **Evalens** (eval + lens), and a marketplace search returned zero
results for it. `*-Lens` has become recognised shorthand for "paints
information into your editor" — Error Lens has 9,780,508 installs — and
landing in that mental category is free positioning.
`TylerLeonhardt.vscode-inline-values-powershell` has 115,525 installs, which
says the "inline values for X" framing sells in a language with a fraction of
Python's user base. Both figures come from the same September 2026 gathering
as the table above and are not re-verified.

`package.json` uses both name fields, so brandability and searchability are not
a trade-off: `"name": "evalens"` is the id and the marketplace URL slug
(`mbjarland.evalens`, decided before the first upload made it permanent), and
`"displayName": "Evalens — Inline Python Values"` is what humans see and what
search matches on, alongside the keywords.
`keywords` includes `calva` and `arepl` deliberately — people searching those
terms are precisely the target audience — and `categories` is
`["Debuggers", "Visualization", "Programming Languages"]`.

**The marketplace `description` currently reads "See values inline as you
type", and that is the broad claim this document exists to stop making.**
Evaluation is explicitly triggered and never continuous; "as you type" says
the opposite, in the one line a search result shows, and it is a sentence
AREPL could use more truthfully than Evalens can. Fixing it belongs with the
rest of the listing work in #15.

For a visual extension, an **animated GIF at the top of the README** outsells
the name by a wide margin. Every extension that has won this category leads
with one above the fold, Error Lens included. A viewer scrolling search
results decides in about two seconds, and a five-second loop of values
appearing on a keypress does that work. `examples/tour.py` exists to be
recorded from, and no recording exists yet. This deserves more effort than the
naming did.

## Motivation

Written while setting up a Python development environment for a student
beginning a five-year university programme, coming from Clojure, where inline
evaluation is table stakes. The original prompt was "Python doesn't have
this". That turned out to be half wrong, and this document is what is left
after checking.
