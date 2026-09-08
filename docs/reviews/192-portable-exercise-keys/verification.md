# Portable editable exercise instructions

Issue #192 corrects the editable Python examples, which previously substituted
only the host platform's shortcut even though the walkthrough guide showed
both. The five shipped `.py` files now put the Mac default first with the
Windows/Linux equivalent in parentheses, and open without substitution.
Existing user copies are not rewritten.

| Exercise | Command | Default key |
| --- | --- | --- |
| Predict a value | Evaluate at Cursor | Cmd+Enter (Ctrl+Enter on Windows/Linux) |
| Follow the next statement | Evaluate and Advance | Cmd+Shift+Enter (Ctrl+Shift+Enter on Windows/Linux) |
| Two names, one list | Evaluate and Advance | Cmd+Shift+Enter (Ctrl+Shift+Enter on Windows/Linux) |
| Fix an accumulator | Evaluate File | Cmd+Alt+Enter (Ctrl+Alt+Enter on Windows/Linux) |
| Notice an old answer | Evaluate at Cursor | Cmd+Enter (Ctrl+Enter on Windows/Linux) |

The existing learning test now opens each exercise independently through the
registered command and checks the Mac-first default and parenthesized
Windows/Linux equivalent against that command's manifest binding. It also
checks that the opened text equals the packaged Python file, instead of
comparing a second read of the same file. The existing
real-kernel exercise checks still verify the expected values and histories.

Validation before the Mac-first wording refinement: 963 extension tests and
718 kernel tests pass, unchanged from the provided baseline. After that
refinement, the focused learning suite passes all eight checks. The main
session reruns both full suites after merging. Python AST comparisons
including source locations match the base revision for all five examples;
executable statements, line numbers and
the existing screenshot code are unchanged. All example comments fit within
80 columns, and `git diff --check` passes.

This branch verification used macOS. It does not establish physical Windows
or Linux key handling. The main session performs the fresh installed-VSIX
exercise check separately; the command-level tests use the VS Code test
harness and are not an actual editor screenshot review.
