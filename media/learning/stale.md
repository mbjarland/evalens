# Notice an old answer

1. Open this exercise, put the cursor on `answer = 10`, and use **Evalens:
   Evaluate at Cursor**.
2. Before editing, predict what will happen to that recorded answer when you
   change the code to `answer = 20` without evaluating it.
3. Make the edit and inspect the old result. Hover the code to read why the
   result is marked stale.

**Evalens: Evaluate at Cursor** — **Cmd+Enter**
(**Ctrl+Enter** on Windows/Linux).

These are default keys, pressed while editing Python. For remapped or
conflicting keys, open the **Command Palette** with **Cmd+Shift+P**
(**Ctrl+Shift+P** on Windows/Linux) and search for the command name.

## After editing, before evaluating again

![The source now says answer = 20, but Evalens still shows the old recorded value 10 with a stale marker.](screenshots/stale-before-rerun.png)

*Actual Evalens rendering after an edit. The old result belongs to the previous
code. Typing did not run the new assignment.*

Now evaluate that line again.

## After evaluating the edited line

![After evaluating answer = 20, the recorded result is 20 and the stale marker has cleared.](screenshots/stale-after-rerun.png)

*The new result matches the statement that just ran. Evalens updates results
when you explicitly evaluate, not while you type.*

Mark the walkthrough checkbox yourself when you have tried the lesson. You can
return with **Evalens: Open Learning Walkthrough** in the Command Palette.
