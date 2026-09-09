# Changelog

## 0.2.0 — 2026-09-09

First stable release, following the 0.0.1 pre-release.

- Evaluate Python at the cursor, advance to the next statement, or run a
  file explicitly. Recorded values stay beside the code; editing does not
  run it again.
- Browse results in the Values panel with linked source navigation, a
  distinct latest-result marker, keyboard controls, and whole-result folds.
  Orange square bars and quiet source markers keep the code readable.
- Explore loops with one shared Variables and Printed output heading. Nested
  loops retain their hierarchy; simple loops use compact rows. Optional
  **About these values** explains capture timing; missing readings and final
  values stay explicit. Iterations and long output page or fold at every level.
- Read consistent values-first histories beside each loop's own header,
  including inner loops, body variables, watches, and comprehensions.
- Discover five editable learning exercises through the optional walkthrough
  and panel help, illustrated with actual VS Code renderings. Key references
  show macOS first, with Windows/Linux equivalents alongside.
- Understand the difference between clearing results, restarting Python,
  and evaluating a file. Open recorded values or output in read-only editor
  tabs for native Find, selection, and copy without reevaluating code.
- Refresh the Marketplace introduction with readable native VS Code images
  of inline results, the Values panel, nested loops, and learning. Move the
  complete command, shortcut, and settings reference into the linked user guide.
- Fix Evaluate at Cursor keybinding conflicts, cursor-follow scrolling,
  output-only blank rows, folded-loop output leakage, redundant inner-loop
  expanders, and missing body-variable readings.

Loop detail and text captures remain bounded and identify missing recordings.
Recorded results show past evaluations; use Python's debugger when you need
to pause execution, inspect intermediate state, or follow a call stack.

## 0.0.1

Initial Marketplace pre-release.
