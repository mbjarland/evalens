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

Python 3.9 or later on `PATH`, or an interpreter chosen with the Python
extension, or one named in the `evalens.pythonPath` setting.

## Commands

**Every command is in the Command Palette** (`Cmd+Shift+P` / `Ctrl+Shift+P`),
prefixed with `Evalens:`. That matters more here than it usually does — see
the keybinding conflict below — because a stolen key then never leaves you
without a way to run these.

| Command | What it does |
|---|---|
| Evalens: Evaluate at Cursor | Evaluates the form the cursor is in and paints its value beside it |
| Evalens: Evaluate File | Runs the file top to bottom, annotating each statement |
| Evalens: Clear Inline Results | Removes the annotations from the active editor |
| Evalens: Interrupt Evaluation | Stops a running evaluation and keeps the namespace it built |
| Evalens: Restart Kernel | Throws away the namespace and starts a fresh interpreter |
| Evalens: Fix Keybinding Conflict | Hands you the user keybinding described below |

## Keybindings

| macOS | Windows / Linux | Command |
|---|---|---|
| `Cmd+Enter` | `Ctrl+Enter` | Evalens: Evaluate at Cursor |
| `Cmd+Alt+Enter` | `Ctrl+Alt+Enter` | Evalens: Evaluate File |
| `Escape` | `Escape` | Evalens: Clear Inline Results |

**`Ctrl/Cmd+Enter` is contested, and with AREPL installed it may do nothing at
all.** `almenon.arepl` binds the same key to `extension.executeAREPLBlock`
under the same condition Evalens uses, `editorTextFocus && editorLangId ==
python`. VS Code breaks a tie between two *extension* keybindings by load
order — the last one registered wins — and nothing makes load order
deterministic, so which extension answers can change between reloads. It
presents as a dead key: no error, no notification, no log line.

On Windows and Linux, where the Evalens key is `Ctrl+Enter`, the Jupyter
extension overlaps too: `ms-toolsai.jupyter` puts `jupyter.runcurrentcell` on
the same key, though only inside a file that has `# %%` cells
(`jupyter.hascodecells`). On macOS Jupyter stays on `Ctrl+Enter` while Evalens
is on `Cmd+Enter`, so the two do not meet.

**The fix is a user keybinding.** User keybindings are resolved after every
extension's, so the last match on a key is always yours — this is the only way
to settle the tie deterministically, and it is why Evalens cannot fix it from
its own manifest. Run **Evalens: Fix Keybinding Conflict**: it copies the
entry below and opens your `keybindings.json` so you can paste it. Nothing is
written to your settings on your behalf, and deleting the entry undoes it.

```jsonc
  // Evalens: a user keybinding is resolved after every extension's, so
  // this one wins the key whichever extension happened to load last.
  {
    "key": "cmd+enter",
    "command": "evalens.evaluateAtCursor",
    "when": "editorTextFocus && editorLangId == python && !findWidgetVisible"
  },
  // Removes AREPL's binding on the same key. Delete this entry to
  // keep it -- the one above already wins wherever both apply.
  {
    "key": "cmd+enter",
    "command": "-extension.executeAREPLBlock",
    "when": "editorTextFocus && editorLangId == python"
  }
```

Use `ctrl+enter` in place of `cmd+enter` on Windows and Linux. The removal
entry is not redundant: the Evalens binding only wins where its `when` holds,
so without it AREPL still answers while the find widget is open.

Evalens says all of this itself. When it activates and finds AREPL enabled it
writes the conflict and the snippet to its **Evalens** output channel every
time, and offers the fix in a notification once — once per installation, never
again, whatever you answer.

The default is staying on `Ctrl/Cmd+Enter`. It is what Calva uses, what AREPL
uses, and what this audience's fingers already know; ceding it to dodge the
collision would trade a solvable conflict for a permanently worse default.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `evalens.pythonPath` | `""` | Interpreter to run the kernel with. Empty means the Python extension's choice, then `python3`, then `python` |
| `evalens.alignColumn` | `0` | Column to align results to. `0` places each result just after the code that produced it |

Result colours are themeable: `evalens.resultForeground`,
`evalens.errorForeground`, `evalens.evaluatedRegionBackground` and their
background counterparts.

## License

MIT.
