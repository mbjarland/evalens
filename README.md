# Evalens — Inline Python Values

Put the cursor on a line, press a key, and see the value painted inline next
to the code. No `print()`, no debugger, no notebook.

A VS Code extension: a TypeScript front end and a small Python kernel that
holds a namespace between evaluations, so what you evaluate next sees what you
evaluated last. Evaluation is explicitly triggered and never continuous —
nothing in your buffer runs until you ask for it.

This is the working README. The marketplace listing is a separate piece of
work; what the project is and why it exists is in [`IDEA.md`](IDEA.md).

## Requirements

**Python 3.9 or later on your `PATH`. That is the whole requirement.** No
Jupyter, no notebook server, no kernel to install, no launch configuration,
no marketplace account — which is most of the reason to reach for this rather
than the alternatives. Evalens uses the interpreter the Python extension has
selected if you have that extension, then `python3`, then `python`, and takes
the first that runs and reports 3.9 or later. Naming one in the
`evalens.pythonPath` setting overrides all of it.

## Install

There is no marketplace listing yet, so install the `.vsix` you build:

```bash
npm ci
npm run package
code --install-extension python-inline-values-0.0.1.vsix
```

`npm run package` writes `python-inline-values-<version>.vsix` into the
repository root; the version comes from `package.json`. Reload the window
afterwards, open a Python file, and press `Alt+Enter` on a line. If nothing
happens, read the keybinding section below before anything else — a dead key
is the expected symptom of a conflict, not of a broken install.

## Commands

**Every command is in the Command Palette** (`Cmd+Shift+P` / `Ctrl+Shift+P`),
prefixed with `Evalens:`. That matters more here than it usually does — see
the keybinding conflict below — because a stolen key then never leaves you
without a way to run these.

| Command | What it does |
|---|---|
| Evalens: Evaluate at Cursor | Evaluates the form the cursor is in and paints its value beside it |
| Evalens: Evaluate and Advance | The same, then moves to the next top-level statement — hold the key to walk a file |
| Evalens: Evaluate File | Runs the file top to bottom, annotating each statement — or the selected statements, when there is a selection |
| Evalens: Clear Inline Results | Removes the annotations from the active editor |
| Evalens: Announce Result at Cursor | Puts what is painted on the cursor's line into a notification, where a screen reader reads it |
| Evalens: Interrupt Evaluation | Stops a running evaluation and keeps the namespace it built |
| Evalens: Restart Kernel | Throws away the namespace and starts a fresh interpreter |
| Evalens: Show Output | Opens the Evalens output channel without taking the cursor out of the editor |
| Evalens: Fix Keybinding Conflict | Hands you the user keybinding described below |

**Evaluate File runs a selection, and runs whole statements.** Select the
first twenty lines and press the key: those statements run, in order,
annotated exactly as a full load annotates them. A selection that begins or
ends halfway through a statement runs that statement whole and briefly
highlights how far it reached — a partial statement is never executed, because
a fragment can parse into something valid that means something else. A
selection with no complete statement in it — a comment, a blank line — says so
in the status bar and runs nothing.

## Keybindings

| macOS | Windows / Linux | Command |
|---|---|---|
| `Alt+Enter` | `Alt+Enter` | Evalens: Evaluate at Cursor — the top-level form |
| `Cmd+Enter` | `Ctrl+Enter` | Evalens: Evaluate at Cursor — the same command |
| `Cmd+Shift+Enter` | `Ctrl+Shift+Enter` | Evalens: Evaluate and Advance |
| `Cmd+Alt+Enter` | `Ctrl+Alt+Enter` | Evalens: Evaluate File |
| `Escape` | `Escape` | Evalens: Clear Inline Results |

**`Alt+Enter` is the top-level-form key.** Evaluate at Cursor resolves the
*enclosing top-level statement* — not the sub-expression under the cursor —
and `Alt+Enter` is the key Calva puts the top-level form on, in
`betterthantomorrow.calva`'s own manifest. So it is not a second-choice
binding or a workaround for the conflict below; it is what the command's
semantics already said the key should be. It is also the same chord on every
platform, and nothing in VS Code itself claims it in a Python file with the
find widget closed. When a command for the inner form lands it takes
`Ctrl+Enter`, and none of this changes.

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

**On a machine with Evalens installed, the answer is not to install AREPL.**
The two bind the same two keys to the same job, and which one answers is
decided by extension load order, which nothing makes stable. There is no
configuration that makes both work on one key. Keep the one you use.

Evalens says all of this itself. When it activates and finds AREPL enabled it
writes the conflict and the snippet to its **Evalens** output channel every
time, and offers the fix in a notification once — once per installation, never
again, whatever you answer. If you dismissed it, **Evalens: Fix Keybinding
Conflict** in the palette hands you the same thing at any time.

The default is staying on `Ctrl/Cmd+Enter` as well. It is what Calva uses,
what AREPL uses, and what this audience's fingers already know; ceding it to
dodge the collision would trade a solvable conflict for a permanently worse
default. Adding `Alt+Enter` is not ceding it — it is binding the key the
top-level semantics always implied, and both keys run the same command until
the inner-form command exists to take `Ctrl+Enter` back.

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

`Cmd+Shift+Enter` is claimed by no extension of the sixty-one measured. VS
Code holds it as a core default for `editor.action.insertLineBefore`, which an
extension binding outranks — a core default is not a tie.

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
needed — `Cmd+Shift+Enter` is ours uncontested — and **Evalens: Evaluate and
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
spelled out. `stderr:` keeps its own name, and is deliberately **not** painted
in the error colour: a library writing a warning has not failed.

The channel never opens itself and never takes the cursor. Output belongs
beside the code that produced it; a panel would put the answer somewhere other
than the code, which is the problem this extension exists to solve.

## The marker in the gutter

An annotation is a record of what a statement produced *when it ran*. Nothing
re-reads it, and nothing re-runs your code to keep it current — so editing a
line leaves a value that was true a moment ago sitting beside code that no
longer produces it. That is the notebook's oldest failure, and the marker in
the gutter is what keeps it visible here.

| Marker | Means |
|---|---|
| Unbroken bar | Evaluated. The kernel holds what this line says |
| Broken bar | Stale. The line has been edited since it ran; the value is out of sync with what the kernel has, not necessarily wrong |
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

**Nothing is ever re-run to resolve any of this.** Evalens marks and stops —
it is not a reactive notebook, and it does not decide when your code executes.
The consequence worth knowing is that the analysis is a parse, not a trace: it
reads the names each statement writes and consults, so it cannot see a value
change through an alias — `y = lst` followed by `lst.append(4)` leaves `y`
looking current. Marking that too would mean running your code to find out,
which is the one thing this extension does not do behind your back.

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
`always` is free; it is the only surface VS Code announces from, and this is
what it costs.

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

**None of this has been tested with a screen reader.** The wording, the
truncation and the caveats are covered by unit tests, and that VS Code fires
an aria alert for every notification was read out of its source — but nobody
on this project has turned VoiceOver, NVDA or JAWS on and listened to the
result.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `evalens.pythonPath` | `""` | Interpreter to run the kernel with. Empty means the Python extension's choice, then `python3`, then `python` |
| `evalens.alignColumn` | `0` | Column to align results to. `0` places each result just after the code that produced it |
| `evalens.printedLabel` | `"printed"` | What the annotation calls printed output. Set `»` for a terse marker |
| `evalens.advanceSkipsComments` | `true` | Whether Evaluate and Advance steps over comment lines. Off, it stops once per comment block — one more press each, and that press evaluates nothing |
| `evalens.announceResults` | `"auto"` | Whether a result is announced as well as painted, for a screen reader. `auto` follows `editor.accessibilitySupport`; `always` announces every one; `never` announces none. See above |

Keys are not settings here: VS Code rebinds every command in this README from
its own keybindings editor, and a setting for the key would be a worse copy of
something the editor already does well.

Result colours are themeable: `evalens.resultForeground`,
`evalens.errorForeground`, `evalens.evaluatedRegionBackground` and their
background counterparts.

## License

MIT — see [`LICENSE`](LICENSE). The inline rendering approach is taken from
[Calva](https://github.com/BetterThanTomorrow/calva), which is MIT as well;
matching the licence is the plain form of the attribution
[`IDEA.md`](IDEA.md) records as intended.
