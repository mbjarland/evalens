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

The five guides also show actual rendered results from the exercise code.
Screenshots are shipped under `media/learning/screenshots/`; the Markdown uses
relative image paths so the native walkthrough can load them from an installed
VSIX. Each image follows the prediction and evaluation steps, with alternative
text and a caption explaining the recorded result. Source comments containing
platform keys are outside the crop. The guides give command names and separate
Windows/Linux and macOS defaults in text, with the Command Palette as a fallback.

Automated checks verify manifest links against the exercise allowlist, real
`vsce ls` packaging including every referenced PNG, fresh Python copies, command
dispatch, group reuse, platform defaults in both comments and guide tables,
and exercise results through the real kernel pipe. The accumulator check
includes both recorded histories, not only the final sum. These checks do not
verify pixels, focus behavior, or physical keyboard handling.

For a live check, open the guide with the palette command, try all five
exercises, and confirm prediction 14, sequence total 24, alias result
`[1, 2, 3, 4]`, accumulator 6 then 12, and stale answer 10 then evaluated 20.
Check that the guide does not appear automatically in a fresh install, opening
an exercise does not check its step, the checkbox can be marked manually,
and repeated exercises reuse their group. Repeat from an installed VSIX to
verify its Markdown assets and examples load outside the development tree.

## Updating the screenshots

Use a running Extension Development Host with the current compiled extension
and a temporary workspace containing copies of the shipped exercise code.
Keep the ordinary square amber result bars and the current theme styling.
Capture the editor itself; do not reconstruct annotations in an image editor.
Keep all code and results needed for the comparison visible and crop away
unrelated workbench chrome and platform-specific instructional comments.

Use words for lists in image alternative text, such as "three-item list".
In the actual VS Code 1.136.1 walkthrough, literal square brackets inside
alternative text caused the image URL to become empty. The packaging check
guards this observed limitation; ordinary prose can still show Python lists.

| Screenshot | Exercise and capture point |
| --- | --- |
| `predict.png` | Evaluate `2 + 3 * 4`; include the recorded 14. |
| `advance-first.png` | Evaluate and advance from `price = 8` once; include the cursor on the next, unevaluated assignment. |
| `advance-complete.png` | Evaluate all three assignments in order; include 8, 3, and 24. |
| `aliasing.png` | Evaluate all four statements from the initial list assignment; include the first and last recorded lists. |
| `accumulator-before.png` | Evaluate File with `total = score`; include the loop history and final total 6. |
| `accumulator-after.png` | Change to `total += score`, then Evaluate File; include the new history and final total 12. |
| `stale-before-rerun.png` | Evaluate `answer = 10`, edit it to `answer = 20`, and capture without evaluating again. |
| `stale-after-rerun.png` | Evaluate the edited assignment; include the recorded 20 with its normal marker. |

Inspect each crop and each native walkthrough page. Rebuild the VSIX and repeat
the native walkthrough check from the installed extension: a Markdown preview
alone does not prove that its image paths work in a walkthrough. Check that an
exercise still opens as editable Python, opening it does not evaluate anything,
and completion remains manual. Record the source revision, capture environment,
actions and limitations in `docs/reviews/191-rendered-learning-guides/`.

Windows/Linux guidance is checked against the extension manifest and generated
exercise comments. A capture on macOS does not establish that physical Windows
keys work; report that limitation separately from the documentation checks.
