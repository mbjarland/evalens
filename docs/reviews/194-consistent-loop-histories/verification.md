# One format for loop histories

The maintainer reported the outer/inner inconsistency after the narrower
repeated-loop change and approved values-first formatting for every loop
history on 2026-09-08. Implementation is `90f9652`, based on master `8ed11d0`.

The coordinating agent used an actual VS Code Extension Development Host
and disposable source files, with the issue worktree loaded. Nine fixtures
verified rendered annotation text and saved hovers: outer/inner 100-by-100
loops, uneven bounds with break, reached empty, not reached, a single inner
invocation, reused target names, full body histories, a filtered body using
continue, and a constant body history. The [Host report](host.json) records
the observed text and colors. The [uniform](uniform.png) and
[filtered](filtered.png) screenshots were inspected alongside body histories.

A filtered history must count recorded observations, not conditional
assignments: a value can carry forward on iterations that do not reassign
it. The filtered fixture uses continue to skip the recording point and
correctly shows five target iterations with two body observations.

After increasing the decoration pool, the Host was reloaded. A real source
fixture reached exactly 48 decorated slots: target plus three body histories,
four read names, stdout and stderr, an additional-name notice and a partial
parse notice. [Its rendered pieces](wide.json) retained the three semantic
colors instead of falling back to a single-color annotation.

After the final panel helper change, the Host was reloaded again. A
comprehension in the ordinary Values panel retained its trailing iteration
count beside its observed values. The accumulator's native walkthrough
loaded both refreshed images at their new dimensions; its
[rendering](guide.png) and [results](panel-guide.json) were inspected.

Seven current public images were recaptured directly from VS Code: the
accumulator before/after pair and the README's loop, hero, spot-the-bug,
watch and comprehension examples. Their source and capture rectangles are
in [current-images.json](current-images.json). The image files themselves
live under media/learning/screenshots and media/demo. Source comes from the
actual learning template and existing docs/stills specifications. No pixels
or annotations were recreated. Historical review images remain unchanged.

The worker's full suites passed: 968 extension tests and 718 kernel tests.
The baseline had 969 extension tests; the removed test covered the unshipped
loopGlyph override that no longer applies. Existing cases cover count colors,
unequal histories, elision, speech, repeat suppression, maximum decoration
capacity, native text export and panel folding with trailing metadata.

This was an agent-operated macOS check, with Dark Modern and Menlo. Source
checks used 18 px at 1900 by 850 CSS pixels; public screenshot clips used
20 px at 2x; the deliberately wide fixture used 14 px at 3000 by 900.
No human learner study or physical screen-reader/Windows test was performed.
The review scripts depend on the session's temporary HTTP bridge and
Puppeteer client, as indicated in their source. The installed-artifact and
post-merge checks are recorded in the ticket's release note.
