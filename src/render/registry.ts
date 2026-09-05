/**
 * Which documents currently carry annotations.
 *
 * Kept free of `vscode` so the policy can be tested: annotations belong to a
 * document rather than to an editor, clearing one document must not touch
 * another, and a closed document must not leave an entry behind for the life
 * of the window.
 */
export class AnnotationRegistry<T> {
  private readonly byDocument = new Map<string, readonly T[]>();

  set(uri: string, annotations: readonly T[]): void {
    if (annotations.length === 0) {
      this.byDocument.delete(uri);
      return;
    }
    this.byDocument.set(uri, annotations);
  }

  get(uri: string): readonly T[] {
    return this.byDocument.get(uri) ?? [];
  }

  has(uri: string): boolean {
    return this.byDocument.has(uri);
  }

  /**
   * Drop this document's annotations, reporting whether there were any.
   *
   * The answer matters: this is called from `onDidChangeTextDocument`, which
   * fires on every keystroke in every open document. Repainting on each of
   * them -- almost always to clear nothing -- is work done thousands of times
   * an hour for no effect.
   */
  clear(uri: string): boolean {
    return this.byDocument.delete(uri);
  }

  /** Forget a document entirely, on close. */
  forget(uri: string): void {
    this.byDocument.delete(uri);
  }

  /** Clear everything, returning the documents that had annotations. */
  clearAll(): string[] {
    const cleared = [...this.byDocument.keys()];
    this.byDocument.clear();
    return cleared;
  }

  get documentCount(): number {
    return this.byDocument.size;
  }
}
