---
name: Decision / spike
about: A call to make — the deliverable is a written recommendation, not code
title: "Decision/spike: "
labels: "blocked-on-decision"
---

**TL;DR** — the situation in one sentence, then: *this ticket is a decision +
spike, not a build.* Name the question it settles.

## Why this matters

What is blocked or at risk while the question stays open, and who feels it. A
decision ticket earns its place by naming the cost of *not* deciding — drift,
two half-built approaches, or a design nobody can quote with confidence.

## Where we are now

The factual current state, so the call is made against reality rather than
memory. Say what already exists — often the thing being proposed is half-true
already, and naming that changes the question. Cite evidence by path
(`docs/…`, `prototype/…`, a line in a Calva source file), not by
recollection.

## The options

Each option with its consequence, the recommendation first and marked as
such. Include "decide not to decide" if deferral has a real price — then
state that price.

## What closes this

A written recommendation on this ticket, and — if the decision is
load-bearing — a record that outlives it: a section in the relevant doc under
`docs/`, or an entry in `docs/development/decisions.md`. The decision names
its reversibility criteria: under what findings it gets revisited.

## Estimate

Required, scale `1/2/3/5/8/13`, rubric in
`docs/development/issue-tracking.md`. A decision/spike sizes the
*investigation*, usually 2–3.
