# Nested-loop values before aggregate counts

The maintainer selected the values-first recommendation in #174 on
2026-09-08. Implementation is tracked as #193, based on master `22a4e7c`.

The coordinating agent ran six disposable Python fixtures in an actual
VS Code Extension Development Host with this issue worktree loaded. The
checks read the rendered decoration text and computed colors, requested the
saved hover for each inner source header, and captured the editor. The agent
inspected all six screenshots and the actual displayed native hover.

- The [100-by-100 loop](uniform.png) shows
  `y: 0, 1, 2, 3, 4, …, 99 · 100 runs · 10,000 iterations total`.
  Its outer annotation and printed output retain their existing format.
- The [uneven loop with an early break](uneven.png) shows
  `y: 0, 0, 1, 0, 1 · 4 runs · 5 iterations total`, preserving repeats and
  counting the empty run without assuming equal iteration counts per run.
- Reached empty loops show `(no iterations) · 2 runs · 0 iterations total`;
  an unreached inner loop shows `(not reached)`.
- A single inner invocation retains `y ×3: 0, 1, 2`.
- Three source sites reusing `x` keep separate sequences and run counts.
- Suffix counts use the existing label color, distinct from value color.
- The [native hover](hover.png) explains run versus iteration, observation
  order, and the 9,994 omitted values in the large example. Inspection reads
  recorded strings rather than evaluating the source again.

[Host results](host.json) include the actual rendered pieces, colors and
hover text. [Fixtures](fixtures/) contain exactly the evaluated source.
[The Host harness](verify-host.cjs) records the review procedure; it uses the
session's temporary HTTP bridge and Puppeteer client at
`/private/tmp/evalens-learning-live/client.cjs`. It is review evidence,
not an additional dependency or portable CI test.

This visual check used macOS, Dark Modern, Menlo 18, and a 1900-by-850 CSS
viewport. It establishes the inspected rendering, not human learner
comprehension or physical screen-reader/Windows behavior. The change does
not alter keyboard dispatch or kernel capture. Automated suite and installed
artifact results are recorded in the implementation ticket's release note.
