import * as vscode from 'vscode';

import { KernelClient } from '../kernel/client';
import { Annotations } from './annotations';
import { SHOW_OUTPUT } from './decorations';
import { INSPECT_VALUE } from './explorer';
import { hasOutput } from './format';
import {
  hasMoreToExplore, inspectionTable, isInspectableName,
} from './inspector';
import { staleReasonText, Traced, GO_TO_STALE_CAUSE } from './registry';
import { tableMarkdown } from './table';
import { inlineLoopHover } from './loopHistories';
import { LiveInspection } from './liveInspection';
import { literalBlock } from './markdown';
import { errorGuidance } from './errorGuidance';

/**
 * Why a stale annotation no longer describes the code beside it (#109).
 *
 * The chip's own chrome (`render/decorations.ts`) and the gutter icon say
 * *that* a value is stale; this is the one place that says *why*, for a
 * reader who has stopped to hover and is asking a question neither a grey
 * bar nor an icon can answer on their own. The two reasons are
 * `registry.ts`'s: `afterEdit` sets `'edited'` for a statement whose own
 * text changed, `markDependents` sets `'dependency'` for one whose text is
 * untouched but reads a name something below it rebound. The clause itself
 * lives in `registry.staleReasonText`, shared with the values panel (#116),
 * so the two surfaces never say this in two different ways.
 */
function staleExplanation(annotation: Traced): string {
  return `Stale: ${staleReasonText(annotation.staleReason, annotation.staleCause)}.`;
}

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
 * Reads `Annotations.at`, the same call the on-request announce command uses,
 * for the value's own text: a read of what is already painted, never a
 * re-evaluation. An annotation is a trace (#40), and hovering must show what
 * the statement produced when it ran, not read the name again -- rereading
 * could run a property or a `__getattr__` because the mouse moved, which
 * design rule 3 forbids outright.
 *
 * #23 adds one further round trip to the kernel *when there is something safe
 * to ask it*: `isInspectableName` accepts only a bare identifier, and a bare
 * name is design rule 3's own example of the one expression that "is a
 * dictionary lookup and cannot run anything". The kernel's `inspect` op keeps
 * that property one level down as well -- see `Kernel.inspect_value` -- so
 * the request this issues is exactly as safe as the read `annotations.at`
 * already performs, not a loosening of it. What this must never become is a
 * request built from anything *other* than a bare name: `self.x`, `d['key']`
 * or a tuple target would have to run a getter or a `__getitem__` to answer,
 * which is precisely the re-evaluation this file's own history warns against.
 *
 * #24 hooks in the same way: `annotation.table`, present only when the value
 * duck-typed as one of the shapes `kernel/tabular.py` recognises, is
 * rendered by `render/table.ts`'s `tableMarkdown` and appended after the
 * fenced value. That table belongs to the captured trace. The separately
 * labelled inspection reads current storage, only while the kernel is idle,
 * with a short deadline; it must not hold the cached trace hostage.
 */
export class ValueHoverProvider implements vscode.HoverProvider {
  private readonly inspection = new LiveInspection();
  constructor(
    private readonly annotations: Annotations,
    /**
     * A getter rather than a stored reference: the kernel client is not
     * spawned until the first evaluation, so a hover registered at
     * activation has to ask for whatever exists *now*. By the time there is
     * an annotation to hover at all, an evaluation has already run and the
     * client this returns is never undefined in practice.
     */
    private readonly getClient: () => KernelClient | undefined
  ) {}

  async provideHover(
    document: vscode.TextDocument, position: vscode.Position,
    token?: vscode.CancellationToken
  ): Promise<vscode.Hover | undefined> {
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
    // value, then the elaborations, then the one link to the channel holding
    // what does not fit here either.
    //
    // #24's table records the evaluated shape; #23's inspection reads the
    // current children and is labelled separately. A value
    // that is both a table and worth opening gets both, table first --
    // it says what the thing *is* before the children say what is in it.
    //
    // The stale explanation (#109) goes first of all, ahead of the value it
    // qualifies: a reader hovering a stale line is asking why before they
    // are asking what, and the chip itself already answered "expired"
    // without saying which of the two reasons is true here.
    const lines: string[] = [];
    if (annotation.stale) {
      lines.push(staleExplanation(annotation), '');
      if (annotation.staleCause?.source) {
        const args = encodeURIComponent(JSON.stringify([
          document.uri.toString(), annotation.staleCause.id,
        ]));
        lines.push(`[Go to re-binding](command:${GO_TO_STALE_CAUSE}?${args})`, '');
      }
    }
    const historyHover = inlineLoopHover(
      { ...annotation, value: annotation.value ?? null }, position.line);
    lines.push(literalBlock(historyHover ?? annotation.hover));
    const guidance = errorGuidance(annotation.error);
    if (guidance !== undefined) lines.push('', guidance);

    if (annotation.table) {
      lines.push('', tableMarkdown(annotation.table));
    }

    const client = this.getClient();
    const inspected = historyHover === undefined && client
      && isInspectableName(annotation.display)
      ? await this.inspection.ask(client, annotation.display, token)
      : undefined;
    if (inspected) {
      const table = inspectionTable(inspected);
      if (table !== undefined) {
        lines.push('', '*Current kernel value (may differ from the trace above)*',
          '', table);
      }
      if (hasMoreToExplore(inspected)) {
        const args = encodeURIComponent(JSON.stringify([annotation.display]));
        lines.push('', `[Explore ▸](command:${INSPECT_VALUE}?${args})`);
      }
    }

    if (hasOutput(annotation.printed)) {
      lines.push(`[Show all output](command:${SHOW_OUTPUT})`);
    }

    const message = new vscode.MarkdownString(lines.join('\n'));
    // Narrow rather than a blanket `true`: a hover that can run one or two
    // named commands is a link, and a hover that can run anything is a hole.
    message.isTrusted = { enabledCommands: [SHOW_OUTPUT, INSPECT_VALUE, GO_TO_STALE_CAUSE] };

    if (token?.isCancellationRequested || document.isClosed
        || this.annotations.at(document, position.line) !== annotation) {
      return undefined;
    }
    return new vscode.Hover(message, document.lineAt(position.line).range);
  }

}
