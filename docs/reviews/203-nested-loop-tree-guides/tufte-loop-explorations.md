# Draft: six further ways to read nested loops

Issue: [#203](https://github.com/mbjarland/evalens/issues/203).

**Visual review pending. These are unimplemented concepts. No alternative
has been selected; the draft files remain uncommitted.** Earlier A–G
artifacts are unchanged.

Open [the interactive comparison](tufte-loop-explorations.html), or inspect
[the full image](tufte-loop-explorations.png). The image is 3920 × 5650
pixels, captured at a 1960 CSS-pixel viewport with DPR 2.

The first row shows the current production renderer without guides and
the previous F structure with both outer iterations open. H–M start with
`x = 0` folded and `x = 1` open. All use the same recorded 2 × 3 example.

| Concept | Main change | Tradeoff to review |
| --- | --- | --- |
| H — Follow the visible branch | Connect to the folded caption or visible inner header. | Familiar structure, with extra linework in the margin. |
| I — Put context beside the source | Join `x = …` and the inner source in one caption. | One fewer heading row; source still repeats horizontally. |
| J — Show the source tree once | A shared source map precedes grouped results. | Less repetition; source and individual groups are farther apart. |
| K — Move context into the margin | Place the outer value beside its inner rows. | Values begin immediately; shared context is carried by position. |
| L — Let the values form a ledger | Name variables once, then align numeric readings. | Easier comparison, with less sentence-like labeling. |
| M — Emphasize the branch you inspect | Strengthen the clicked or focused branch. | Quieter at rest; stronger guidance depends on interaction. |

H and M point to the visible representative when an iteration folds.
I–L change information organization rather than guide color. Every design
keeps one Variables / Printed output header pair, readable data, and the
square orange result bar. No extra inner-loop disclosure is introduced.

## Try the draft

Click an iteration arrow, or focus its button and use Enter or Space.
All six alternatives support open, closed, and mixed states. M's bright
guide follows the last clicked or keyboard-focused iteration. Cards stack
below a 1500px viewport; the 900px check retains 20px source text without
overflow. About these values opens locally. Export and source navigation
are not connected. The page never evaluates code or connects to VS Code.

## Evidence and limits

The existing [nested-loop fixture](../196-marketplace-page-refresh/fixtures/nested-loops.py)
runs once in an isolated kernel. H/M use compiled production-renderer
markup. I–L use standalone HTML/CSS populated from that same recorded model.
For the visible `x = 1` group, `y = 0, 1, 2` pairs with `v = 1, 2, 3` and
printed output `1 0`, `1 1`, `1 2`. Final values are `x = 1, y = 2, v = 3`.

J–L derive their source map from `LoopSite` source and parent metadata.
It describes source nesting; the rows below describe recorded iterations.
The count of three iterations each is specific to this fixture. General
implementation would need differing counts, conditional execution, and
unvisited loops to remain explicit.

The Current reference uses actual production markup in a standalone shell;
it is not a native VS Code screenshot. No existing image pixels, public
assets, runtime code, or teaching files were changed.

## Tufte references

These are our interpretations, not a claim that Tufte endorses a design:
retain detail while reducing framing, as discussed in
[Sparkline theory and practice](https://www.edwardtufte.com/notebook/sparkline-theory-and-practice-edward-tufte/);
place labels close to what they describe, as in
[Mapped pictures](https://www.edwardtufte.com/notebook/mapped-pictures-image-annotation/);
and use thin contours deliberately because they strongly group content,
as explored in
[On the edge](https://www.edwardtufte.com/notebook/on-the-edge-at-the-margin-contours-surrounds-frames/).

## Reproduce

With dependencies and compiled output in the main checkout:

```sh
EVALENS_RUNTIME_ROOT=/Users/mbjarland/projects/evalens \
  node docs/reviews/203-nested-loop-tree-guides/render-tufte.cjs
```

The script checks matching runtime sources, runs the fixture, generates
HTML from `tufte-template.html`, and captures it in fresh headless Chrome.
[tufte-checks.json](tufte-checks.json) records hashes, readings, header
counts, reference states, all six fold sequences, M's focus destinations,
and the narrow layout. No browser script errors were observed.

Full product suites and native acceptance were not run for these draft
concepts. Visual review of the original and alternatives remains pending
before any selection, implementation, or completion.
