# Draft: shared text edges for N

For [#203](https://github.com/mbjarland/evalens/issues/203). **Visual review
pending. No runtime change, implementation selection, or commit.**

Compare [the interactive HTML](n-alignment-comparison.html) or
[the image](n-alignment-comparison.png). Previous N remains on the left;
Aligned N changes only text placement and the disclosure gutter.

The Iteration 1 and Iteration 2 text, `base = 10`, and `for y` now share
the Variables header's left edge. The blue triangles occupy a separate
gutter. Inner y/v readings sit 19px farther right. Every printed reading
shares the Printed output header's edge. The short connector stops before
the inner source text and does not continue alongside the values.

The base row remains directly below Iteration 2 and before the inner loop,
beside printed `base: 10`. Its recording semantics and folded summary are
unchanged. No evaluation was needed; the existing fixture recording and
rendered markup are reused.

[The check report](n-alignment-checks.json) measures actual text ranges
with Range/getClientRects at widths 1960, 1300, and 980px. All requested
shared-edge differences are 0px; inner indentation is 19px. The arrow
glyphs leave about 12px before the labels, and the child connector ends
7px before the aligned source text. Folding, output order, and the
populated base cell remain correct, including when result columns stack.

All earlier artifact hashes are unchanged. This comparison is a local
HTML prototype, not native VS Code acceptance. Product suites were not
rerun for the draft. The image is 3920 × 2000px at DPR 2.

Reproduce with the main checkout's dependencies:

```sh
EVALENS_RUNTIME_ROOT=/Users/mbjarland/projects/evalens \
  node docs/reviews/203-nested-loop-tree-guides/n-alignment-render.cjs
```
