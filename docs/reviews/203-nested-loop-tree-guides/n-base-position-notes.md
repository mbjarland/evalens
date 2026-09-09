# Draft: base before the inner loop

For [#203](https://github.com/mbjarland/evalens/issues/203). **Visual review
pending. No implementation approval, runtime changes, or commit.**

Compare [the interactive HTML](n-base-position-comparison.html) or
[the image](n-base-position-comparison.png). The left card preserves the
previous revised N; the right changes only the base reading's placement.

In the new proposal, `base = 10` occupies the Variables cell beside printed
`base: 10`, directly below Iteration 2 and above `for y`. The trailing base
row is removed. Folding restores base to the summary. The short child
guide, indented y/v readings, shared columns, and four printed lines retain
their previous arrangement.

This changes presentation only. The reused reading was captured at the
end of the outer iteration, not at assignment time. This fixture does not
change base inside its inner loop. The preview caption and existing About
these values help retain that timing distinction without adding a timing
label to the row.

[The check report](n-base-position-checks.json) verifies the order of the
heading, base/output row, and inner source; their shared baseline and
column alignment; both iterations' folds; and absence of a trailing base
row. The populated row no longer has the output-only `loop-direct` class,
so base stays visible when the result columns stack. Earlier artifacts'
hashes remain unchanged.

The 3920 × 2012px image and local fold controls reuse the existing real
recording. No new kernel evaluation, product suites, or native VS Code
connection were needed. The files remain uncommitted for visual review.

Reproduce with the main checkout's dependencies:

```sh
EVALENS_RUNTIME_ROOT=/Users/mbjarland/projects/evalens \
  node docs/reviews/203-nested-loop-tree-guides/n-base-position-render.cjs
```
