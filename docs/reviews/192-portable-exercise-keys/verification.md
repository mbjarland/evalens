# Portable editable exercise instructions

Issue #192 corrects the editable Python examples, which previously substituted
only the host platform's shortcut even though the walkthrough guide showed
both. The five shipped `.py` files now contain both labeled defaults and are
opened without substitution. Existing user copies are not rewritten.

| Exercise | Command | Windows/Linux | macOS |
| --- | --- | --- | --- |
| Predict a value | Evaluate at Cursor | Ctrl+Enter | Cmd+Enter |
| Follow the next statement | Evaluate and Advance | Ctrl+Shift+Enter | Cmd+Shift+Enter |
| Two names, one list | Evaluate and Advance | Ctrl+Shift+Enter | Cmd+Shift+Enter |
| Fix an accumulator | Evaluate File | Ctrl+Alt+Enter | Cmd+Alt+Enter |
| Notice an old answer | Evaluate at Cursor | Ctrl+Enter | Cmd+Enter |

The existing learning test now opens each exercise independently through the
registered command and checks both labeled defaults against that command's
manifest binding. It also checks that the opened text equals the packaged
Python file, instead of comparing a second read of the same file. The existing
real-kernel exercise checks still verify the expected values and histories.

Validation on the issue branch: 963 extension tests and 718 kernel tests pass,
unchanged from the provided baseline. The focused learning suite passes all
eight checks. Python AST comparisons including source locations match the
base revision for all five examples; executable statements, line numbers and
the existing screenshot code are unchanged. All example comments fit within
80 columns, and `git diff --check` passes.

This branch verification used macOS. It does not establish physical Windows
or Linux key handling. The main session performs the fresh installed-VSIX
exercise check separately; the command-level tests use the VS Code test
harness and are not an actual editor screenshot review.
