# Session and reset guidance verification

Date: 2026-09-08. Issue: #188 session-reset-guidance. The implementation was
rebased onto `f0040a9`, which contains the responsive panel and optional help.

## Scope

The optional **Session and reset actions** topic explains the existing
commands and their input replay effects. It reads `evalens.resetOnLoad` from
configuration, without starting Python or inspecting its namespace. A compact
notice when this setting is off remains visible after the introduction is
dismissed. It reports a configuration choice, not the existence of bindings.
The existing post-load status report still supplies detected leftover names.

No execution command, trigger, protocol, reset path or capture path changed.
Restart Kernel leaves earlier recordings visible, whereas Clear Inline
Results removes recordings across all files and keeps Python state. README
and IDEA now explain that distinction alongside the contextual help.

## Automated and real-pipe verification

The baseline was 944 extension tests and 718 kernel tests. After this change
and the rebase, **945 extension tests and 718 kernel tests passed**. The new
test covers configuration changes while the introduction is dismissed and
Session help is open. The existing help request probe now covers opening the
Session topic and refreshing its configuration without a Python request.

Logs: `/private/tmp/evalens-188-extension.log` and
`/private/tmp/evalens-188-kernel.log`.

A separate compiled-extension probe used the repository's fake VS Code API
with the real Python subprocess over its real request and input pipes. The
fixtures were created for this issue; no teaching files were executed.
The probe observed these outcomes:

| Action | Observed behavior |
|---|---|
| Evaluate two statements | The same session held `remembered = 42` and a typed `input()` answer |
| Clear Inline Results | Sent no Python request; removed recordings; a second file still read `42`; repeating the input statement reused its answer |
| Evaluate File with a selection, reset setting on | Sent `eval_file` without `reset`; the selected expression still read `42` |
| Read Session help and change its displayed setting | Sent no Python request or execution command |
| Evaluate whole files with reset setting off | Sent `eval_file` without `reset`; cross-file bindings and input replay survived; the existing status report named leftovers |
| Restart Kernel | Earlier recordings remained; evaluating `remembered` raised `NameError`; the prompting statement asked again |
| Clear Input Answers | Forgot replay and asked again on the next prompting evaluation; `remembered` still read `42` |
| Evaluate whole files with reset setting on | Sent `reset` before `eval_file`; old bindings disappeared and input asked again |
| Run File as Script with reset setting off and a selection | Sent `reset`, then `eval_file` with `as_script: true`; all three statements ran and input asked again |
| Evaluate Above Cursor | The `eval_above` response reported exactly the two statements above the cursor; input asked again; the cursor's statement did not run |

The repeated input probe prompted once before clearing results, then once
after each of restart, Clear Input Answers, a resetting file load, a script
run and an above-cursor run: six prompts total. Resetting behavior is also
covered by the unchanged existing execution and kernel regression tests.

Scratch probe: `/private/tmp/evalens-188-verify.cjs`. Captured request
sequences and observations: `lifecycle.json` beside this document.

## Appearance and keyboard verification

The compiled HTML and shipped script ran in headless Chromium at 900 px /
14 px dark, 300 px / 28 px dark, and 450 px / 14 px light. Pressing Enter on
**Session details** opened the help and its Session topic, focused the native
summary, and placed it 8 px below the sticky toolbar. There was no horizontal
document overflow or CSP/JavaScript error. The agent inspected the wide and
narrow screenshots; the long explanation flows with the document rather than
introducing a second scrolling box. These are renderer checks, not Host
checks. Scratch report: `/private/tmp/evalens-188-render.json`.

The root agent separately drove the actual Extension Development Host using
an isolated profile and its own fixture. It confirmed native keyboard focus
and normal document flow, setting-off notice and setting-on removal, updated
setting copy, introduction dismissal retained, and unchanged result content
while reading help. After Clear Inline Results, explicitly evaluating the
fixture's `remembered` expression still produced `42`. Root inspected
`/private/tmp/evalens-188-host.png`; its report is preserved as `host.json`.
The Host harness was
`/private/tmp/evalens-learning-live/verify-188-growth.cjs`.

## Limits

This is agent-operated developer verification, not a human usability study.
The complete reset/input matrix was verified through the compiled extension
and real pipes, not repeated through physical input dialogs in the Host.
Native debugger lifecycle was not exercised by this ticket, and no claim is
made about an attached external debugger sharing a process. The help's
debugger statement is specifically about a normal Python debugging session.
