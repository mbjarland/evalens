# Evalens — AI operating contract

Calva-style inline evaluation for Python in VS Code: put the cursor on a line,
hit a key, see the value painted inline next to the code. **What this is and
why it doesn't already exist is in [`IDEA.md`](IDEA.md)** — read it before
proposing anything about architecture, naming, or scope.

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

## Status

**Nothing is scaffolded yet.** The repo currently holds the design document
and one working proof:

```
IDEA.md                        the design: gap analysis, architecture,
                               prior art, marketplace positioning
prototype/form_at_cursor.py    48 lines of stdlib `ast` that resolve the form
                               under a cursor — the piece that looked hard and
                               isn't. Runs today.
docs/ai/                       AI operating docs
docs/development/              issue tracking + worktree SOP
bin/hooks/, bin/install-hooks.sh   the commit gate
.github/ISSUE_TEMPLATE/, .github/workflows/   templates + CI
```

Do not describe the extension in the present tense until it exists.

## Intended stack

From [`IDEA.md`](IDEA.md), not yet built — treat as the plan, and raise a
decision ticket to change any of it:

- **Extension**: TypeScript, scaffolded with `yo code`.
- **Runtime**: a ~30-line Python subprocess holding a persistent namespace
  dict, `exec()`-ing statements and returning `repr()` of a target over a
  pipe. Jupyter's `IExportedKernelService` is the documented escape hatch if
  rich display ever justifies the dependency — deliberately not the starting
  point.
- **Form resolution**: stdlib `ast`, using `end_lineno` / `end_col_offset`.
  Statements are `exec`-ed; the assignment *target* is what gets displayed.
- **Rendering**: `createTextEditorDecorationType({ after: { contentText } })`
  plus `setDecorations` — the same mechanism Calva, Error Lens, and inlay
  hints use.

## Prior art is a first-class input

`BetterThanTomorrow/calva`, `src/providers/annotations.ts` (217 lines) is the
reference implementation for the rendering, and reading it collapses several
questions that look open: non-breaking spaces because VS Code eats ordinary
ones in `contentText`; `DecorationRangeBehavior.ClosedOpen` so decorations
don't smear as you type; `ThemeColor` rather than hardcoded colours; two
decoration layers (result text and evaluated-region highlight); a
pending/success/error status driving region colour; overview-ruler marks;
per-document state keyed by `document.uri`.

Read it before solving any of those from scratch. Calva is MIT licensed and
attribution for the rendering approach is intended and welcome. Its author is
reachable, which makes a design question cheaper than a reverse-engineering
session.

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

Everything that exists today:

```bash
bin/install-hooks.sh                     # wire the commit gate (once per clone)
python3 prototype/form_at_cursor.py FILE LINE…   # the AST resolver proof
gh issue list                            # the tracker
```

Build, test, and packaging commands land with the extension scaffold. Do not
document them before they run.
