# Narrow Values panel results — #180

The old fixed-layout table gave source 300px plus its gutter before assigning
any space to values. At a 300px panel width, the result could receive no
visible width at all.

At 720px and below, each source excerpt now sits above its values. The source
keeps the font-relative gutter from #179. The values use the full row width;
source navigation, the current/latest indicators, and the whole-result
control remain in the same row and retain their existing behavior.

The loop explorer also responds to its own available width, measured in the
editor font. Below 28ch, each variable/output pair stacks with real text
labels. This keeps printed output and variables distinct without squeezing
both columns into unreadably narrow strips. Stderr keeps its own label.
Capture timing is outside the column headings and remains visible. Wide
views retain the column layout and existing square orange result bars.

## Verification

Baseline after integrating #179: 937 extension tests and 718 kernel tests.
After this change: 937 extension tests and 718 kernel tests pass. Existing
renderer assertions now distinguish the column heading from the additional
narrow-layout labels. No evaluation or capture code changed.

`verify-renderer.cjs` evaluates its own fixture through the real Python
kernel, translates the responses into panel annotations, and loads the
compiled renderer and embedded page script in Chromium. Run after compile:

```sh
node docs/reviews/180-narrow-panel-results/verify-renderer.cjs
```

The 24 measured cases cover panel widths 300, 450 and 900px, editor font sizes
14 and 28px, and dark, light, dark high-contrast and light high-contrast
colors. The fixture includes a scalar, long printed output, a simple loop
with body variables, nested loops, a loop with both stdout and stderr, and a
long error message. Assertions verify:

- Values and all visible buttons/checkboxes remain inside the viewport.
- Narrow rows stack; 900px rows retain source/result columns.
- Source and gutter do not overlap; clicking still posts the correct line.
- Capture timing remains visible and stacked labels are real DOM text.
- Whole-result folding retains natural source height and square corners.
- Resizing open results preserves their expansion without rebuilding.
- A separately enlarged 28px UI font wraps long toolbar labels while keeping
  checkboxes at their native width.

`renderer-results.json` records the measurements. The dark screenshots were
visually inspected at 300px/28px, 450px/14px and 900px/14px. The wider view
keeps X5's paired columns; the small view keeps full values readable below
the source. Large text necessarily increases the vertical space needed.

These Chromium checks do not prove the actual VS Code editor-navigation
routing, panel/sidebar layout, or screen-reader experience. The main session
will review the compiled change in the isolated Extension Development Host
before merging. No files in the user's teaching workspace were modified or
executed.
