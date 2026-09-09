<p align="center">
  <img src="media/icon.png" width="96" alt="Evalens logo">
</p>

# Evalens — see what your Python produced

Evaluate Python on demand and see values beside the code. Explore what a
loop did, compare a prediction with a result, or inspect a small piece of
an unfamiliar program—all in an ordinary `.py` file.

**Start with your first Python exercises. Keep it for everyday development.**
Nothing runs as you type, and no cell markers or saved outputs are added to
your source.

<img src="media/demo/hero.png" width="711" alt="Python code in VS Code with recorded values and printed output beside the statements that produced them">

## Requirements and installation

You need **VS Code 1.90 or later** and **Python 3.9 or later**. Evalens can
use the interpreter selected in the Python extension, or find `python3` /
`python` on your `PATH`. You can also choose one with `evalens.pythonPath`.
No additional Python packages are required.

Install [Evalens from the VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=mbjarland.evalens),
published by **mbjarland**, or run:

```sh
code --install-extension mbjarland.evalens
```

For a downloaded VSIX or a source build, see the
[installation guide](docs/user-guide.md#install).

## Your first evaluation

Open a Python file and try:

```python
price = 8
quantity = 3
total = price * quantity
print(total)
```

Put the cursor on `price` and press **`Cmd+Enter`**
(`Ctrl+Enter` on Windows/Linux). Its recorded value appears beside the line.
Move to `quantity`, then use **`Cmd+Shift+Enter`**
(`Ctrl+Shift+Enter` on Windows/Linux) to evaluate and move to the next
statement. Predict `total` before evaluating it.

With focus in the Python editor:

| macOS | Windows / Linux | Action |
|---|---|---|
| `Cmd+Enter` or `Alt+Enter` | `Ctrl+Enter` or `Alt+Enter` | Evaluate the statement at the cursor |
| `Cmd+Shift+Enter` | `Ctrl+Shift+Enter` | Evaluate and Advance |
| `Cmd+Alt+Enter` | `Ctrl+Alt+Enter` | Evaluate File (or selection); resets variables for a whole file by default |
| `Escape` | `Escape` | Clear recorded results; keep Python variables |

Evaluation runs a complete enclosing statement: placing the cursor inside
a loop runs that loop. **Evaluate and Advance moves between statements;
it does not step through individual loop passes.**

Every command is also in the Command Palette: press **`Cmd+Shift+P`**
(`Ctrl+Shift+P` on Windows/Linux), then type **Evalens**. If a shortcut does
nothing, try the command there and use **Evalens: Fix Keybinding Conflict**.
Other extensions can share these keys; the
[keybinding guide](docs/user-guide.md#keybindings) explains how to resolve them.

## Keep code and results together

Inline values show what a statement produced when it ran. Variable names,
values, and `printed:` output have distinct styling. Hover for a longer
reading or an error's traceback. Lists, mutations, comprehensions, and
loop histories become easier to inspect without adding temporary print
statements to your file.

For longer results, open **Evalens: Show Values Panel**. Code and recorded
values appear side by side. Linking follows the cursor in either direction;
a separate **Latest result** marker shows what just finished, even after
Evaluate and Advance moves on.

<img src="media/demo/panel.png" width="711" alt="Evalens Values panel showing source beside recorded variables and printed output">

Fold a tall result to the height of its code, or expand just the part you
need. Open recorded values and output in read-only editor tabs for Find,
selection, and copy. Browsing these recordings does not evaluate code.
Keyboard navigation, result announcements, and an optional setting to hide
inline values while the panel is visible support different ways of working.

## Follow a loop's values and output

Loop histories keep values first and their counts afterward. Each nested
loop has its own history beside its own header. The Values panel separates
**Variables** from **Printed output**, so a variable's recorded value cannot
be mistaken for text printed by your program.

<img src="media/demo/nested-loops.png" width="711" alt="Nested loop explorer with an expanded outer iteration and separate columns for variables and printed output">

Simple loops use compact rows. Nested loops add expandable outer iterations.
Long histories and output fold or page, with the same navigation at each
level. Capture limits and missing readings are explained where they occur.

Timing matters: loop targets are captured at iteration start, and up to three
body variables at normal iteration end. A printed value can therefore differ
from the end reading. These are bounded recordings, not a complete execution
trace; [loop recording details](docs/user-guide.md#loops-keep-values-beside-the-output-they-produced)
explain the limits and skipped capture points.

## Learn the tool, then use as much as you need

Choose **Evalens: Open Learning Walkthrough**, or **Try a guided example** in
the empty Values panel. Five editable exercises cover predicting values,
evaluating successive statements, list aliasing, fixing an accumulator, and
recognizing stale results. **Evalens: Open Learning Exercise** jumps directly
to an exercise. Opening one never runs it.

<img src="media/demo/learning.png" width="711" alt="Evalens learning walkthrough in VS Code showing its five exercises and the Open exercise button">

The guides use actual VS Code screenshots. **Help and learning** in the panel
explains results, loop timing, and session controls. You can dismiss the
introduction and bring it back later; exercises remain optional.

As you gain experience, use expression watches inside loops, inspect a data
structure, or open a large recording for native Find and copy. There is no
separate beginner or expert mode to switch between.

## Understand what a result means

A result records **what that statement produced when it ran**. It does not
promise that Python still holds that value. Editing code or reevaluating a
dependency can mark earlier results stale; alias mutations are not fully
tracked. Rerun a statement when you want a fresh recording.

Statement evaluations share a Python session. **Clear Inline Results** removes
the display; **Restart Kernel** discards Python variables and saved input
answers, while earlier recordings remain visible. **Evaluate File** resets
variables by default; its setting and exceptions are explained under
[commands and session behavior](docs/user-guide.md#commands).

Use the [Python debugger](https://code.visualstudio.com/docs/python/debugging)
when you need to pause inside a loop, step into a function, inspect the call
stack, or examine intermediate state. It starts a separate execution;
it does not resume an Evalens recording or inherit its variables.

## Reference and support

[User guide](docs/user-guide.md) · [Commands](docs/user-guide.md#commands) ·
[Settings and colors](docs/user-guide.md#settings) ·
[Release notes](CHANGELOG.md) · [Report an issue](https://github.com/mbjarland/evalens/issues)

MIT licensed. See [LICENSE](LICENSE). The inline rendering approach builds on
[Calva](https://github.com/BetterThanTomorrow/calva).
