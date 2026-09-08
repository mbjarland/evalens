# Keyboard navigation for recorded results

Issue: #187. This change follows #183–186 and #188. It changes UI navigation
only; evaluation commands, kernel requests and debugger bindings are unchanged.

## Contract

- **Evalens: Show Values Panel** uses the existing contributed view focus
  command. Entering the webview focuses its remembered control or current row.
- Result rows use Up/Down/Home/End. Enter/Space reveals source and keeps panel
  focus. With linking disabled, arrow browsing changes focus only; the source
  cursor marker and Latest result still report their separate facts.
- The source marker is a rightward arrow, distinct from disclosure triangles.
  The existing square amber editor gutter and neutral wash are unchanged.
- Flat labels, Show all/less and recorded-text actions are native buttons.
  Their key events cannot activate the containing source row. Printed labels
  keep their existing blue ink; variable labels retain their own theme color.
- Focus is remembered by source URI, capture identity and control purpose.
  Flat expansion keeps its control, a disabled final-page Next yields to
  Previous, and a replaced or folded result yields to a surviving control in
  the same row. Different files cannot inherit a control through a shared
  basename. Passive updates do not restore focus after the reader leaves.
- Native Tab focus is revealed below the sticky loop context. Local recording
  explanations retain their open state across same-capture rebuilds.
- Escape closes the focused open explanation, then Help if pressed again.
  From another result control it returns to that row. It does not run Clear
  Inline Results. Editor Escape and F5/F9/F10/F11 remain unchanged.
- Native **Focus Active Editor Group** returns to editing. When a recording
  tab is active, revealing a panel row first shows its original Python source
  without taking panel focus (#186). No new Evalens command is needed.

## Checks completed by the implementing agent

The integrated extension suite passes **961 tests**: #186's corrected base
passes 959, and #187 adds two behavior regressions. They exercise unlinked
browsing versus source/Latest state, and nested-control/modifier isolation
including debugger keys and Escape. Existing fold assertions now require
native buttons. The kernel suite passes **718 tests**.

`verify-renderer.cjs` creates one authored Python fixture, evaluates it once
through the real kernel pipe, closes the client, and exercises the compiled
HTML with physical Chromium keyboard events. It checks ten cases:

1. Native flat Open sends the current revision and preserves label color.
2. Show all/Show less preserve the focused control across a DOM rebuild.
3. Escape closes Session details, then Help, with no source navigation.
4. The disabled last-page Next control falls back to Previous.
5. Expanding an outer iteration keeps its disclosure focused.
6. Why opens/closes natively and keeps its summary focused.
7. A focused inner iteration remains below the sticky loop context.
8. Whole-result folding preserves the inner page and one mounted control.
9. Capture replacement falls back to the surviving result control.
10. A different URI with the same basename does not inherit focus.

All ten checks pass with no browser errors. The implementing agent also
viewed the renderer screenshot; it is a Chromium rendering with fallback
colors, not an Extension Development Host screenshot. The harness runs no
Python while browsing. The captured fixture uses only an authored nested
loop, arithmetic, `continue` and `print`.

Run after compiling:

```sh
node docs/reviews/187-keyboard-recorded-workflow/verify-renderer.cjs
```

It uses the local Google Chrome executable, or `EVALENS_CHROME_PATH`, and
writes its report and screenshot to `/private/tmp/evalens-187-renderer.*`.
Suite logs: `/private/tmp/evalens-187-extension.log` and
`/private/tmp/evalens-187-kernel.log`.

## Actual Host review still required

The root session owns the isolated Host. It must check physical Cmd+Enter
and Shift+Cmd+Enter, entering/leaving the webview and native recording editor,
Find/copy and source return, both following settings, checkbox-triggered and
same-result rebuilds, file switches, and Python/debugpy coexistence. Native
control names have been inspected in markup; no screen-reader user study was
conducted. A Chromium fixture is not evidence for VS Code focus routing.
