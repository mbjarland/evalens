---
name: Finding
about: A correctness, safety, or quality defect found by reading or using the code
title: "<area>: "
labels: "bug"
---

> A finding is what a review or a session *discovered*, as opposed to work
> someone planned. File it even when you are about to fix it — the record of
> what was wrong and how it was caught is worth more than the diff, which git
> already has. Deferred and won't-fix findings stay open on purpose, with the
> rationale in the ticket.

## What

The defect, stated so a reader without context understands it: what the code
does today, what it should do, and where (`file:line`).

## Impact

Blast radius in consequences: what breaks, who sees it, and under what
conditions. Grade it Critical / High / Medium / Low / Nit — severity is
re-assessable, so it is a label, not part of the title.

## Fix sketch

The intended shape of the fix, including what it deliberately does NOT cover.
If the honest disposition is "defer" or "by design", say so and give the
rationale rather than closing quietly.

## Verified-by

The regression test or check that proves the fix and keeps it fixed. A
finding closed with no verified-by is a finding that will be found again.

## Estimate

Required, scale `1/2/3/5/8/13`, rubric in
`docs/development/issue-tracking.md`. When torn between two values, pick the
larger.
