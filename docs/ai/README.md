# AI co-working fast path

> Status: Current
> Audience: AI agents and the maintainer supervising them
> Source of truth for: AI documentation entry points
> Last verified: 2026-09-05

This repo is built AI-first. The AI path stays short, explicit, and
high-signal; it does not hide behind human onboarding prose.

## Start every AI session

1. Read [`../../CLAUDE.md`](../../CLAUDE.md) — the operating contract.
2. Read [`co-working.md`](co-working.md) — what you may do, must confirm, and
   must not do.
3. Before touching code, check that the work has an issue
   ([`../development/issue-tracking.md`](../development/issue-tracking.md))
   and a worktree
   ([`../development/worktrees.md`](../development/worktrees.md)).
4. Read [`../../IDEA.md`](../../IDEA.md) for what this project is and why —
   including the prior art it is deliberately following.

## Fast topic routing

| Task | Read |
|---|---|
| File a ticket, size it, label it | [`../development/issue-tracking.md`](../development/issue-tracking.md) |
| Start work on an issue | [`../development/worktrees.md`](../development/worktrees.md) |
| What the project is, and the design it follows | [`../../IDEA.md`](../../IDEA.md) |
| Boundaries, cadence, code-execution posture | [`co-working.md`](co-working.md) |

## The three rules that are gated, not trusted

1. **No work without an issue.** Blank issues are disabled; three templates
   force a TL;DR, a stated consequence, and an estimate.
2. **One issue, one worktree, one branch**, all named `<issue>-<slug>`, under
   `~/projects/evalens-worktrees/`.
3. **No commit without an issue reference.** `bin/hooks/commit-msg` refuses it
   locally; the `commit-issues` CI job refuses it on the branch.

## Do not regress these

- Keep `CLAUDE.md` as the primary AI operating contract; keep AI process docs
  under `docs/ai/`.
- Preserve copy-pasteable commands and exact file paths — agents rely on them.
- Prefer small, searchable Markdown over anything that needs a tool to read.
- When a rule turns out to depend on memory, make it a gate or delete it.
