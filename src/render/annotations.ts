import * as vscode from 'vscode';

import { annotationAt } from './announce';
import { Announcer } from './announcer';
import { Annotation, Decorator, sourceAt } from './decorations';
import { Flash, SETTLED } from './flash';
import {
  AnnotationRegistry, afterEdit, markDependents, merge, reanchor,
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
 */
export class Annotations implements vscode.Disposable {
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

  constructor(extensionUri: vscode.Uri, flash: Flash, announcer: Announcer) {
    this.decorator = new Decorator(extensionUri);
    this.flash = flash;
    this.announcer = announcer;
    this.subscriptions.push(
      vscode.workspace.onDidChangeTextDocument((event) => {
        // An edit invalidates what it touched, and nothing else. An
        // annotation ten lines above it was not made untrue by it, and taking
        // it away costs the user the thing they were reading.
        const uri = event.document.uri.toString();
        const before = this.registry.get(uri);
        if (before.length === 0) {
          return;
        }

        const after = reanchor(
          before, event.contentChanges, shifted,
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
        this.registry.set(uri, after);
        this.repaint(event.document);
        this.updateContext();
      }),

      vscode.workspace.onDidCloseTextDocument((document) => {
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

  /** Replace this document's annotations outright. */
  show(document: vscode.TextDocument, annotations: readonly Annotation[]): void {
    this.registry.set(document.uri.toString(), annotations);
    this.repaint(document);
    this.updateContext();
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
    this.show(document, markDependents(
      merge(this.registry.get(uri), annotation), annotation));
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
        if (withdrawn) {
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
        this.show(document, merge(kept, next));
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

  clear(document: vscode.TextDocument): void {
    if (this.registry.clear(document.uri.toString())) {
      this.repaint(document);
    }
    this.updateContext();
  }

  clearAll(): void {
    this.registry.clearAll();
    this.repaintAllVisible();
    this.updateContext();
    // The announced channel goes with them. A value still sitting in the
    // status bar after the annotations were dismissed is a reading of
    // something that is no longer on screen, and the one place a
    // screen-reader user goes back to is the worst place to leave one.
    this.announcer.silence();
  }

  dispose(): void {
    this.registry.clearAll();
    this.decorator.dispose();
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
    this.subscriptions.length = 0;
    void vscode.commands.executeCommand('setContext', HAS_ANNOTATIONS, false);
  }

  // -- internals ------------------------------------------------------------

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
