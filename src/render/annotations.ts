import * as vscode from 'vscode';

import { Annotation, Decorator } from './decorations';
import { AnnotationRegistry, merge, reanchor } from './registry';

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
 * A stale value is worse than no value: an annotation left beside a line the
 * user has since edited is the extension asserting something untrue, and once
 * one annotation on screen can be wrong the user cannot trust any of them.
 * Everything here follows from that -- but only for the lines an edit actually
 * touched. An annotation ten lines above an edit was not made untrue by it,
 * and taking it away costs the user the thing they were reading.
 */
export class Annotations implements vscode.Disposable {
  private readonly registry = new AnnotationRegistry<Annotation>();
  private readonly decorator = new Decorator();
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor() {
    this.subscriptions.push(
      vscode.workspace.onDidChangeTextDocument((event) => {
        // An edit invalidates what it touched, and nothing else. Wiping the
        // document was the earlier reading of "a stale value is worse than no
        // value", and it took the true values down with the stale one: change
        // one number and the whole column you were reading goes.
        const uri = event.document.uri.toString();
        const before = this.registry.get(uri);
        if (before.length === 0) {
          return;
        }

        const after = reanchor(before, event.contentChanges, shifted);
        if (after === before) {
          return;
        }

        // Nothing is re-evaluated here. A surviving annotation is still the
        // value its statement produced when it last ran, which is all it ever
        // claimed to be.
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

  /** Add one annotation, displacing any it overlaps. */
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
