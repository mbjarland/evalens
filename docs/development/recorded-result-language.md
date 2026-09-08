# Recorded-result language

> Status: Current
> Audience: Product contributors and the maintainer
> Source of truth for: Values panel terminology
> Last verified: 2026-09-08

Use concise, professional terms in the main interface. Explain unfamiliar
terms where they arise without presenting recorded results as live state.

| Term | Meaning |
| --- | --- |
| Recorded result | One completed statement's recorded values, output or error. A nested loop is one result. Pending evaluations count separately as running. |
| Variables | Loop target at iteration start and selected body variables at normal body end. Name the recorded variables in the timing note beside each invocation heading. |
| Printed output | Ordinary output written to stdout. Keep it separate from variable readings. |
| stderr output | A separate stream often used for warnings or diagnostics. Its presence alone does not establish failure. |
| Final values after this loop | The bounded snapshot after the completed loop, separate from any selected iteration. |
| Link code and values | Reveal corresponding source/results during navigation without moving keyboard focus. |
| Scroll to new results | Bring newly recorded results into view independently of cursor navigation. |
| Latest result | The most recently completed result in this document, independent of the editor cursor. |
| Go to variable change | Reveal the recorded statement that rebound a name. Rebinding assigns a name again; the value may be unchanged. |

Use **Open printed output** and **Open stderr output** for the loop export
actions. Optional explanations and developer documentation may introduce
`stdout`, `stderr`, and rebinding. Do not rename protocol fields to match UI
copy. The `evalens.printedLabel` preference still controls inline/flat-row
stream labels; descriptive headings and actions keep their names.

The three preference checkboxes retain their setting keys, defaults and
behavior. Command titles may become clearer without changing command IDs or
keybindings. **Hide inline values while this panel is visible** retains its
existing label and behavior.

This vocabulary changes neither X5/Y2/R2 layout nor recording semantics.
Preserve square amber bars, the neutral loop surface, folding, and the
distinction between recorded detail and live debugger inspection. Recorded
result evidence names start/end timing and distinguishes folded text, saved
pages and unavailable recordings. Optional teaching help is separate; hiding
it must never hide stale, error or incomplete-recording facts.
