# Evalens — AI operating contract

Inline evaluation for Python in VS Code: put the cursor on a line, hit a key,
see the value painted inline next to the code. **What this is, what already
does part of it, and what would kill it are in [`IDEA.md`](IDEA.md)** — read
it before proposing anything about architecture, naming, or scope. Smart Send
and `debug.inlineValues` are shipped Microsoft features that cover most of the
pitch separately; a proposal that ignores them is a proposal against a market
description that is wrong.

> **AI-facing docs live in [`docs/ai/`](docs/ai/).** Read
> [`docs/ai/README.md`](docs/ai/README.md) and
> [`docs/ai/co-working.md`](docs/ai/co-working.md) before the first edit of a
> session.

## The three rules

They are the whole process, and each one is enforced by something other than
memory:

1. **No work without an issue.** Everything planned or found is a GitHub issue
   on `mbjarland/evalens`, filed through one of the three templates. Blank
   issues are disabled. Format, labels, and the required estimate:
   [`docs/development/issue-tracking.md`](docs/development/issue-tracking.md).

2. **One issue, one worktree, one branch.** Work happens in
   `~/projects/evalens-worktrees/<issue-number>-<slug>`, on a branch of the
   same name. The main checkout at `~/projects/evalens` stays on master and
   stays clean. SOP:
   [`docs/development/worktrees.md`](docs/development/worktrees.md).

3. **No commit without an issue.** `fixes #NNN` to close it, `refs #NNN`
   otherwise, in the message body. `bin/hooks/commit-msg` refuses the commit
   locally; the `commit-issues` CI job refuses it on the branch. Message
   shape: one concise summary line, one empty line, a required body, every
   line wrapped at 80 columns or less.

Install the hooks once per clone:

```bash
bin/install-hooks.sh
```

Bypass once, deliberately, with `git commit --no-verify` — but never by
inventing an issue number. An unlinked commit is recoverable; a commit
pointing at the wrong issue is worse.

## The rules this project has settled

[`docs/development/design-rules.md`](docs/development/design-rules.md) holds
eleven principles arrived at the hard way — an annotation must never assert
more than we know, annotating must never execute user code, nothing is
configured before a value appears, and so on. Each records the defect that
produced it. **Read it before designing anything**; a feature that conflicts
with one is off-strategy even when it is convenient.

## Status

**The extension is built, tested and installable.** It is not published —
there is no marketplace listing — and nothing it paints has been signed off by
a human watching the editor do it.

```
src/                    the extension: 21 TypeScript modules, ~6,000 lines
kernel/                 kernel, resolver and loop recorders — ~3,500 lines,
                        stdlib only, no ZeroMQ, no runtime dependencies
src/test/, kernel/test_*.py   396 + 395 tests, both green on e76b68d
examples/tour.py        732 lines: the manual fixture and the demo script
media/gutter/           evaluated / stale / error markers, light and dark
IDEA.md                 what this is, what already does part of it, and what
                        would kill it
README.md               the user-facing doc — commands, keys, settings.
                        src/test/readme.test.ts checks it against the code
docs/ai/, docs/development/   AI operating docs, issue tracking, worktrees
prototype/form_at_cursor.py   history — the 48-line proof that
                        kernel/resolver.py superseded
bin/hooks/, bin/install-hooks.sh   the commit gate
.github/                templates + CI: extension on Node 20, kernel on
                        Python 3.9, 3.11 and 3.13
```

## The stack, as built

The earlier plan to scaffold with `yo code` was not followed. Raise a decision
ticket to change any of this:

- **Extension**: TypeScript, compiled by `tsc -p .`, tested with
  `node --test`. Four devDependencies, no runtime dependencies, no bundler.
- **Kernel**: a persistent Python subprocess holding a namespace dict,
  speaking newline-delimited JSON over **two** pipes — requests on fd 0/1;
  interrupts, prompts and everything user code prints on fd 3/4, because the
  one reader of fd 0 is busy while user code runs. Ops: `ping`, `reset`,
  `eval`, `eval_file`, `outline`. Jupyter's `IExportedKernelService` remains
  the documented escape hatch and is deliberately unused.
- **Form resolution**: stdlib `ast` in `kernel/resolver.py`, using
  `end_lineno` / `end_col_offset`. **Not a differentiator** — Smart Send
  ships the same thing; what the resolver decides *afterwards* is the part
  that matters, and [`IDEA.md`](IDEA.md) says why.
- **Rendering**: `createTextEditorDecorationType({ after: { contentText } })`
  plus `setDecorations` — the same mechanism Calva, Error Lens, and inlay
  hints use.

## Prior art is a first-class input

`BetterThanTomorrow/calva`, `src/providers/annotations.ts` (217 lines) is the
reference implementation for the rendering, and `src/render/` follows it:
non-breaking spaces because VS Code eats ordinary ones in `contentText`;
`DecorationRangeBehavior.ClosedOpen` so decorations don't smear as you type;
`ThemeColor` rather than hardcoded colours; separate layers for result text
and evaluated region; a pending/success/error status driving region colour;
per-document state keyed by `document.uri`.

Read it before solving anything in that area from scratch. Calva is MIT
licensed and attribution for the rendering approach is intended and welcome.
Its author is reachable, which makes a design question cheaper than a
reverse-engineering session. `IDEA.md` records where Evalens departs and why.

## Conventions and gotchas

- **The design document is the spec.** When implementation diverges from
  `IDEA.md`, update `IDEA.md` in the same branch. A plan that says X while the
  code does Y is worse than no plan.
- **Evaluation is explicitly triggered, never continuous.** This is the single
  most consequential design commitment in the project — it is what makes side
  effects the user's decision instead of the extension's. Changing it needs a
  decision ticket, not a commit.
- **Anything that renders in the editor gets looked at.** A passing decoration
  test proves a range, not that a human sees the value.
- **The demo GIF is product, not documentation.** `IDEA.md` argues it outsells
  the name; treat work on it as feature work, labelled `pkg`.

## Commands

Every one of these was run in a worktree on `e76b68d` before being written
here:

```bash
bin/install-hooks.sh     # wire the commit gate (once per clone)
npm ci                   # once per worktree — a fresh checkout has no
                         # node_modules and no build output
npm run compile          # tsc -p .
npm run watch            # the same, watching
npm test                 # 396 tests; pretest compiles first
npm run test:kernel      # 395 tests, python3 -m unittest
npm run package          # python-inline-values-<version>.vsix, 35 files
gh issue list            # the tracker
python3 prototype/form_at_cursor.py FILE LINE…   # the superseded AST proof
```

Both suites pass before anything merges, and a clean rebase is not evidence
that both sides survived — design rule 10.
