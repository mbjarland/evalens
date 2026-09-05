# AI co-working — operating boundaries

> Status: Current
> Audience: AI agent, maintainer
> Source of truth for: what an agent may do, must confirm, and must not do
> Last verified: 2026-09-05

How an AI agent works on this repo. Read this before the first edit of any
session, together with [`../../CLAUDE.md`](../../CLAUDE.md).

## What AI may do unattended

- Read any file; run any read-only command (`git status`, `git diff`,
  `git log`, `npm test`, `npm run compile`, `gh issue view`, `gh issue list`).
- Edit code and docs under `src/`, `test/`, `prototype/`, `docs/`, `bin/`,
  `.github/`.
- Run the AST resolver against sample files and read the output back
  (`python3 prototype/form_at_cursor.py FILE LINE…`).
- Compile the extension and run its test suite.
- **File a GitHub issue for a finding**, using the template. A finding that
  goes unfiled because filing needed permission is a finding that gets
  rediscovered. Filing is cheap and visible; deleting or closing someone
  else's issue is not (see below).
- Create a branch and a worktree for an open issue, per
  [`../development/worktrees.md`](../development/worktrees.md). Local, cheap,
  reversible.
- Commit on an issue branch — with the issue reference, which the hook
  enforces anyway.
- `git mv` for renames, so blame survives. Never delete-and-recreate.

## What AI confirms before doing

Anything that touches state outside the working tree, or destroys local state
without an obvious undo:

- **Publishing to the VS Code Marketplace** (`vsce publish`, `ovsx publish`).
  Public, and a version number can never be reused. This is the one truly
  irreversible action in the project.
- `git push` to master, force-push, remote branch deletion.
- Closing, reopening, or editing an issue someone else wrote. Filing a new one
  is unattended; rewriting the record is not.
- **Removing a worktree or deleting a branch that has uncommitted or unpushed
  work.** Read `git status` in it and say what is there.
- Adding a runtime npm dependency. An extension that executes user code has a
  supply chain that matters; each dependency is a decision, not a convenience.
- Anything that runs code from the user's buffer outside the kernel
  subprocess.
- Any third-party API call that costs money or touches user data.

When proposing one of these, state what is about to happen and wait for a
yes/no.

## What AI never does

- Commit secrets — a marketplace Personal Access Token above all.
- Bypass the hooks (`--no-verify`) to dodge the issue gate, and above all
  never satisfy it by inventing an issue number.
- Force-push to `master`.
- Ship a `.vsix` built from a dirty tree. What was packaged must be a commit
  someone can check out.
- Evaluate code from a file the user did not ask to evaluate.
- Create files outside the project unless explicitly asked — the worktree root
  `~/projects/evalens-worktrees/` being the one standing exception.
- Restyle user-facing copy under the guise of a fix. The README pitch and the
  marketplace description are content, not chrome.

## When AI is uncertain

Surface it. Don't paper over.

- "The resolver returns the innermost expression for a cursor inside a nested
  comprehension; the ticket says 'the current form'. Those differ here.
  Which is intended?"
- "Clearing decorations on every keystroke is one line; keeping them anchored
  through an edit is the `ClosedOpen` behaviour Calva uses. The ticket doesn't
  say which. I'd rather ask than pick."
- "This test passes because the kernel echoes the source back, not because it
  evaluated it. Want me to make it assert the value instead?"

The cost of asking is one round trip. The cost of guessing wrong is debugging
the wrong thing.

## Delegating to agents

Implementation work goes to a subagent on its own worktree; this session
files the ticket and merges the branch. The point is that a long
implementation should not block the conversation.

- **Use the `evalens-worker` agent type** (`.claude/agents/evalens-worker.md`)
  rather than the generic type. It carries the worktree path convention, the
  npm cache flag, the commit shape, the read-only paths, and the
  verify-against-reality rules as its standing instructions, so a task prompt
  only has to state what is specific to that ticket instead of restating
  process every time — and the terminal shows the ticket name instead of a
  bare `general-purpose`.
- **One agent per ticket, or per tightly-coupled pair.** Pair only when the
  two genuinely cannot ship apart — an interrupt and the prompt that needs it
  (#26/#34), a pending state and the input UI that uses it (#10/#61).
- **Name the agent `#<issue>-<slug>`**, matching the branch and worktree.
- **Prefer disjoint files.** Several agents in one file means a rebase per
  merge; it is sometimes worth it and never free.
- **Give the agent the WHY, not just the what.** The best results in this
  project came from briefs that explained what the ticket was for and named
  the failure it was avoiding; agents given only a specification produced
  code that met it and missed the point.
- **Tell it what must not break.** A list of invariants — the pure/impure
  split, `dont_inherit=True`, the control channel — has caught real
  regressions during rebases.
- **Agents do not push and do not merge.** They commit on their branch and
  report. Merging is this session's job, and it includes re-running both
  suites, because a clean rebase is not evidence that both sides survived.

## Default cadence

1. Sketch the change in a sentence or two — not a plan document.
2. Make the edit on the issue's branch, in the issue's worktree.
3. Run the relevant test.
4. **For anything that renders in the editor, look at it.** A decoration test
   that asserts on a range proves the range; it does not prove the user sees
   the value. Screenshot or record the Extension Development Host.
5. Commit with `fixes #NNN` / `refs #NNN`.
6. Report tersely. One or two sentences.

Skip steps that don't apply. Don't launch a host for a doc typo.

## Signals AI watches for

- **"It still does X"** after a claimed fix → the fix didn't ship, didn't fix
  it, or fixed the wrong place. Check first, don't re-propose.
- **"Why is this called X here and Y there?"** → convention sprawl. Fix both,
  and write the canonical name down.
- **"Looks the same as before"** → an Extension Development Host running old
  compiled output, or the wrong window. Confirm before re-trying.
- **"Stop doing X"** → save a feedback memory immediately. The user shouldn't
  have to repeat themselves.

## Posture: the code-execution path

Most of this project is reversible — a decoration renders wrong, you fix it
and re-render. One part is not: **the kernel executes arbitrary code from the
user's buffer**, in a persistent namespace, at a moment this extension
chooses. Re-running a line that opens a socket, writes a file, or charges a
card is not undone by a redeploy.

When work touches that path (label it `executes-user-code`), escalate:

- **Evaluation is explicitly triggered, never continuous.** This is Calva's
  model and it is why Calva needs no blocklist; AREPL runs continuously and
  consequently needs an `unsafeKeywords` hack. Do not drift toward
  evaluate-on-type without a decision ticket.
- **Nothing is evaluated that the user did not point at.** "Run everything
  above this line" is a separate, explicit command — not a fallback the
  extension takes on its own when state is missing.
- **The kernel is a separate process that can always be killed**, and killing
  it must be a documented, reachable action rather than an internal detail.
- **Propose the protocol and the trigger semantics before writing the code.**
  The user reviews. Then code.
