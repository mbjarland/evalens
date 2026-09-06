# Stale dependency provenance verification — #157

Verified on 2026-09-06 in a real macOS Extension Development Host by the
coordinating agent, using its own `stale.py` fixture. No existing user buffer
was evaluated. Editor operations were driven through the VS Code API; the
Values source-navigation button was clicked in the actual webview DOM.

The run evaluated `x = 1` and `y = x + 1`, then edited and evaluated `x = 5`.
Both hover and Values named `x` and line 1 as the first observed re-binding.
Clicking **Go to re-binding** selected the source at zero-based line 0.
Inserting a preceding comment moved the source reference to line 2. Deleting
the entire causative statement retained the old `y: 2` trace and named `x`
explanation, while withdrawing the navigation link.

The [Host screenshot](stale-cause.png) shows the stale result, named cause,
source link and selected source after navigation. Both the coordinating
agent and implementation agent inspected this capture. The screenshot
records the intact-source case; the shifted and removed-source cases were
checked during the live run but are not pictured here. The hover explanation
was checked in the live Host, but clicking its Markdown command link was
covered by the compiled-extension regression rather than by a physical click.
Physical keyboard operation, screen readers, Windows/Linux and learner
usability were not verified in this run.

Automated suites passed: **825 extension tests** (baseline 813) and
**674 kernel tests** (baseline 674). Added regressions exercise the real
kernel and compiled hover/panel paths, original-document navigation, cached
link rejection, first-cause retention, reevaluation, source withdrawal, and
half-open edit boundaries. These checks do not claim complete dependency
tracking: alias mutations and transitive dependencies remain outside scope.
