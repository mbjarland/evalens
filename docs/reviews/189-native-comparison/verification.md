# Native comparison decision evidence

The root session drove an isolated Extension Development Host using the
native recording implementation at `e28143b`. These are developer checks;
there were no human participants or measured usability outcomes.

The [decision](../../development/recorded-comparison.md) defers a dedicated
comparison feature. Its literal-input transformation produced these exact
recordings, each opened through **Open statement printed output**:

```text
Earlier: "ada\n\nlin\n"
Later:   "ada\nlin\n"
```

Both numbered recording tabs remained open. The real Command Palette
offered **File: Compare Active File With...**, its picker listed both tabs,
and selecting the other opened one native diff editor. The screenshot was
inspected by the root session and the decision agent. It shows the later
recording on the left and the earlier recording on the right, so the blank
line appears as an addition. The recommended workflow starts from the
earlier recording and selects the later one to show the forward change.

- [Host report](host.json)
- [Actual native diff](native-diff.png)

The first attempted route, **Compare Active File with Clipboard**, silently
did nothing. Reading the installed VS Code implementation showed that this
command requires an untitled document or a file-service provider. Evalens's
read-only content-provider scheme does not meet that condition. The native
direct comparison command uses the text-model provider and works without
saving files, copying text, or adding an Evalens file-system provider.

The initial `verify-189-growth.cjs` probe therefore failed at its clipboard
comparison step after confirming both exported payloads. The successful
`check-native-diff.cjs` probe separately drove the Command Palette and picker
and checked the visible native diff. Do not report the initial probe as a
fully passing test. The root session restored all clipboard formats in the
initial probe's cleanup.

The decision's accumulator example was also checked through a fresh real
kernel subprocess: the same iteration entries associate targets `2`, `3`,
`4` with captured `total` readings `2`, `5`, `9` and printed output `2\n`,
`5\n`, `9\n`. No independent history arrays were joined to make the rows.

Source review covers export identity, source preview, limits, and lifetime;
this screenshot establishes native comparison visibility, not every export
lifecycle case or focus-return behavior. Those are covered by the separate
native inspection work. No production code or tests changed for this
decision, and full suites were not rerun on its documentation-only branch.
