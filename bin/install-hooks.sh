#!/usr/bin/env bash
# Symlink the tracked hooks in bin/hooks/ into the shared hooks directory so
# they actually run. Idempotent; safe to re-run from any worktree. Once per
# clone is enough: linked worktrees share the repository's hooks, and the
# links always point at the main worktree's copy, so removing a worktree
# never leaves them dangling.
#
#   bin/install-hooks.sh
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
common="$(git rev-parse --git-common-dir)"
case "$common" in /*) ;; *) common="$root/$common" ;; esac
# The hooks directory is shared by every worktree of this repository, so
# the symlinks must point at files that outlive any one worktree. #114: run
# from a linked worktree, this used to install links into the shared hooks
# directory that pointed at that worktree's own copy of bin/hooks -- and
# when the worktree was removed after its branch merged, both hooks
# dangled silently. Always resolve against the main worktree, whichever
# worktree this is run from.
main="$(git worktree list --porcelain | sed -n '1s/^worktree //p')"
src="$main/bin/hooks"
dst="$common/hooks"

# git consults core.hooksPath INSTEAD of .git/hooks when it is set, so
# installing into .git/hooks while that points elsewhere installs nothing and
# reports success. Refuse rather than lie: a gate everyone believes is wired
# and that has never run once is worse than no gate.
configured="$(git config --get core.hooksPath || true)"
if [[ -n "$configured" ]]; then
  echo "refusing: core.hooksPath is set to" >&2
  echo "    $configured" >&2
  echo "so git ignores $dst and nothing installed here would ever run." >&2
  echo >&2
  echo "If that path is stale, clear it and re-run:" >&2
  echo "    git config --local --unset core.hooksPath" >&2
  echo >&2
  echo "If it is deliberate, install the hooks there instead." >&2
  exit 1
fi

[[ -d "$src" ]] || { echo "no $src" >&2; exit 1; }
mkdir -p "$dst"

for hook in "$src"/*; do
  name="$(basename "$hook")"
  chmod +x "$hook"
  ln -sf "$hook" "$dst/$name"
  echo "installed $name -> $hook"
done
echo "done. (bypass once with: git commit --no-verify)"
