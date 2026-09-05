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
 * The minimum an edit needs for the shift arithmetic to be decidable.
 *
 * `vscode.TextDocumentContentChangeEvent` satisfies this structurally -- its
 * `range` is a `vscode.Range`, whose positions carry a `line` -- which is what
 * lets the arithmetic live here, in a module the test runner can load, rather
 * than in the editor shell where nothing can reach it.
 */
export interface TextChange extends Anchored {
  /** What the range was replaced with. */
  readonly text: string;
}

/** Rebuild an annotation `lines` further down the file. */
export type Shift<T> = (annotation: T, lines: number) => T;

function countLineBreaks(text: string): number {
  let count = 0;
  for (let at = text.indexOf('\n'); at !== -1;) {
    count += 1;
    at = text.indexOf('\n', at + 1);
  }
  // Counting '\n' is also right for CRLF documents: each break still contains
  // exactly one of them.
  return count;
}

/** How many lines an edit added, negative when it removed some. */
export function lineDelta(change: TextChange): number {
  return countLineBreaks(change.text)
    - (change.range.end.line - change.range.start.line);
}

/**
 * Re-anchor a document's annotations across one edit.
 *
 * Three cases, and the middle one is the whole point of the exercise. An
 * annotation the edit touched is dropped, because its value may no longer be
 * true and a value that might be wrong poisons every other value on screen.
 * One below the edit is shifted, so it stays beside the statement it belongs
 * to. One above is returned untouched -- the same object, so nothing
 * downstream has to guess whether it moved.
 *
 * The array itself comes back by identity when the edit changed nothing, which
 * is the common case: this runs on every keystroke, and repainting a document
 * whose annotations all sit above the cursor is thousands of pointless
 * `setDecorations` calls an hour.
 */
function reanchorOne<T extends Anchored>(
  annotations: readonly T[], change: TextChange, shift: Shift<T>
): readonly T[] {
  const delta = lineDelta(change);
  const kept: T[] = [];
  let touched = false;

  for (const annotation of annotations) {
    if (overlaps(annotation, change)) {
      touched = true;
      continue;
    }
    // Not overlapping leaves only two places to be: entirely above the edit,
    // or entirely below it.
    if (delta !== 0 && annotation.range.start.line > change.range.end.line) {
      kept.push(shift(annotation, delta));
      touched = true;
    } else {
      kept.push(annotation);
    }
  }

  return touched ? kept : annotations;
}

/**
 * Later edits first.
 *
 * Every change in one event addresses the document as it was before the event,
 * so they have to be applied bottom-up or an earlier shift invalidates the
 * coordinates of a later one. Going in this order is safe for a reason worth
 * writing down: an edit can only shrink the document by the number of lines it
 * spans, so an annotation below a lower edit stays below every higher one no
 * matter how much that lower edit deleted.
 *
 * VS Code already delivers `contentChanges` in this order, but that is not
 * promised anywhere in the API, and a multi-cursor edit arriving the other way
 * round would corrupt the file's annotations silently.
 */
function lastFirst(a: TextChange, b: TextChange): number {
  return b.range.start.line - a.range.start.line;
}

/**
 * Re-anchor a document's annotations across everything one change event did.
 *
 * Returns the input array by identity when no annotation was dropped or
 * moved, so the caller can skip the repaint.
 */
export function reanchor<T extends Anchored>(
  annotations: readonly T[],
  changes: readonly TextChange[],
  shift: Shift<T>
): readonly T[] {
  let current = annotations;
  // Sorted on a copy: the event's array is the editor's, not ours to reorder.
  for (const change of [...changes].sort(lastFirst)) {
    current = reanchorOne(current, change, shift);
  }
  return current;
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
   * The answer matters because the caller repaints on a `true`, and Escape
   * reaches here whether or not there was anything to dismiss.
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
