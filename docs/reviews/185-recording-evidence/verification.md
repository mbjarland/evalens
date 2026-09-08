# Recording evidence verification

Branch implementation for issue #185. This changes presentation only:
`kernel/`, the wire protocol, capture budgets and evaluation triggers are
unchanged. No stored values are re-read, re-represented or inferred.

## Automated evidence

Initial branch base `f24d5ac`: 937 extension and 718 kernel tests.
After rebasing onto `44019ba` (the font-relative gutter fix): 942 extension
and 718 kernel tests. Five new extension regressions; kernel unchanged.

The extension suite drives the real Python kernel over its request pipe and
renders the returned recording through the compiled panel modules. Added
checks cover printed `4` beside end-of-iteration `u = 99`, an assignment
followed by `continue` whose body reading is missing, exact nested timing
names and parent iteration context, and collapsed stale/error/partial/output
status. Metadata variants check the distinct unavailable-frame, unproven-name
and older-recording explanations without asserting that an assignment did
not run. Native Why disclosures carry accessible per-iteration names.

Existing real-kernel cases still exercise conditional carry-over, silent and
empty loops, `break`, skipped captures, representation side effects, 100x100
retention boundaries, output offsets, million-iteration limits and paging.
The 100x100 case still has 20 saved outer iterations and 59 saved inner
iterations under the final saved outer iteration. Output not individually
associated with an iteration remains separately folded under its loop owner.

The rendered markup contains no inline style attributes: context depth is
set through CSSOM under the existing nonce-protected script. Local native
explanation controls stop source-navigation events and post no provider or
kernel requests. The current loop context uses the measured toolbar height;
covered ancestor contexts retain layout height rather than accumulating
sticky boxes or moving results.

## Actual Host review and follow-up

The root session drove its isolated real VS Code Host and inspected the
rendered screenshots. It confirmed named timing, `u = 99` beside printed
`4`, physical Enter opening Recording details and Why without moving source,
100x100 saved counts and nested parent context while scrolling. No CSP
console errors appeared. Evidence is initially in
`/private/tmp/evalens-185-host.json` and the companion timing, missing and
sticky PNGs owned by the root session.

That review found a six-pixel seam above the sticky context leaking a clipped
row. The implementation now uses the toolbar's actual bottom edge. Contexts
unpin while Recording details is open, or when the heading itself exceeds
half the available height. Help uses ordinary document scrolling; opening a
previously pinned summary preserves its visible position. These final
adjustments still need the root session's final Host pass, including short
panes, dark/light/high-contrast, enlarged text, R2 closure and compatibility
with the optional introduction. The initial Host pass is not offered as
proof of the final revised scroll behavior.
