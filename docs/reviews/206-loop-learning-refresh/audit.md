# Loop documentation audit for #206

This refresh covers the approved aligned-guide design from #205. The public
example uses the six-line source shown during design review: the outer loop
sets and prints `base`, then the inner loop computes `v = base + y` and
prints `x, y`. The original four-line fixture is left intact as historical
capture provenance; the new example is `nested-loops-base.py` in the shared
public-capture fixture directory.

## Assets to refresh

| Asset | Reason |
| --- | --- |
| `media/demo/nested-loop-code.png` | Source must include the outer `base` assignment and print, matching the approved explorer example. |
| `media/demo/nested-loops.png` | The old image has no guides or separate outer body reading. The new image folds Iteration 1 and expands Iteration 2, showing `base = 10` and the inner readings. |

Both images are actual native VS Code captures. The source image keeps 18px
Menlo at its normal 711px display width. The result image shows one Variables
and Printed output heading, one About these values disclosure, the orange
leading bar, neutral background, aligned outer labels and inner header, and
indented inner readings. Capture metadata records the final runtime revision,
source, fold state, sizes, and hashes. No design mockup becomes a public image.

## Copy to refresh

| File | Change |
| --- | --- |
| `README.md` | Match the six-line source, source-image description, expected values, and approved fold state; explain the short guide without changing the branding or editorial voice. |
| `docs/user-guide.md` | Add the same source/result pair to the nested-loop explanation and explain the aligned outer body row, gutter guide, inner indentation, and unchanged capture timing. |
| `docs/development/recorded-result-language.md` | Resolve #204: use one shared heading and put timing explanations under About these values, retaining visible missing/stale/incomplete facts. |
| `examples/demo.py` | Remove the old `x5` count wording and the claim that every body binding is recorded. |
| `examples/tour.py` | Correct the old final-target-only explanation and distinguish an uncaptured body end from an iteration that computed nothing. |

All evaluation instructions retain Mac shortcuts first and Windows/Linux
equivalents in parentheses. Runtime behavior, command bindings, extension
version, changelog, the five learning exercises, and unrelated copy are
outside this documentation refresh.

## Checked and retained

The other ten public demo PNGs show inline results, flat Values rows, or the
walkthrough introduction; none contains a nested-loop explorer. Their image
bytes and capture entries stay unchanged.

The eight packaged walkthrough PNGs show prediction, successive evaluations,
aliasing, stale results, and a single-level accumulator. The two accumulator
images already show current values-first histories and the iteration count
after each history. No walkthrough screenshot contains the nested explorer,
so no screenshot needs a replacement for the guide design. Their associated
Markdown and exercise files describe those same interactions and retain the
platform key references. They remain unchanged after the audit.

`examples/grades.py` teaches a single-level accumulator. Its values and
instructions remain accurate. The other loop demonstrations continue to
exercise their original code; the two changed examples only correct comments.

Native and Marketplace acceptance results are recorded separately after the
final #205 runtime is available. An asset audit and matching source text do
not by themselves establish that a screenshot shows the new interface.
