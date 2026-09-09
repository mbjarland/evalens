# Draft: original and revised N

For [#203](https://github.com/mbjarland/evalens/issues/203). **Visual review
pending. No implementation approval, runtime change, or commit.**

Open [the interactive comparison](n-body-values-comparison.html) or
[the image](n-body-values-comparison.png). Original N remains alongside
the revised proposal, using the same numbered source and recording.

The revision makes two changes for review:

- When expanded, the outer heading shows `x`, while `base` gets its own
  Variables row after the inner readings. The small `at iteration end`
  cue identifies the saved outer-iteration reading. Folding returns
  `base` to the summary, without leaving a visible duplicate row.
- The child guide stops at the inner `for y` heading. Its y/v readings
  indent about 19px farther right. The base row returns to the outer
  level; no guide continues alongside the values or below that heading.

The `base: 10` printed output stays before `1 0`, `1 1`, and `1 2`.
Output cells remain aligned beneath one Printed output heading. The
global final-values footer is separate from the per-iteration base row.

This draft reuses the existing real recording and original N's production
markup from `before-inner-comparison.html`; no new kernel evaluation was
needed. All earlier A–P and `before-inner-*` files remain unchanged.

[The check report](n-body-values-checks.json) verifies the mixed state,
both outer base readings when open, no output or base-row leaks when
folded, and restoration of both summaries. At widths 1960, 1300, and
980px, headings/output stay aligned, y/v indentation remains clear, and
the guide stops at the inner header. The preview stacks below 1500px.

Reproduce with the main checkout's dependencies:

```sh
EVALENS_RUNTIME_ROOT=/Users/mbjarland/projects/evalens \
  node docs/reviews/203-nested-loop-tree-guides/n-body-values-render.cjs
```

The image is 3920 × 2400px at DPR 2. Folding is local to this HTML page;
there is no native VS Code connection. Product suites were not rerun for
this draft visual refinement. Selection and implementation remain pending
the user's visual review.
