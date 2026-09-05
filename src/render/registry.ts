/** The minimum an annotation needs for overlap to be decidable. */
export interface Anchored {
  readonly range: {
    readonly start: { readonly line: number };
    readonly end: { readonly line: number };
  };
}

/** Do these two annotations cover any of the same lines? */
export function overlaps(a: Anchored, b: Anchored): boolean {
  return a.range.start.line <= b.range.end.line
    && b.range.start.line <= a.range.end.line;
}

/**
 * Add an annotation, displacing any it overlaps.
 *
 * Results accumulate: the point of the feature is that a file becomes a
 * worked example you can read, which needs more than one value on screen at
 * a time. But re-evaluating a statement must update its annotation rather
 * than stack a second one on the same line -- and "the same statement" is
 * overlap, not equality, because the ranges genuinely nest. Evaluating a line
 * inside a function and then the function itself produces one range
 * containing the other, and painting both would put two values on one line.
 */
export function merge<T extends Anchored>(
  existing: readonly T[], added: T
): T[] {
  return [...existing.filter((each) => !overlaps(each, added)), added];
}

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
