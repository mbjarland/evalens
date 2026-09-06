# Optional learning walkthrough

Issue #156 adds five native VS Code walkthrough steps. The Command Palette
entry **Evalens: Open Learning Walkthrough** reveals the guide; **Evalens:
Open Learning Exercise** opens an individual example. No evaluation command
is dispatched by either entry.

`media/learning/` is shipped product content. The `.py` files are templates
for ordinary editable untitled Python documents: only comment placeholders
are replaced with the current platform's default keys. The guide names the
Command Palette as the fallback for customized or conflicting bindings. The
extension selects the first statement so the learner's first evaluation does
something, and reuses a visible exercise group to avoid accumulating columns.
It does not overwrite examples on disk or save into the user's project.

Two native walkthrough defaults would overstate or interrupt this experience:

- VS Code can open a walkthrough upon extension installation. Its `when`
  clause therefore requires `evalens.learning.requested`, set only by our
  explicit command, without changing global settings.
- Without completion events, VS Code checks a step when its command link is
  clicked (or the step opens). Each step instead names the reserved event
  `evalens.learning.manualCompletion`, which this extension never emits.
  Learners mark the native checkbox themselves after trying the exercise.
  We do not infer understanding from executing a command or opening a file.

These behaviors follow VS Code's `registerExtensionWalkthroughContributions`
and `registerDoneListeners` in
[gettingStartedService.ts](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/welcomeGettingStarted/browser/gettingStartedService.ts).

Automated checks verify manifest links against the exercise allowlist, real
`vsce ls` packaging, fresh Python copies, command dispatch, group reuse,
platform defaults, and exercise results through the real kernel pipe. The
accumulator check includes both recorded histories, not only the final sum.
The tests do not verify pixels, focus behavior, or actual keyboard handling.

For a live check, open the guide with the palette command, try all five
exercises, and confirm prediction 14, sequence total 24, alias result
`[1, 2, 3, 4]`, accumulator 6 then 12, and stale answer 10 then evaluated 20.
Check that the guide does not appear automatically in a fresh install, opening
an exercise does not check its step, the checkbox can be marked manually,
and repeated exercises reuse their group. Repeat from an installed VSIX to
verify its Markdown assets and examples load outside the development tree.
