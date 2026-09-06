import * as vscode from 'vscode';

import { annotationAt } from './announce';
import { Announcer } from './announcer';
import { Annotation, Decorator, sourceAt } from './decorations';
import { Flash, SETTLED } from './flash';
import {
  AnnotationRegistry, TextChange, afterEdit, markDependents, merge, reanchor,
  reanchorLate,
} from './registry';
import { Waiting } from './status';

/**
 * Move an annotation `lines` further down the file, keeping its columns.
 *
 * The shell's whole share of the edit arithmetic: `registry.ts` decides which
 * annotations move and by how much, and cannot build a `vscode.Range` to say
 * so.
 *
 * The anchor moves with the range. It is an absolute line, so leaving it
 * behind would strand a compound statement's value on whatever line ended up
 * where its header used to be.
 */
function shifted(annotation: Annotation, lines: number): Annotation {
  return {
    ...annotation,
    range: new vscode.Range(
      annotation.range.start.line + lines, annotation.range.start.character,
      annotation.range.end.line + lines, annotation.range.end.character),
    ...(annotation.anchor === undefined
      ? {}
      : { anchor: annotation.anchor + lines }),
  };
}

/**
 * Set while the active editor has annotations, so `escape` keeps doing
 * everything else it does when there are none.
 */
export const HAS_ANNOTATIONS = 'evalens.hasAnnotations';

/**
 * `Annotations.onDidChange`'s payload (#149): which line to scroll the
 * values panel to, when the mutation that fired the event can name one. See
 * `changeEmitter`'s own doc comment, on the class below, for exactly when
 * `line` is present and what a consumer does when it is not.
 */
export interface AnnotationChangeEvent {
  readonly line?: number;
}

/**
 * What `validity` hands back (#150) -- the closed-over check #121 shipped as
 * a single `() => boolean`, split so a caller can tell "nothing has changed"
 * from "something changed, but a late result might still be placed".
 */
export interface Validity {
  /**
   * Every #121 gate except the document version: not disposed, not closed,
   * the same clear-all generation and the same clear/close epoch this
   * document had when the request was made. A result that fails this is
   * dropped outright -- see `reason` -- because there is no version left
   * that could mean anything: the document this was for is gone, or every
   * annotation living in it was dismissed on purpose.
   */
  readonly placeable: () => boolean;
  /** `placeable()`, and the document has not changed at all since. The
   * whole of what `validity` answered before #150. */
  readonly current: () => boolean;
  /** The document version this was captured against, for `reconcile`. */
  readonly version: number;
  /** Why `placeable()` answers false, for the discard message `evaluate.ts`
   * logs -- `undefined` for as long as it still answers true. */
  readonly reason: () => 'closed' | 'cleared' | undefined;
}

/**
 * One `onDidChangeTextDocument` event, kept long enough for a late result
 * dispatched before it to be mapped across it -- see `reconcile`.
 */
interface BufferedEdit {
  /** The version `changes` was applied to produce the document's current
   * one -- what `reconcile` matches a late result's own captured version
   * against to find where its replay has to start. */
  readonly versionBefore: number;
  readonly changes: readonly TextChange[];
}

/**
 * How many of a document's edits `reconcile` keeps looking back through.
 * "A few hundred changes" per #150's own ticket -- generous against any
 * evaluation that is merely slow, and cheap to keep: each entry is one
 * keystroke's `contentChanges`, not a copy of the document. Past this, a
 * result older than everything still buffered is dropped rather than
 * guessed at, the same conservative default #121 already chose for a
 * document closed out from under a request.
 */
const MAX_BUFFERED_EDITS = 200;

/**
 * Owns what is painted, and when it stops being painted.
 *
 * A value out of sync with the code beside it is the notebook's original sin,
 * and this class is where Evalens either commits it or does not. An edit is
 * not allowed to leave a value looking current when the kernel has not been
 * told about the edit -- but the answer to that is to *say so*, not to take
 * the value away. Wiping the document was the first reading of it and took
 * every true value down with the one in doubt; dropping just the edited line
 * was the second, and it hid the divergence by hiding the evidence of it.
 * What is left on screen now is the value, the code that no longer matches it,
 * and an amber marker in the gutter saying exactly that.
 *
 * That is the answer for an edit that leaves a statement there to disagree
 * with. When it does not -- the line commented out, its text deleted -- there
 * is no code left to be out of sync with anything, so amber would be its own
 * kind of over-claiming, and `afterEdit` drops the annotation instead (#96).
 */
export class Annotations implements vscode.Disposable {
  private readonly epochs = new WeakMap<vscode.TextDocument, number>();
  /**
   * Documents `onDidCloseTextDocument` has fired for, independent of
   * `document.isClosed` -- kept only to word a discard message correctly
   * (#150): epoch already invalidates a closed document exactly as it did
   * before this ticket, so nothing here changes *whether* one is dropped.
   */
  private readonly closedDocuments = new WeakSet<vscode.TextDocument>();
  /** Recent edits per document, oldest first -- see `reconcile`. */
  private readonly recentEdits =
    new WeakMap<vscode.TextDocument, readonly BufferedEdit[]>();
  private generation = 0;
  private disposed = false;

  /** A result may only paint the document and lifecycle that requested it. */
  validity(document: vscode.TextDocument): Validity {
    const version = document.version;
    const generation = this.generation;
    const epoch = this.epochs.get(document);
    const placeable = (): boolean => !this.disposed && !document.isClosed
      && this.generation === generation && this.epochs.get(document) === epoch;
    return {
      placeable,
      current: () => placeable() && document.version === version,
      version,
      reason: () => placeable()
        ? undefined
        : (this.disposed || document.isClosed
            || this.closedDocuments.has(document))
          ? 'closed' : 'cleared',
    };
  }

  /**
   * Map a result computed against `document` as it stood at `version` onto
   * where its statement stands now, or say it cannot be (#150).
   *
   * The common case is the fast path: nothing has touched the document
   * since `version`, so `candidate` comes back exactly as it arrived --
   * checked first, and it is the only work a result that is not late ever
   * costs. Otherwise every edit buffered since `version` is replayed
   * against it with `reanchorLate`, deferring the evaluated-or-stale
   * decision to the end for the same reason that function's own doc
   * comment gives: only once every buffered edit has run is the range
   * settled enough to compare against the live document.
   *
   * `undefined` when the gap cannot be covered: `version` is older than
   * everything still buffered -- trimmed by `MAX_BUFFERED_EDITS`, or from
   * before this document was ever edited under this activation -- or some
   * buffered edit cut into or pasted into the statement's own lines.
   * `evaluate.ts` is what logs the discard; this only decides there is one.
   *
   * Nothing here asks the kernel anything, and nothing re-reads the buffer
   * to decide whether `candidate`'s own value is still correct (design
   * rules 3 and 4) -- only the coordinates move, and only `afterEdit`'s
   * existing comparison, the same one an edit arriving on time already
   * runs, decides evaluated from stale.
   */
  reconcile(
    document: vscode.TextDocument, version: number, candidate: Annotation
  ): Annotation | undefined {
    if (document.version === version) {
      return candidate;
    }
    const buffered = this.recentEdits.get(document) ?? [];
    const start = buffered.findIndex((edit) => edit.versionBefore === version);
    if (start === -1) {
      return undefined;
    }
    return reanchorLate(
      candidate, buffered.slice(start).map((edit) => edit.changes), shifted,
      (annotation) => afterEdit(annotation, sourceAt(document, annotation.range))
    );
  }

  private readonly registry = new AnnotationRegistry<Annotation>();
  private readonly decorator: Decorator;
  private readonly subscriptions: vscode.Disposable[] = [];

  /**
   * The success emphasis, shared with the selection snap rather than owned.
   *
   * One `Flash` exists for the window and both callers reach it, so a snap
   * highlight and a "this just ran" emphasis cannot be up at the same time
   * with two timers each expiring on the other's decorations.
   */
  private readonly flash: Flash;

  /**
   * The channel a screen reader can reach, which the decorations cannot be.
   *
   * Held here rather than called from the evaluator because `settle` is
   * already the precise thing that has to be announced -- one statement, run
   * because somebody pressed a key and is waiting for the answer -- and `add`
   * is already the bulk path that must stay silent. Routing the announcement
   * off those two methods means there is no code path from a file load to the
   * announcer to get wrong later.
   */
  private readonly announcer: Announcer;

  /**
   * Fired whenever a document's annotations change shape -- added, cleared,
   * marked stale by an edit or by `markDependents`. The values panel (#116)
   * always rebuilds from whatever `vscode.window.activeTextEditor` is *at
   * the moment the event is handled*, not from a document captured here,
   * since the active editor can itself change between one microtask and the
   * next -- which is also why the payload never carries a document, only
   * the one thing the panel cannot otherwise work out for itself: which
   * line to scroll into view (#149).
   *
   * `line` is the annotation's own display line whenever the mutation that
   * fired this can name exactly one: `add` (an evaluation just landed) and
   * the still-running mark `pending` keeps live both know precisely which
   * row changed. It is absent whenever there is no single line to name --
   * `clear` and `clearAll` drop everything at once, and an edit `reanchor`
   * re-anchors can touch more than one annotation in the same event -- and
   * the panel's own answer to an absent line is the active editor's cursor,
   * which is where the reader's attention already is.
   *
   * Nothing here polls: this is the one place raised, and `show`, `clear`
   * and `clearAll` are the only three ways the registry's content changes,
   * `add`, `pending` and the `onDidChangeTextDocument` handler all reach it
   * through `show`.
   */
  private readonly changeEmitter = new vscode.EventEmitter<AnnotationChangeEvent>();

  readonly onDidChange = this.changeEmitter.event;

  constructor(extensionUri: vscode.Uri, flash: Flash, announcer: Announcer) {
    this.decorator = new Decorator(extensionUri);
    this.flash = flash;
    this.announcer = announcer;
    this.subscriptions.push(
      vscode.workspace.onDidChangeTextDocument((event) => {
        // Buffered before anything else below returns early: a late result
        // needs this record whether or not the document currently carries
        // any annotations of its own to re-anchor (#150).
        if (event.contentChanges.length > 0) {
          this.bufferEdit(event.document, event.contentChanges);
        }

        // An edit invalidates what it touched, and nothing else. An
        // annotation ten lines above it was not made untrue by it, and taking
        // it away costs the user the thing they were reading.
        const uri = event.document.uri.toString();
        const before = this.registry.get(uri);
        if (before.length === 0) {
          return;
        }

        const retained = event.contentChanges.length > 0
          ? before.filter((annotation) => !annotation.pending) : before;
        const after = reanchor(
          retained, event.contentChanges, shifted,
          // The document has already been updated by the time this fires, so
          // this reads what the statement says *after* the edit -- which is
          // the only thing that can be compared with what it said when it
          // ran. Nothing is asked of the kernel.
          //
          // A mark on a statement that has not finished is exempt. Stale means
          // "this value no longer describes the code beside it", and a mark
          // states no value to be wrong about. Marking it would also replace
          // the object, and the handle that has to take the mark back holds it
          // by identity.
          (annotation) => annotation.pending
            ? annotation
            : afterEdit(
                annotation, sourceAt(event.document, annotation.range))
        );
        if (after === before) {
          return;
        }

        // Nothing is re-evaluated here. A surviving annotation is still the
        // value its statement produced when it last ran, which is all it ever
        // claimed to be -- and the marker is the extension saying so out loud.
        this.show(event.document, after);
      }),

      vscode.workspace.onDidCloseTextDocument((document) => {
        this.closedDocuments.add(document);
        this.epochs.set(document, (this.epochs.get(document) ?? 0) + 1);
        // Without this the map grows for the life of the window.
        this.registry.forget(document.uri.toString());
        this.updateContext();
      }),

      vscode.window.onDidChangeVisibleTextEditors(() => {
        // Decorations belong to an editor, not a document, so switching tabs
        // and back needs them reapplied -- otherwise annotations survive in
        // the model and vanish from the screen.
        this.repaintAllVisible();
      }),

      vscode.window.onDidChangeActiveTextEditor(() => this.updateContext())
    );
  }

  /**
   * Replace this document's annotations outright.
   *
   * `changedLine` is passed straight through to `onDidChange` (#149) -- see
   * that event's own doc comment, above, for what it means and which
   * callers have one to give.
   */
  show(
    document: vscode.TextDocument, annotations: readonly Annotation[],
    changedLine?: number
  ): void {
    this.registry.set(document.uri.toString(), annotations);
    this.repaint(document);
    this.updateContext();
    this.changeEmitter.fire({ line: changedLine });
  }

  /**
   * Add one annotation, displacing any it overlaps.
   *
   * This is also the only thing that clears a stale marker, and it does so by
   * construction rather than by rule: the annotation that arrives here came
   * from an evaluation that just happened, so it starts life current, and
   * `merge` puts it where the marked one was. Nothing anywhere unsets the
   * flag, which is what keeps "the kernel agrees" from ever being asserted by
   * something other than asking the kernel.
   *
   * And it is where an evaluation marks what it invalidated. Binding `x` again
   * does not change the annotation on the line below that reads `x`, but it
   * does make it a description of a world that has moved on -- so that one gets
   * the mark too. Marked, and nothing more: no dependant is re-run, queued or
   * ordered here, and adding that would be building a different product.
   */
  add(document: vscode.TextDocument, annotation: Annotation): void {
    const uri = document.uri.toString();
    this.show(
      document,
      markDependents(merge(this.registry.get(uri), annotation), annotation),
      // The row this just added -- `anchor` when the statement set one,
      // matching exactly where `panel/html.ts`'s own `rowFor` displays it
      // (#149), so the values panel reveals the row a reader would
      // recognise as the one that just changed.
      annotation.anchor ?? annotation.range.end.line);
  }

  /**
   * Mark a range as unfinished, and answer a handle on the mark.
   *
   * Called on the keypress, before the kernel is asked anything. The old value
   * goes at that moment, which is what makes an evaluation visible even when
   * it is about to produce exactly the string it produced last time.
   *
   * A handle rather than a line number because the mark is a live thing: it
   * changes what it says while it waits, and it has to be taken back when the
   * statement produced nothing to replace it with. Identity is what makes both
   * safe -- an unrelated evaluation landing on the same line cannot take
   * another's mark away.
   */
  pending(
    document: vscode.TextDocument, range: vscode.Range, anchor?: number
  ): Waiting {
    let current: Annotation = {
      range,
      ...(anchor === undefined ? {} : { anchor }),
      pending: {},
    };
    let withdrawn = false;
    this.add(document, current);

    return {
      say: (message) => {
        if (withdrawn || !this.registry
            .get(document.uri.toString()).includes(current)) {
          withdrawn = true;
          // The evaluation finished, or was abandoned, while something was
          // still being said about it. Re-adding the mark now would leave a
          // line claiming to be running something that is over.
          return;
        }
        const next: Annotation = {
          ...current,
          pending: message === undefined ? {} : { message },
        };
        const kept = this.registry
          .get(document.uri.toString())
          .filter((each) => each !== current);
        current = next;
        this.show(document, merge(kept, next), next.anchor ?? next.range.end.line);
      },
      withdraw: () => {
        if (withdrawn) {
          return;
        }
        withdrawn = true;
        const before = this.registry.get(document.uri.toString());
        const after = before.filter((each) => each !== current);
        if (after.length !== before.length) {
          this.show(document, after);
        }
      },
    };
  }

  /**
   * Paint a finished value, with the brief emphasis that says it just changed.
   *
   * Separate from `add` because a file load calls that two hundred times and
   * two hundred simultaneous flashes are a strobe, not information. This is
   * the single-statement path, where the flash is the whole point.
   */
  settle(document: vscode.TextDocument, annotation: Annotation): void {
    this.add(document, annotation);
    this.flash.show(this.editorsFor(document), [annotation.range], SETTLED);
    // The flash and the announcement are the same event told twice, to two
    // readers. Both say "this happened here, just now", and one of them is the
    // only version of that a screen-reader user gets.
    this.announcer.announce(annotation);
  }

  /**
   * What is painted on `line`, for a reader who has to ask rather than look.
   *
   * A read of what is already in the registry and nothing more: no kernel
   * request, no re-evaluation, no re-reading of the buffer. An annotation is a
   * trace of what its statement produced when it ran, and it does not become a
   * watch by being spoken instead of painted.
   */
  at(document: vscode.TextDocument, line: number): Annotation | undefined {
    return annotationAt(this.registry.get(document.uri.toString()), line);
  }

  /**
   * Every annotation currently painted in `document`, for a reader that
   * wants the whole picture rather than one line -- the values panel (#116),
   * which lists a row per annotation rather than answering about a single
   * cursor position the way `at` does.
   *
   * A read of what is already in the registry, on the same terms as `at`:
   * no kernel request, no re-evaluation, no re-reading of the buffer.
   */
  all(document: vscode.TextDocument): readonly Annotation[] {
    return this.registry.get(document.uri.toString());
  }

  clear(document: vscode.TextDocument): void {
    this.epochs.set(document, (this.epochs.get(document) ?? 0) + 1);
    if (this.registry.clear(document.uri.toString())) {
      this.repaint(document);
      // No line: everything in the document just disappeared, and there is
      // nothing left to reveal (#149).
      this.changeEmitter.fire({});
    }
    this.updateContext();
  }

  clearAll(): void {
    this.generation += 1;
    const cleared = this.registry.clearAll();
    this.repaintAllVisible();
    this.updateContext();
    // The announced channel goes with them. A value still sitting in the
    // status bar after the annotations were dismissed is a reading of
    // something that is no longer on screen, and the one place a
    // screen-reader user goes back to is the worst place to leave one.
    this.announcer.silence();
    if (cleared.length > 0) {
      // No line, for the same reason `clear` gives no line above: a
      // clear-all leaves nothing anywhere to reveal (#149).
      this.changeEmitter.fire({});
    }
  }

  dispose(): void {
    this.disposed = true;
    this.registry.clearAll();
    this.decorator.dispose();
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
    this.subscriptions.length = 0;
    this.changeEmitter.dispose();
    void vscode.commands.executeCommand('setContext', HAS_ANNOTATIONS, false);
  }

  // -- internals ------------------------------------------------------------

  /**
   * Record one event's `changes` for `reconcile` to find later, bounded to
   * `MAX_BUFFERED_EDITS`.
   *
   * `versionBefore` is `document.version - 1` rather than tracked
   * separately: `onDidChangeTextDocument` fires once per applied edit and
   * the document has already been updated by the time it does (the same
   * fact the existing re-anchor handler relies on above), so the version
   * this event moved the document *from* is always one less than the
   * version it left it at. A caller whose own captured version turns out
   * not to equal any `versionBefore` here -- because it predates everything
   * still buffered -- gets `undefined` from `reconcile` rather than a wrong
   * guess; see that method's own doc comment.
   */
  private bufferEdit(
    document: vscode.TextDocument, changes: readonly TextChange[]
  ): void {
    const kept = this.recentEdits.get(document) ?? [];
    const entry: BufferedEdit = { versionBefore: document.version - 1, changes };
    const trimmed = kept.length >= MAX_BUFFERED_EDITS
      ? kept.slice(kept.length - MAX_BUFFERED_EDITS + 1)
      : kept;
    this.recentEdits.set(document, [...trimmed, entry]);
  }

  private repaint(document: vscode.TextDocument): void {
    const annotations = this.registry.get(document.uri.toString());
    // Two editors on one document show the same annotations, which is what a
    // split view should do.
    for (const editor of this.editorsFor(document)) {
      this.decorator.show(editor, annotations);
    }
  }

  private editorsFor(document: vscode.TextDocument): vscode.TextEditor[] {
    return vscode.window.visibleTextEditors.filter(
      (editor) => editor.document === document);
  }

  private repaintAllVisible(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      this.decorator.show(
        editor, this.registry.get(editor.document.uri.toString()));
    }
  }

  private updateContext(): void {
    const active = vscode.window.activeTextEditor;
    const has = active !== undefined
      && this.registry.has(active.document.uri.toString());
    void vscode.commands.executeCommand('setContext', HAS_ANNOTATIONS, has);
  }
}
