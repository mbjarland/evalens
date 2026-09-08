# Optional learning guidance verification

Issue: #184. Baseline: `f24d5ac`, 937 extension tests and 718 kernel tests.
The implementation was rebased onto `44019ba` before final checks.

## Behavior

- The three stateful preferences remain visible alongside a small Help and
  learning button. Help content expands in normal document flow, outside the
  sticky toolbar; opening it explicitly reveals it below that toolbar.
- A compact introduction can be dismissed. The extension's global UI state
  remembers only that explicit choice across reloads. Help and its native
  topic disclosures retain their state across panel rebuilds in the same
  provider, but start closed after activation.
- Show introduction reverses dismissal. Neither action rebuilds the result
  DOM, so it cannot reset result folding or hide result evidence.
- The empty state offers the existing walkthrough and both platform-specific
  evaluation shortcuts. Help offers the existing five-exercise picker.
- The fixed action allowlist and the provider's revision/visibility guards
  prevent arbitrary command dispatch and stale or hidden-panel actions.
- Help distinguishes whole-statement evaluation from debugger stepping and
  links the official Python debugging guide. It creates no configuration,
  debugger session, or namespace transfer.

## Automated checks

`npm --cache /private/tmp/evalens-npm-cache test`: 944 passing extension tests
(7 added). Tests cover platform defaults against contributed keybindings,
intro persistence across provider recreation, explicit reopening, file and
annotation rebuilds, unchanged result evidence, preserved checkbox state,
allowlisting/revision/visibility guards, and the shipped browser action code.

The action test observes the real `KernelClient.request` path: explicit
initial evaluation proves the probe is active, then help, walkthrough, and an
editable untitled exercise issue zero further requests. Existing exercise
suite checks all five examples against the real Python subprocess.

`npm --cache /private/tmp/evalens-npm-cache run test:kernel`: 718 passing
kernel tests. No kernel source or evaluation trigger changed.

The CSP still disallows external resources. Its one fixed HTTPS anchor is
user-initiated navigation to the official guide, not a script or asset load.

## Visual verification

Actual Extension Development Host appearance, keyboard navigation, and
persistence after a real reload are assigned to the coordinating session.
The unit fixtures verify structure and state; they do not claim a human
screen-reader test or first-time learner validation.
