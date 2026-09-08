# Recorded-result language verification

Implementation: `115b0ed` (2026-09-08), based on master `cffbf52`.

The root agent operated the actual VS Code Extension Development Host with
this worktree as its active extension path and inspected the screenshot.
The isolated fixture, `growth-timing.py`, evaluates three loop iterations:
`u` is printed after `u = 4 * v`, then overwritten with `99` before body end.

The [Host results](host.json) and [screenshot](host.png) show:

- One loop statement counts as **1 recorded result**, despite its several
  variables and iterations.
- **Variables** and **Printed output** remain separate. The existing timing
  note explains why recorded `u = 99` appears beside output `4`, `8`, `12`.
- The snapshot reads **Final values after this loop** and the export action
  reads **Open printed output**.
- All three checkbox labels remain visible. Clicking **Scroll to new
  results** off, then changing its existing setting on, round-trips.
- Square amber bars, the neutral loop background, **Latest result** and
  source markers remain visually intact.

The extension suite passes **937 tests**, up from the measured **936** on
master. The kernel suite passes **718 tests**, unchanged. Existing renderer,
manifest, documentation and action-routing checks pass. The added summary
coverage distinguishes pending evaluation from completed results and counts
statements independently of variable or printed-line counts.

The evidence above is an operated Host check and agent visual inspection,
not a first-time learner study or a screen-reader matrix. Separate existing
issues #179 and #180 cover large-font and narrow-panel layout verification.
This screenshot does not establish those layout cases or a complete visual
matrix of scalar, stale, error, output-only and custom-label rows.
