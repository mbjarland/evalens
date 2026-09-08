# Values panel gutter at enlarged font sizes

The line-number column previously reserved 44px while its contents followed
the editor font. At 28px the navigation arrow and line number could extend
into the source, making line 5 followed by `42` read as `542`.

The column now reserves the widest displayed line number (at least two
digits), one arrow, spacing, and padding in `ch`, plus its existing 3px
accent. Each row has the same allocation. Source text keeps its independent
ellipsis and the source column remains 300px; narrow-panel layout is #180.
The number width is a numeric CSS variable in the existing nonce style,
so the strict webview CSP is preserved.

## Compiled-renderer checks

Run after compiling the worktree:

```sh
node docs/reviews/179-large-font-gutter/verify-renderer.cjs
```

The harness runs its own three statements through the real Python kernel,
passes those readings through `present`, `rowsFor`, and `valuesHtml`, then
measures the generated HTML in Chrome. The 12 cases cover Menlo and Courier
New at 14px and 28px with dark, light, and high-contrast colors. It makes each
of lines 1, 5, and 137 the bold cursor row and checks that:

- The arrow and number remain inside their own column.
- The line number and source have at least a 9px visible gap.
- All source starts and value-column starts remain aligned.
- Source lines retain their own ellipsis.
- Clicking line 137 emits source coordinate 136.

All 12 cases pass. `renderer-results.json` records the measurements and the
four PNGs show the actual compiled output at both sizes. A separate markup
check covers a six-digit line ID without allocating a million-line file.
The Chromium measurements prove layout and the renderer's navigation
message, not VS Code navigation or its live font/theme updates.

After rebasing onto the terminology change at `f24d5ac`, all 937 extension
tests and 718 kernel tests pass. The original task baseline was 936 and 718;
the additional extension test belongs to #183. This layout-only fix adds no
unit tests. Its direct rendering checks above exercise the actual failure.

## Remaining verification

The root session will check actual source navigation, font/theme changes,
cursor/latest markers, and result folding in its isolated VS Code Host.
No user teaching files or normal VS Code settings were touched.
