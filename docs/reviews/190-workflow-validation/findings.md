# Shared workflow review

## Status and scope

The early integrated walkthrough passed tasks 1–5 and 8–9 against master
`173ef23` on 2026-09-08. Tasks 6–7 remain pending the final native inspection
and keyboard changes. This is not the final outcome for #190 yet.

This was a developer-led walkthrough operated by an agent. There were zero
human participants. It verifies behavior and the presence of explanations;
it does not establish first-time discoverability, comprehension, task speed,
long-term usefulness, or preference over the debugger. No participant data,
simulated personas, or recruitment were used.

The [task script](task-script.md) asks both intended experience levels the
same questions, using one interface with optional help. The executable
[walkthrough](walkthrough.cjs) used a private Extension Development Host and
its own disposable Python files. It did not execute the maintainer's teaching
files or change the ordinary VS Code profile.

## Early observations

| Task | Actually observed |
|---|---|
| Learning discovery | The empty state offered both Mac shortcuts and Try a guided example. Keyboard activation reached the existing exercise picker and an editable untitled Python document. |
| Guidance dismissal | The introduction remained hidden while the subsequent result evidence remained available. Reload persistence was verified separately for #184, not repeated in this pass. |
| Variables versus output | A row showed `v = 1, u = 99` beside output `4`; the named start/end timing and Recording details explained the difference. |
| Old result | After only `scale` was changed and reevaluated, `answer` retained its recorded `12` and named the later rebinding of `scale`. |
| Missing reading | `u` was assigned before `continue`, but the normal body-end capture was skipped. Keyboard-accessible Why explicitly did not claim the assignment failed to run. |
| Conditional carry-over | A single first-pass assignment produced saved end values of `u = 4` for all three iterations. |
| Saved pages | In a 25×25 loop, both outer and inner navigation reached iterations 21–25. Whole-result folding and reopening preserved the inner page. |
| Unsaved detail | In a 100×100 loop, the outer heading reported the first 20 saved iterations and disabled later paging. Remaining printed output started folded and identified its loop owner. |
| Session state | Clear removed recordings but allowed a second file to read `remembered = 7`. After restart, the same expression raised NameError. |
| Debugger boundary | Optional help named execution order, breakpoints, function calls, call stacks, and paused variables as debugger tasks. Reading that help did not launch debugging. |

The exact result strings are in [walkthrough.json](evidence/walkthrough.json).
Agent-inspected screenshots show [timing](evidence/timing.png),
[missing readings](evidence/missing.png), and
[large-loop limits](evidence/limits.png). The
[debugger guidance](evidence/debugger-guidance.png) is an additional captured
view, not evidence that a person selected the appropriate tool.

## Interpretation and remaining checks

The explanatory controls keep the default result compact, and the answer to
"why did output differ?" stays next to the loop. The missing-reading fixture
checks an important truth boundary: no reading does not mean no assignment.
These are concrete improvements in interpretability, but their effect on a
new learner has not been measured.

The 100×100 example still saves uneven amounts of detail across nested loop
invocations. The new heading and ownership text explains that limitation;
it does not make the saved sample representative or recover missing data.
This walkthrough found no new product defect in the completed tasks.

The full reset/input matrix is reused from the
[#188 real-pipe lifecycle evidence](../188-session-reset-guidance/lifecycle.json).
Only clear, cross-file state, and restart were operated in this Host pass.
The #179 enlarged gutter and #180 narrow-panel fixes have separate compiled
renderer and root Host evidence. Their benefits must survive final
integration; this early pass used Dark Modern at 14 px in a 1400×1000 window.

Final checks still needed here: native Find and exact copy beyond the preview,
recording context and return state, physical evaluate/stay and advance keys,
row/iteration focus, help Escape, and coexistence with Python debugging.
Screen-reader control names are inspectable; no screen-reader session or
Windows/Linux physical-key test has taken place in this walkthrough.

The early results provide no evidence of repeated costly manual comparison.
Do not infer demand for a pinning control or run archive from successful
agent navigation. The dedicated comparison decision remains #189.
