import * as vscode from 'vscode';

import { Annotation, Decorator, sourceAt } from './decorations';
import { AnnotationRegistry, afterEdit, merge, reanchor } from './registry';

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

  constructor(extensionUri: vscode.Uri) {
    this.decorator = new Decorator(extensionUri);
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
          (annotation) => afterEdit(
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
   */
  add(document: vscode.TextDocument, annotation: Annotation): void {
    const uri = document.uri.toString();
    this.show(document, merge(this.registry.get(uri), annotation));
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
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document === document) {
        // Two editors on one document show the same annotations, which is
        // what a split view should do.
        this.decorator.show(editor, annotations);
      }
    }
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
