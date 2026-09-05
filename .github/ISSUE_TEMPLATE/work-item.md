---
name: Work item
about: Something to BUILD or FIX (knowledge goes in docs/, not here)
title: "<area>: "
labels: ""
---

**TL;DR** — one or two sentences: what is true today, what will be true when
this closes, and what this ticket is *not*. If it takes more than two
sentences, it is probably two tickets.

## Why this matters

The consequence, in terms of who is affected and what goes wrong — not
abstract value. "Re-evaluating a line silently re-runs the HTTP request it
contains" beats "improves correctness". If the prototype's go/no-go, a
marketplace listing, or a shipped install depends on it, name which one.

## Background

The history that makes the current state make sense: what was decided before,
what was already tried, what this builds on. Write it so a reader with no
context follows the prose; issue numbers are trailing side notes, never
load-bearing. This section is what stops the next session re-deriving a
conclusion or re-running a closed dead end.

## What changes

Describe the change and name the files or modules. For a ticket with distinct
pieces, give each its own numbered heading. Say explicitly what is OUT of
scope.

## How we know it worked

The check that closes the ticket: a test at the right layer, a decoration
that renders the new truth in a real editor, a resolver run over a real file.
"It compiles" is not a check. For anything visible in the editor, the check
includes *looking at it* — a screenshot or a recorded clip, not an assertion
alone.

## Estimate

Required, scale `1/2/3/5/8/13`, rubric in
`docs/development/issue-tracking.md`. Put the number here and in the project
board's Estimate field once a board exists. When torn between two values,
pick the larger.
