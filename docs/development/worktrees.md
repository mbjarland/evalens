# Worktrees — one issue, one worktree, one branch

> Status: Current
> Audience: AI agents and the maintainer
> Source of truth for: where work happens on disk
> Last verified: 2026-09-05

Work on an issue happens in its own git worktree, checked out beside the
repository rather than inside it:

```
~/projects/evalens                          the main checkout — always master
~/projects/evalens-worktrees/12-kernel-protocol
~/projects/evalens-worktrees/14-decoration-lifecycle
~/projects/evalens-worktrees/17-form-at-cursor-multiline
```

**The directory name, the branch name, and the issue are the same string:**
`<issue-number>-<slug>`. Given only a path you know which ticket it belongs
to, and given only a branch name you know which directory to look in. That is
the entire point of the convention, and it is why the slug is not allowed to
drift from the issue title.

The issue id is the plain GitHub number. There is no project key — GitHub
Issues is the only tracker, so a second identifier would only be a thing to
keep in sync.

## Why worktrees rather than branch-switching

- **Parallel sessions do not collide.** Two agent sessions, or an agent and a
  human, can work two issues at once without one of them stashing.
- **A half-finished experiment never blocks a quick fix.** The main checkout
  stays on master and stays clean, so it is always ready to review, merge, or
  cut a build from.
- **Review is a `cd`, not a checkout.** You can read the branch and master
  side by side, in two editor windows, without git touching either.
- **They live outside the repository**, so a worktree never shows up in `git
  status`, never gets swept into a package, and never matches a glob meant for
  source files. This is why the path is `~/projects/evalens-worktrees/` and
  not `.worktrees/` inside the repo.

## Creating one

```bash
issue=12
slug=kernel-protocol

# Creates the branch on the remote AND links it to the issue, so the issue
# page shows the branch and later the PR.
gh issue develop "$issue" --name "$issue-$slug"

git -C ~/projects/evalens fetch origin
git -C ~/projects/evalens worktree add \
    ~/projects/evalens-worktrees/"$issue-$slug" "$issue-$slug"
```

Without `gh`, or for a branch that should not exist on the remote yet:

```bash
git -C ~/projects/evalens worktree add -b "$issue-$slug" \
    ~/projects/evalens-worktrees/"$issue-$slug" master
```

Then, in the new worktree:

```bash
cd ~/projects/evalens-worktrees/"$issue-$slug"
npm ci                    # once package.json exists — see the gotcha below
```

The hooks come along automatically: a linked worktree shares the repository's
hook directory, so `bin/install-hooks.sh` run once in the main checkout covers
every worktree. Run it again only after a fresh `git clone`.

## Working in one

- Commit as usual; every commit names the issue (`fixes #12` / `refs #12`) —
  see [`issue-tracking.md`](issue-tracking.md). The `commit-msg` hook refuses
  the ones that do not.
- Push the branch and open the PR from the worktree. `gh pr create` picks up
  the linked issue.
- **Do not commit on master in the main checkout.** Master is somewhere you
  merge into and read from, not somewhere you type.

### Chained branches

When a second issue touches the same files as one still in flight, branch it
off the first rather than off master, and say so in the ticket:

```bash
git -C ~/projects/evalens worktree add -b 14-decoration-lifecycle \
    ~/projects/evalens-worktrees/14-decoration-lifecycle 12-kernel-protocol
```

The reason is a real trap, hit on the Azuros repo: two branches that edited
the same view heavily merged with **no conflict**, and git silently kept one
side's version of a hunk. A clean merge is not evidence that both sides
survived. Chaining makes the second branch see the first's work while writing
it, which is the only reliable time to notice.

## Tearing one down

```bash
wt=~/projects/evalens-worktrees/12-kernel-protocol

git -C "$wt" status --short          # look first: anything uncommitted?
git -C ~/projects/evalens worktree remove "$wt"
git -C ~/projects/evalens branch -d 12-kernel-protocol   # -d, never -D
```

- **Never `rm -rf` a worktree directory.** That leaves git's administrative
  record behind, and the branch still looks checked out until someone runs
  `git worktree prune`. If it has already happened, that is the fix.
- **`git worktree remove` refuses a dirty worktree**, which is the behaviour
  you want. Do not reach for `--force` without reading `git status` in it
  first — an agent deleting a worktree with unpushed work is one of the few
  genuinely unrecoverable things in this workflow.
- **`branch -d` refuses an unmerged branch**, likewise on purpose.

`git worktree list` should stay short, and every entry should map to an open
issue. A stale worktree is not free: it is a full checkout on disk and a
branch that looks alive on the board.

## Gotchas

- **A worktree starts with no `node_modules` and no build output.** It is a
  fresh checkout of tracked files only. `npm ci` per worktree, and expect the
  first extension launch there to compile from scratch.
- **Untracked and ignored files do not come with you.** Local settings, a
  scratch `.env`, a captured GIF — if it is not committed, it exists in
  exactly one worktree.
- **Some work genuinely belongs in the main checkout.** Anything that depends
  on state living outside the tree — a long-running process, a manually
  installed Extension Development Host profile, captured recordings — costs
  more to reproduce per worktree than the isolation is worth. When that
  happens, say so in the ticket rather than half-using the convention.
- **The Extension Development Host opens the folder you launch it from.** Run
  it from the worktree, not the main checkout, or you will be testing master
  and wondering why the change is not there.
