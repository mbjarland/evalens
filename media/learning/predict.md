# Predict a value

1. Open this exercise. Before running anything, predict the result of
   `2 + 3 * 4`. Which operation happens first?
2. Put the cursor on the expression and use **Evalens: Evaluate at Cursor**.
   The cursor stays on that line, and its result appears beside the code.

| Command | Windows / Linux | macOS |
| --- | --- | --- |
| Evalens: Evaluate at Cursor | Ctrl+Enter | Cmd+Enter |

These are default keys, pressed while editing Python. For remapped or
conflicting keys, open the **Command Palette** with **Ctrl+Shift+P** on
Windows/Linux or **Cmd+Shift+P** on macOS and search for the command name.

## Compare with the recorded result

![The expression 2 + 3 * 4 with Evalens showing the result 14 beside the code.](screenshots/predict.png)

*Actual Evalens rendering after evaluation. Python multiplies before adding,
so this expression produces 14.*

Change the expression to `(2 + 3) * 4`. Predict again, then evaluate it again.
Typing alone does not run Python.

The exercise is an editable Python document; save it only if you want to keep
it. Mark the walkthrough checkbox yourself when you have tried the lesson.
