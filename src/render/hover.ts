import * as vscode from 'vscode';

import { Annotations } from './annotations';
import { SHOW_OUTPUT } from './decorations';
import { hasOutput } from './format';
import { tableMarkdown } from './table';

/**
 * The full answer, reachable by hovering the statement it came from.
 *
 * #46: the same content used to hang off a `DecorationOptions.hoverMessage`
 * anchored to a zero-width range at the end of the line -- the point built
 * only so an `after` attachment has somewhere to paint. `hoverMessage` keys
 * off `range`, and `vscode.d.ts` says plainly that a `DecorationOptions.range`
 * "must not be empty"; VS Code's own line-decoration hover lookup
 * (`ContentHoverComputer._getLineDecorations`) confirms it in the shipped
 * build, matching a decoration into a hover only when the pointer's own
 * anchor range falls within the decoration's column span on that line -- a
 * span of zero columns matches nothing a mouse or a keyboard ever produces.
 * So the hover was built, correct, and never once seen.
 *
 * A `HoverProvider` has no such range to fail on: the editor already resolves
 * the hovered position to real text before calling `provideHover` at all (per
 * `vscode.d.ts`, it defaults to "the word range at the position"), so this
 * only has to answer, never to find something to anchor to. That is also what
 * #55 verified reaches the Accessible View and gets focused on the first
 * `editor.action.showHover` press when a screen reader is detected -- the
 * same path a decoration's `hoverMessage` would have used, had it ever
 * matched anything.
 *
 * Reads `Annotations.at`, the same call the on-request announce command uses:
 * a read of what is already painted, never a re-evaluation. An annotation is
 * a trace (#40), and hovering must show what the statement produced when it
 * ran, not read the name again -- rereading could run a property or a
 * `__getattr__` because the mouse moved, which design rule 3 forbids outright.
 *
 * #24's whole hook into this class: `annotation.table`, present only when
 * the value duck-typed as one of the shapes `kernel/tabular.py` recognises,
 * is rendered by `render/table.ts`'s `tableMarkdown` and appended after the
 * fenced value -- an elaboration of the same trace, never a replacement for
 * it, and the inline annotation beside the code is unchanged either way.
 */
export class ValueHoverProvider implements vscode.HoverProvider {
  constructor(private readonly annotations: Annotations) {}

  provideHover(
    document: vscode.TextDocument, position: vscode.Position
  ): vscode.Hover | undefined {
    const annotation = this.annotations.at(document, position.line);
    // Nothing while a statement is still running: `pending` carries no
    // `hover` text, only a message about what it is waiting on, and that
    // already has a channel -- the `after` decoration itself. Nothing either
    // on a line with no annotation at all: contributing here is additive, and
    // hovering ordinary code must stay exactly what it was.
    if (!annotation || annotation.pending || annotation.hover === undefined) {
      return undefined;
    }

    // Same wrapping `decorations.ts` used to build: a fenced block for the
    // value, the table when there is one, plus the one link to the channel
    // holding what does not fit here either, and only where there is
    // something in it to reach.
    const message = new vscode.MarkdownString(
      ['```', annotation.hover, '```',
        ...(annotation.table
          ? ['', tableMarkdown(annotation.table)]
          : []),
        ...(hasOutput(annotation.printed)
          ? [`[Show all output](command:${SHOW_OUTPUT})`]
          : [])].join('\n'));
    // Narrow rather than a blanket `true`: a hover that can run one named
    // command is a link, and a hover that can run anything is a hole.
    message.isTrusted = { enabledCommands: [SHOW_OUTPUT] };

    return new vscode.Hover(message, document.lineAt(position.line).range);
  }
}
