# Native recorded text verification

Implementation work for #186. This is developer/agent verification, not a
human usability study. Root-session Extension Development Host review is
still required before closing the ticket.

## Behavior

Long value representations and statement streams open as read-only native
text documents. Each tab names its source, statement range, recorded kind
and recording number. The active lock status item explains the scope and
capture limits and includes a bounded preview of the source captured with
the result. That preview is frozen, so later source edits cannot rewrite its
provenance. Metadata does not enter the copied payload.

Loop output links consistently open the whole statement's available stream,
including links beneath an individual iteration. No link implies that its
scope is only the selected iteration. Native Find, selection, copy and diff
remain VS Code operations, with no new panel search implementation.

Raw stdout/stderr preserve their final newline and blank output. Raw value
representations preserve multiline content, tabs and original nonbreaking
spaces; they no longer reuse the inline formatter's collapsed string.
History summaries remain summaries. Kernel truncation markers stay present.
VS Code text models may normalize line endings; this does not promise a
byte-preserving file export for mixed line endings.

Opened recordings stay immutable across reruns, clear and restart. Their tabs
are pinned against preview replacement. Closing the last owning text or diff
tab releases the provider entry; document closure also releases unowned data.
A language-mode change does not evict a recording whose tab stays open. The
provider permits at most 32 recordings and 8 Mi UTF-16 code units of payload
plus retained source/label metadata. At the bound it asks the reader to close
a recording, without evicting an open baseline. Window reload does not restore
these transient recordings.

Native inspection preserves the originating panel DOM, scroll position,
folds and pages. Source navigation while a recording is active reveals Python
with panel focus preserved, rather than moving the plaintext cursor. A new
result gets the existing fresh-result fold behavior.

## Automated and real-kernel evidence

`src/test/recordedText.test.ts` adds nine checks, including a loaded extension
using the real Python subprocess and its request pipe. The request probe sees
actual evaluations and verifies that stream and repr exports add no request:
no evaluation, inspection, reset or extra representation call.

The fixtures cover 2 by 25 nested iterations writing distinct stdout/stderr
with `åäö 🐍`, a custom multiline representation with tabs and leading spaces,
stale source provenance, opening a baseline and rerunning changed code,
revision guards, recorded truncation, tab/diff ownership, and returning from
native text to the source. They inspect compiled Values panel HTML as well as
the native provider's exact text and source context.

Before integration rebase: 944 extension tests on the parent branch; 952
extension tests pass after this change. After rebasing onto master `173ef23`,
which includes recording evidence and session help, 959 extension tests pass
(parent: 950). The unchanged kernel suite passes 718 tests. Logs are
`/private/tmp/evalens-186-extension.log` and
`/private/tmp/evalens-186-kernel.log`. Root review must still check native
Find/copy, readonly behavior,
status tooltip legibility, and physical focus return in an actual Host.


## Host review correction

The root Host review caught a flat-export dispatch mismatch: the receiver
required the render revision, but the existing flat action click listener did
not send it. The listener now sends its revision. The new regression executes
that actual listener extracted from compiled webview HTML, dispatches a click
through the provider and real-kernel fixture, and checks exact Unicode output,
no additional Python request, and rejection of a queued old-render click.
It does not bypass the sender by constructing an already-valid message.
