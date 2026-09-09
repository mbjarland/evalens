# Shared loop headings verification

Issue #198 restores the shared Variables / Printed output heading for an
entire loop explorer. Inner loops keep their source, count and line label,
without repeated headings, parent-context sentences or routine timing rows.
All data rows use the same column width; source headings indent separately.

The shared heading contains one native **About these values** disclosure.
Its explanation covers loop-variable readings at the start of an iteration,
body readings at its normal end, print-before-reassignment, conditional
carry-over, missing readings and saved-detail limits. Local **Why?**, missing
name notices, omitted names, capture limits and stale/error states remain.
No kernel, protocol, budget or evaluation-trigger code changed.

The shared title becomes a compact owner/source reminder only after those
headings leave the reading area. It occupies the original title's space, so
no context row is added and the document height does not change. Opening the
help disclosure restores normal scrolling; a heading taller than half the
remaining panel also stays in normal flow. Narrow layouts retain local
Variables and Printed output labels beside each stacked pair.

## Automated and renderer checks

The baseline at `5e44bec` passed **968 extension tests and 718 kernel
tests**. The implementation passes **969 extension tests and 718 kernel
tests**, with no failures or skips. The additional regression uses a real
Python response for three nested levels and a sibling loop. Updated existing
regressions verify one heading/help control, print-before-reassignment,
missing readings and unchanged nested output. Existing large-loop, Unicode,
representation-side-effect, fold, paging and provider-navigation checks pass.

`verify-renderer.cjs` evaluates five disposable fixtures through the real
kernel and loads the compiled panel's HTML, styles and script in Chromium.
Run it after compiling:

```sh
npm --cache /private/tmp/evalens-npm-cache run compile
node docs/reviews/198-shared-loop-headings/verify-renderer.cjs
```

The report in `renderer-results.json` records **64 layout cases**: two-level
and three-level/sibling fixtures, widths 300, 560, 900 and 1400, editor fonts 14
and 28, and dark/light/high-contrast theme variables. Every wide row aligns
with the one shared heading. Narrow rows keep visible variable/output
labels, and visible controls stay within the viewport without horizontal
document overflow.

The root session's native Host review found that avoiding overflow was not
enough: at a narrow width and large editor font, the help control squeezed
the title into a column only a few characters wide. The title now has a
24ch preferred width, letting the help wrap below when both do not fit. The
added regression failed against the old CSS: at width 300 and font 14, the
title was 70.8px wide and 80px tall instead of the natural 32px height. It now
uses the full result width. At width 560 and font 28, the source title uses
467px and two lines, with help below; the wide layout keeps help beside it.
The rendered narrow result was inspected after this fix. The report records
actual/natural title heights and available widths for all 64 cases.

Additional Chromium checks cover native Enter on About these values and
Space on a missing-value Why disclosure; neither sends a provider message.
An actual 100-by-100 capture shows the owner/source reminder after scrolling
past its headings and removes it on returning, without changing document
height. The whole-result fold still matches the code's height. The five
kernel requests are completed before browser interaction; no browser action
can reevaluate them. No browser script errors were reported.

## Verification limits

These are actual kernel and compiled-renderer checks, not an Extension
Development Host review, physical Windows-keyboard check, human screen-reader
session or learner study. The root session owns the separate native Host
review, current screenshots and stable VSIX rebuild. Until that review is
complete this branch uses `refs #198`, not a closure claim.
