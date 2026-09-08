# Recording evidence verification

Branch implementation for issue #185. This changes presentation only:
`kernel/`, the wire protocol, capture budgets and evaluation triggers are
unchanged. No stored values are re-read, re-represented or inferred.

## Automated evidence

Initial branch base `f24d5ac`: 937 extension and 718 kernel tests.
First implementation pass: 942 extension and 718 kernel tests.

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

## Still requiring actual Host inspection

The root session will inspect the built extension in its isolated VS Code
Host: native Why/Recording details with Enter and Space, sticky nested context
while scrolling, dark/light/high-contrast and enlarged text, R2 closure,
source staleness, and compatibility with the optional introduction. These
visual and physical-key checks are not claimed by the module assertions.
