# Issue tracking — house rules

> Status: Current
> Audience: AI agents and the maintainer
> Source of truth for: how work is filed, sized, and closed
> Last verified: 2026-09-05

Tickets live in **GitHub Issues** on `mbjarland/evalens`. There is no second
tracker and no private list — an issue is the only place planned work is
recorded, and the only thing a commit is allowed to point at.

The shape below is lifted from the Azuros platform repo, where it was arrived
at over several hundred tickets. What is dropped is noted as dropped, with the
reason, so nobody re-adds it by cargo cult.

## Creating a ticket

- Use one of the three templates: **work item** (build/fix), **decision/spike**
  (the deliverable is a written call, not code), **finding** (a defect
  discovered by reading or using the code). Each enforces a TL;DR,
  consequences-first writing, and an estimate. Blank issues are disabled.
- **Title**: `area: description` for work items and findings
  (`kernel: …`, `render: …`); `Decision/spike: …` for decisions.
- **Prose must stand alone.** Issue numbers appear as trailing side notes,
  never as load-bearing references — a reader with no context follows the
  text. "See #12" in place of an explanation is how a ticket becomes
  unreadable the week after it is filed.
- **One ticket, one closable claim.** If the TL;DR takes more than two
  sentences, it is two tickets. Umbrella work gets an `epic` label and links
  to its children.
- **A finding gets filed even when you are about to fix it.** Git records the
  fix; only the ticket records that it was wrong, how it was caught, and what
  now stops it coming back.

## Estimation — required on every ticket

Every ticket carries an **Estimate** when it enters the board — no
exceptions, including retrospective tickets (estimate what the work took).
Put the number in the template's `## Estimate` section, and in the project
board's Estimate field once a board exists. Scale is `1 / 2 / 3 / 5 / 8 / 13`:

| Points | Meaning |
|---|---|
| 1 | Trivial: a keyword tweak, one-line fix, rename, tiny doc touch |
| 2 | Small bounded change: one module plus its test, a short doc |
| 3 | Standard work item: a slice or fix across a few files with tests |
| 5 | Multi-part: several distinct pieces, cross-layer, a major doc |
| 8 | Large: a new subsystem plus its surface and tests |
| 13 | Epic/umbrella scale — spans subsystems; all epic rows are 13 |

Sizing examples for this project, so the scale has anchors: a marketplace
`keywords` edit is a 1; a truncation limit for rendered values with its test
is a 2; the decoration lifecycle (clear on edit, `ClosedOpen` range
behaviour, dismiss on Escape) is a 3; the subprocess kernel with a persistent
namespace, a wire protocol and restart is a 5; "run everything above this
line" end to end — kernel, resolver, rendering, tests — is an 8; the first
prototype as a whole is the 13.

When torn between two values, pick the larger. Decision/spikes size the
*investigation*, usually 2–3.

## Board conventions

- **Status columns** carry contracts: Todo / In Progress / Blocked / Done.
  `Blocked` requires the reason in a comment; `Done` requires evidence — a
  commit, a doc, or a recorded decision.
- **Mirror labels** `status:blocked` / `status:in-progress` keep state visible
  in the plain issues list, which is where an agent looks. Keep them in sync
  when moving cards.
- **No sprint field.** Azuros replicates Jira iterations; this project is one
  person and an agent, and an iteration field with no cadence behind it is a
  field that lies. Revisit if the work ever runs to a schedule.

## Commits

- **Every commit names an issue, and this is enforced.** Use `fixes #NNN` when
  the commit closes it, `refs #NNN` when it does not. Two gates:
  `bin/hooks/commit-msg` refuses the commit locally (install with
  `bin/install-hooks.sh`, once per clone), and the `commit-issues` job in CI
  checks every commit a branch adds, for the machine that never ran the
  installer. Merges, reverts and fixups are exempt.
- **Bypass once, deliberately**, with `git commit --no-verify` — but never by
  inventing a number: an unlinked commit is recoverable, a commit pointing at
  the wrong issue is worse.
- **`fixes #NNN` is what closes the ticket**; a commit that cites the number
  only in prose (`(#12)`) does not. Close those by hand or the board drifts.
- **Message shape**: one concise summary line, one empty line, then a required
  body. Every line hard-wrapped at 80 columns or less, summary included. The
  hook enforces the width as well as the reference.

Why a gate and not a convention: Azuros ran exactly this rule, written down
and unenforced, until 89 commits reached master in three days without a single
reference and forty register entries were left describing merged work as still
in progress. A rule that depends on everyone remembering it holds until the
work is delegated at volume, and then stops. If you are directing agents, put
the issue reference in the instruction — they write the message shape they are
given and will not infer this.

## Labels

**Areas** — `kernel` (the Python evaluation subprocess and its protocol) ·
`ast` (form-at-cursor resolution) · `render` (decorations and the inline
overlay) · `ext` (VS Code plumbing: activation, commands, settings,
lifecycle) · `pkg` (packaging, marketplace listing, README, the demo GIF) ·
`docs` · `ci`.

**Risk** — `executes-user-code`: the change touches the path that runs code
from the user's buffer, or decides *when* it runs. Handle with corresponding
care; see the posture section of [`../ai/co-working.md`](../ai/co-working.md).

**Severity** (findings) — `sev:critical` · `sev:high` · `sev:medium` ·
`sev:low` · `sev:nit`. Severity is re-assessable, which is why it is a label
rather than part of the title.

**Process** — `bug`, `blocked-on-decision`, `status:blocked`,
`status:in-progress`, `epic`.

## Deliberately not adopted (yet)

- **Markdown issue registers as the source of truth.** Azuros keeps
  `chain-issue-register.md` / `security-issue-register.md` as CI-audited
  canonical records, with GitHub issues as scheduling mirrors. That earns its
  keep when findings must survive a tracker migration and be read by an
  auditor. Here it would be a second place to update. Adopt it if this project
  ever grows a security surface worth auditing — the kernel executing
  arbitrary user code is the candidate.
- **A sprint/iteration field**, per above.
