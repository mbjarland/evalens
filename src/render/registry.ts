/** The minimum an annotation needs for overlap to be decidable. */
export interface Anchored {
  readonly range: {
    readonly start: { readonly line: number };
    readonly end: { readonly line: number };
  };
}

/**
 * An annotation that knows what its statement said when the value was taken.
 *
 * The pair is what lets an edit be judged rather than merely detected: an
 * annotation is a *trace* (#40), so nothing here ever re-reads a value to find
 * out whether it is still true. The only question that can be answered without
 * running the user's code is whether the code has moved on, and `source` is
 * what makes that answerable.
 */
export interface Traced extends Anchored {
  /**
   * The statement's own lines when it last ran, through `normalizeSource`.
   *
   * Absent means unknown, and unknown counts as changed: an annotation that
   * cannot prove it still matches its code is marked rather than trusted.
   */
  readonly source?: string;
  /**
   * The value no longer describes the code beside it.
   *
   * Set by an edit, cleared only by evaluating the statement again -- which
   * replaces the annotation outright, so there is nothing here to unset. In
   * particular *undoing* the edit does not clear it: the buffer can be put
   * back, but the kernel was never told, and only an evaluation is entitled to
   * say that the two agree again.
   */
  readonly stale?: boolean;
}

/** How an annotation stands relative to the code it sits beside. */
export type Marker = 'evaluated' | 'stale' | 'error';

/**
 * Which of the three states an annotation is in.
 *
 * Stale outranks error, and the ranking is the interesting half. A failed
 * evaluation whose statement has since been edited is not reporting the
 * current code's failure -- it is reporting a failure of code that is no
 * longer there, which is exactly the claim the stale marker exists to
 * withdraw. Leaving it red would assert that the line in front of the reader
 * raises, and that is a thing nobody has checked.
 */
export function markerFor(
  annotation: { readonly stale?: boolean; readonly error?: unknown }
): Marker {
  if (annotation.stale) {
    return 'stale';
  }
  return annotation.error === undefined ? 'evaluated' : 'error';
}

/**
 * A statement's source folded to what a re-run would actually notice.
 *
 * Leading and trailing whitespace goes, per line, and blank lines go with it.
 * The rule is JupyterLab's, arrived at in review of the same feature: a cell
 * is not marked dirty when only its surrounding whitespace changed, "because
 * this wouldn't change the cell execution result". Reindenting a block,
 * deleting a trailing space, or letting a formatter run on save would
 * otherwise turn a screenful of markers amber at once -- and the first time
 * that happens the marker stops being believed, which costs more than the
 * handful of edits it lets through.
 *
 * Deliberately not more clever than that. Folding `x=1` and `x = 1` together
 * would need a tokeniser, and every extra thing folded together is another
 * real change that goes unmarked. Over-marking is the cheap mistake here.
 */
export function normalizeSource(text: string): string {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join('\n');
}

/**
 * How an annotation stands after an edit rewrote the lines it sits on.
 *
 * `current` is those lines as the document holds them now, already through
 * `normalizeSource`. Three answers, in the order they are decided:
 *
 * 1. Already stale stays stale. This is the undo case, and it is the point of
 *    the whole ticket rather than an edge of it: putting the text back does
 *    not put the value back, because the kernel still holds whatever it was
 *    last told. A marker that cleared itself on undo would be claiming
 *    agreement nobody verified.
 * 2. Unchanged text stays evaluated -- the whitespace rule above.
 * 3. Anything else is stale, including an annotation with no recorded source.
 */
export function afterEdit<T extends Traced>(annotation: T, current: string): T {
  if (annotation.stale) {
    return annotation;
  }
  if (annotation.source !== undefined && annotation.source === current) {
    return annotation;
  }
  return { ...annotation, stale: true };
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

/**
 * Restate an annotation whose lines an edit rewrote where they stood.
 *
 * Separated from the arithmetic because deciding it needs the document's text
 * and this module has no document. `afterEdit` is what the caller wraps.
 */
export type Rewrite<T> = (annotation: T) => T;

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
 * Four cases now, and the first two are where the ticket lives.
 *
 * An annotation whose lines the edit **rewrote in place** is kept and handed
 * to `rewrite`, which marks it stale. Taking the value away instead -- what
 * this did before -- looks like caution and is the opposite: the kernel still
 * holds the old binding either way, and an empty line says nothing about that
 * while an amber marker says exactly it. CIDER has done this since long before
 * anyone wrote it down here: the fringe marker beside an evaluated form turns
 * amber when the form is edited, meaning *out of sync with what the REPL has*
 * rather than *wrong*.
 *
 * An annotation the edit **cut lines out of or pasted lines into** is still
 * dropped. There is no longer a statement for the value to sit beside -- half
 * of one, or somebody else's -- and a value pinned to code that did not
 * produce it is the failure this project treats as worst. The line count is
 * how that is told apart from a rewrite, which is why `lineDelta` decides it.
 *
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
  annotations: readonly T[], change: TextChange, shift: Shift<T>,
  rewritten: Set<T> | undefined
): readonly T[] {
  const delta = lineDelta(change);
  const kept: T[] = [];
  let touched = false;

  for (const annotation of annotations) {
    if (overlaps(annotation, change)) {
      if (delta !== 0 || rewritten === undefined) {
        touched = true;
        continue;
      }
      // Kept where it is, and remembered rather than marked: the mark is
      // decided once every change has been applied, when the range is final.
      rewritten.add(annotation);
      kept.push(annotation);
      continue;
    }
    // Not overlapping leaves only two places to be: entirely above the edit,
    // or entirely below it.
    if (delta !== 0 && annotation.range.start.line > change.range.end.line) {
      const moved = shift(annotation, delta);
      if (rewritten?.delete(annotation)) {
        // A multi-cursor edit can rewrite one statement and add lines above
        // it. The moved copy is a different object and has to inherit the
        // membership, or the mark is lost.
        rewritten.add(moved);
      }
      kept.push(moved);
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
 * Returns the input array by identity when no annotation was dropped, moved or
 * marked, so the caller can skip the repaint.
 *
 * Without `rewrite` an annotation the edit rewrote is dropped, which is the
 * older and blunter answer. It is kept as the default for callers with no way
 * to judge staleness -- judging it needs the document's text, and the array is
 * all this module has.
 */
export function reanchor<T extends Anchored>(
  annotations: readonly T[],
  changes: readonly TextChange[],
  shift: Shift<T>,
  rewrite?: Rewrite<T>
): readonly T[] {
  const rewritten = rewrite && new Set<T>();
  let current = annotations;
  // Sorted on a copy: the event's array is the editor's, not ours to reorder.
  for (const change of [...changes].sort(lastFirst)) {
    current = reanchorOne(current, change, shift, rewritten);
  }
  if (!rewrite || !rewritten || rewritten.size === 0) {
    return current;
  }

  // Last, and deliberately: `rewrite` compares an annotation against the lines
  // it occupies *now*, and only here are the ranges final. Deciding inside the
  // loop would read the wrong lines whenever a second cursor added or removed
  // some further up the file.
  let changed = false;
  const settled = current.map((annotation) => {
    if (!rewritten.has(annotation)) {
      return annotation;
    }
    const next = rewrite(annotation);
    changed ||= next !== annotation;
    return next;
  });
  // A whitespace-only edit reaches here having marked nothing, and must not
  // cost a repaint either.
  return changed ? settled : current;
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
