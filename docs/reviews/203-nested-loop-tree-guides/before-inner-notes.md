# Draft: work before the inner loop

For [#203](https://github.com/mbjarland/evalens/issues/203). **Visual review
pending: no implementation selected, no runtime changes, no commit.**
All earlier A–M artifacts remain byte-for-byte unchanged.

Compare [the interactive HTML](before-inner-comparison.html) or
[the single image](before-inner-comparison.png). The image contains the
current production layout and three proposals, all using the same new
[numbered source fixture](before-inner-fixture.py). It is 3920 × 3600px,
captured at a 1960 CSS-pixel viewport with DPR 2.

| Proposal | What carries the relationship | Visible tradeoff |
| --- | --- | --- |
| N — Anchor the whole iteration | The root connects to permanent iteration captions; a second branch covers their output and inner loop. | Familiar structure with additional guide lines. |
| O — Show all the source once | A static outline includes the extra statements; ordered results use short source cues. | More source copy and some line-number lookup. |
| P — Keep the owner in the margin | The outer summary stays beside all its work, with a separate row for its direct output. | Compact results, but shared context relies more on position. |

The initial state folds `x = 0` and opens `x = 1`. All four cards have
working iteration controls. Enter or Space also toggles a focused button.
The browser preview never evaluates code or connects to VS Code.

## Recording semantics

The real kernel records `base` as an outer body variable at the end of
the outer iteration. It remains in that iteration's summary in every
proposal. None of these designs claims a variable snapshot was captured
before an individual statement.

The stdout range before the inner invocation contains `base: 10`. It
precedes the three inner readings `y = 0, 1, 2`, `v = 10, 11, 12`, with
printed output `1 0`, `1 1`, `1 2`. Each outer iteration prints four lines;
its inner loop prints three. Final values are `x = 1, y = 2, base = 10,
v = 12`.

O's outline describes source structure, not proof that every listed
statement executed. Its statements come from this explicit fixture;
general statement outlines would require appropriate source parsing.

## Checks and remaining review

The generator uses an isolated real-kernel recording. Current and N use
compiled production-renderer markup; O and P use custom HTML/CSS with
that same model. Current is renderer evidence in a standalone shell,
not a native VS Code screenshot.

[The check report](before-inner-checks.json) records hashes, exact values
and output order, one shared header pair per card, and all four fold
sequences. At widths 1960, 1300, and 980px, output headings align with
their rows within 1px and no horizontal overflow occurs. N has a real
text gutter; P derives headings and rows from a shared CSS subgrid.
Earlier artifact hashes are checked before and after generation.

For a later implementation, review these cases as well: no output before
the inner loop must produce no empty row; output afterward returns to
the parent; sibling inner loops remain ordered; and very long parent
output folds inside its own iteration. Those cases are not additional
implemented behavior or acceptance evidence in this draft.

Reproduce with compiled output and dependencies in the main checkout:

```sh
EVALENS_RUNTIME_ROOT=/Users/mbjarland/projects/evalens \
  node docs/reviews/203-nested-loop-tree-guides/before-inner-render.cjs
```

No product suites or native VS Code sessions were run for these design
artifacts. The original and alternatives still need the user's visual
review before selection or implementation.
