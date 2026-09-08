# Shared workflow review

## Outcome

The developer walkthrough is complete. The same interface supports all nine
scripted tasks with optional guidance available or dismissed. This supports
shipping the clarity, inspection, and keyboard changes; it does not establish
that the interface is optimally usable for a beginner or proficient developer.
No new blocking product defect was found in the final review.

There were **zero human participants**. Agents operated real VS Code Hosts,
read the resulting text, and inspected screenshots. No personas, participant
quotations, proficiency scores, or recruitment were used. Discoverability,
comprehension, task speed, long-term usefulness, and preference over other
tools remain unmeasured. The [shared task script](task-script.md) is ready for
a later arranged review without creating separate beginner/expert interfaces.

## Evidence obtained

The early integrated pass used master `173ef23` on 2026-09-08. The final
native inspection used the #186 implementation merged as `e11b5c8`. Final
keyboard and debugger checks used `bab04e9`, whose production changes merged
as `189863a`. The comparison decision is documentation only. Installation of
the final packaged artifact remains the coordinating session's release check.

All execution used disposable fixtures in an isolated development Host and
profile. The maintainer's teaching files and ordinary VS Code settings were
not changed. The evidence distinguishes our direct walkthrough from checks
performed by the coordinating agent; neither is human usability research.

| Task | What was actually verified |
|---|---|
| 1. Learning and optional help | Empty-state shortcuts and the guided-example action were present. Keyboard activation reached the existing exercise picker and an editable untitled Python document. Introduction dismissal persisted during subsequent tasks. |
| 2. Timing and output | `v = 1, u = 99` appeared beside output `4`. Named start/end timing and local Recording details explained the difference with the introduction dismissed. |
| 3. Old result | Reevaluating only the changed `scale` assignment left `answer: 12` visible with the later rebinding of `scale` identified. |
| 4. Missing reading | An assignment before `continue` produced a missing end reading. Keyboard-accessible Why explicitly avoided claiming the assignment did not run. Conditional carry-over showed `u = 4` for all three passes. |
| 5. Pages versus unsaved detail | Both levels of a 25×25 loop reached iterations 21–25. A 100×100 loop reported the first 20 saved outer iterations, disabled unavailable paging, and kept remaining output folded under its named owner. |
| 6. Native inspection | The coordinating agent opened all 150 Unicode/tabbed output lines read-only, found line 120 with native Find, copied the exact text, and restored all original clipboard formats. It also checked multiline repr, the whole 10,000-line nested stream, immutable earlier exports, and native preview-tab return. |
| 7. Keyboard workflow | Physical Cmd+Enter stayed; Shift+Cmd+Enter advanced. Unlinked browsing kept the actual cursor marker separate, help Escape kept results, Tab reached native output, and source return worked. Final physical loop controls and focus were checked below. |
| 8. Session actions | Clear kept `remembered = 7` available in another file; restart made the same expression raise NameError. Session help explained retained results separately from the new namespace. |
| 9. Debugger boundary | Help named execution-order, intermediate-state, breakpoint, and call-stack questions as debugger work. The coordinating agent also ran an actual debugpy session and verified F9, F5, F11, and F10 without Evalens taking those keys. |

The direct early [Host report](evidence/walkthrough.json) records exact
strings and scope. Agent-inspected screenshots show
[timing](evidence/timing.png), [missing readings](evidence/missing.png), and
[large-loop limits](evidence/limits.png). The early report's pending tasks
6–7 are completed by the final evidence below, not silently relabelled as
part of that earlier execution.

### Native text and keyboard evidence

The coordinating agent supplied the concise
[native inspection report](evidence/native-inspection-root.json),
[preview source report](evidence/native-preview-root.json), and
[keyboard workflow report](evidence/keyboard-root.json). The
[native Find screenshot](evidence/native-inspection.png) shows the opened
recording. Clipboard content was not logged; the report records equality
with the agent's own known fixture after Copy.

Our final [physical loop check](final-loop-keys.cjs) ran against the integrated
production implementation with both Microsoft Python and debugpy active.
Enter advanced the outer and inner loops to their final saved pages. Each
disabled More iterations button returned focus to that loop's enabled
Previous iterations button. Tab skipped the disabled control. Whole-result
folding and reopening preserved the inner page.

At 28 px, returning to the inner loop's 20-row page focused its enabled More
iterations control fully inside the viewport, below the pinned inner-loop
context. The [geometry report](evidence/final-loop-keyboard.json) records the
actual bounds; the [screenshot](evidence/final-loop-keyboard.png) was inspected.
The test restored the isolated profile's 14 px font afterward.

The coordinating agent's [debugger report](evidence/debugger-root.json)
records a breakpoint set with physical F9, F5 continuing to the call,
F11 entering `double` with two stack frames, F10 moving within the function,
and F5 completing execution. The
[debugger screenshot](evidence/debugger-coexistence.png) supports that check.
This verifies coexistence and the alternative workflow; it does not show a
participant independently choosing the appropriate tool.

### Reused evidence and limits

The full reset/input matrix comes from the
[#188 real-pipe lifecycle report](../188-session-reset-guidance/lifecycle.json).
Only clear, cross-file state, and restart were repeated in our Host pass.
That matrix used the compiled extension and real Python pipes, rather than
physical input dialogs for every lifecycle operation.

Reload persistence, no Python requests from help/exercises, and the
platform-correct shortcut wording have #184 implementation and root Host
checks. This pass does not claim to have restarted the Host again. The
#179 enlarged gutter and #180 narrow-panel fixes have separate renderer
and root Host evidence. Dark/light/high-contrast result evidence was checked
by the coordinating session for #185; our final focus check used Dark Modern.

No human screen-reader session or Windows/Linux physical-key session took
place. Accessible names and focus behavior were inspected by agents. Native
text models can normalize line endings, and Find only reaches captured text;
none of these checks establishes byte-preserving file export or recovery of
unrecorded values. No inspection reconstructed intermediate assignment state.

No production code or unit tests changed for #190. The coordinating session
reported 962 extension and 718 kernel tests passing for the integrated runtime;
this documentation branch adds zero tests and does not rerun those suites.
The actual Host walkthroughs are additional evidence, not replacements for
the release suite checks after merging.

## Friction and next priorities

1. **Keep the precise result evidence.** Missing end readings, carried-over
   values, and uneven saved detail still require interpretation. The new
   timing and ownership text makes that explanation available where needed.
   It cannot make an incomplete recording representative or recover data.
   Do not remove these facts when introductory prose is dismissed.
2. **Resolve the separately tracked inline count wording next.**
   [#174](https://github.com/mbjarland/evalens/issues/174)
   remains a decision about aggregate inner-loop counts beside source. The
   Values panel improvements do not settle that separate compact display.
   No additional blocking finding was discovered by this walkthrough.
3. **Use the existing script for the next arranged participant review.**
   Look especially for confusion between printed and end values, unavailable
   and folded detail, and clear versus restart. Record actual routes and
   explanations. Do not turn agent success into a claim that learners need
   no assistance or that experienced users prefer this tool.
4. **Defer dedicated comparison.** The
   [#189 decision](../../development/recorded-comparison.md) demonstrates the
   native **File: Compare Active File With...** route. The clipboard comparison
   command did not support these read-only documents in the reviewed build.
   This limitation is documented rather than hidden by another feature.
   No observed repeated comparison cost justifies pinning or a run archive.

The debugger remains the better tool when the question requires following
assignment order, entering a function, seeing a call stack, or inspecting a
paused frame. Evalens advances an editing cursor after deliberate evaluation;
it does not supply that execution position. The completed work preserves
this distinction while making recorded answers easier to use.
