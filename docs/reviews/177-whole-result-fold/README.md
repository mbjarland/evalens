# Whole-value disclosure review

Issue #177 implements the maintainer's R2 selection from #176. Long values
should not dominate file browsing, and putting a result aside must not discard
the iteration or output detail the reader was investigating.

The single disclosure sits just after the result bar, beside its first
heading. Its native button handles mouse, Enter and Space without navigating
or evaluating source. A local DOM toggle hides the existing bounded detail;
it does not rebuild it. The provider separately persists the reader's choice.

## State and measurement

The source-content wrapper includes all currently shown source lines, the
existing source truncation notice, and Latest result when present. An
event-driven ResizeObserver measures that wrapper and the existing detail at
its available width. Folded results use the source's exact height, with no
vertical result padding added. One-line value padding alone does not earn a
disclosure. Font-relative spacing keeps the arrow clear of the heading.

Result identities carry the whole fold and generic Show all state through
source reanchors, stale marking, and file/view switches. Replacement captures
have new inner IDs and reset their pages. An unchanged complete statement at
the same reanchored extent inherits only its deliberate whole-value collapsed
choice. Indexed lookup uses captured identity and extent; source digests are
computed only for a new capture and keep preference metadata bounded.

Evaluation first replaces a compound result with a cursor-line pending mark.
That mark is then withdrawn immediately before the completed result is
settled. A narrow pendingWithdrawn event preserves the preference for that
synchronous transition only; a microtask prunes an abandoned pending result.
Clear/edit events do not defer pruning. Clearing, displacing or closing a
document releases its choices. Editor following never opens a chosen fold.

The closed summary keeps the root loop heading and useful counts, with stale,
error and capture-limit cues ahead of descriptive text. Generic streams have
already had print's terminal newline removed, so remaining blank lines count
as output; explorer streams retain their original terminator. Truncated
streams are described as captured output rather than assigned a false total.

## Verification

The branch starts at #175 commit `eda17c9`: 907 extension and 708 kernel tests.
Eleven new tests cover capture identity, safe and unsafe replacements, pending
completion and explicit clear, source reanchors, view recreation, nested
pages, generic Show all, message guards and exact printed-line counts.
Final branch verification passes 918 extension tests and 708 kernel tests.

The root session independently drove the actual VS Code Host on ports
9354/9355 against this worktree; scripts and measurements are saved here.
`verify-host.cjs` requires the existing isolated Host's `client.cjs`, creates
its own `r2-root.py` and `r2-print.py` fixtures, and executes only those files.
`verify-themes.cjs` uses the same fixture and changes only the isolated Host's
settings, restoring dark mode and the editor font size afterward.

Observed in the real Host:

- A 25×25 nested result folds to its three source lines: 42 pixels. The next
  source row moves up and the source excerpt stays fully visible.
- An opened inner group, changed iteration page and selected iteration keep
  exactly the same inner DOM after collapse/reopen.
- Physical Enter and Space operate the disclosure, preserve its focus and
  do not move the editor cursor. Mouse activation does the same.
- Source following and hiding/reopening the Values panel keep the chosen fold.
- A one-line print result folds to 14 pixels. The 81 printed-line summary
  includes its intentional trailing blank line; a scalar has no visible fold.
- Dark Modern, Light Modern, High Contrast and High Contrast Light at editor
  font size 28 preserve source-height equality, arrow/text separation,
  transparent loop surfaces and square theme-coloured bars.

The worker separately inspected the actual 100×100 fixture on ports
9414/9415: its folded result also measured exactly 42 pixels and its following
scalar had no visible disclosure. The included screenshots were inspected;
they are actual Host captures, not design mockups. The parent session handles
merged/installed-artifact verification after this branch is committed.

The existing fixed line-number column can overlap source at large editor
fonts; the parent filed that separately as #179. It is outside this change.
