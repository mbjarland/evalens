import { Position, StatementSpan } from './kernel/protocol';

/**
 * Where the next press of Evaluate and Advance leaves the cursor.
 *
 * Separated from the editor because the decision is arithmetic over ranges the
 * kernel already reported, and the interesting cases -- a `def` with a ten-line
 * body, a comment inside a list literal, the last statement in the file -- are
 * all reachable without an editor to open.
 *
 * **The step is a statement, not a line.** That is the whole feature: the tool
 * evaluates statements, so walking it by anything else means a `def` with a
 * ten-line body costs eleven presses and ten of them evaluate the same `def`
 * again. Blank lines and comments fall out of the same rule rather than being
 * special-cased away -- they are not statements, so there is nothing to stop
 * on.
 *
 * No `vscode` import: this is a decision about a parse tree and some line text.
 */

export type Advance =
  /** Put the cursor here, and scroll it into view. */
  | { readonly kind: 'move'; readonly position: Position }
  /**
   * There is no statement after this one.
   *
   * Deliberately not a wrap to the top: the user has just finished walking the
   * file, and answering that by re-running it from the first line would re-run
   * every side effect they had just decided to trigger once.
   */
  | { readonly kind: 'end' };

/** Is this line, on its own, a comment? A trailing `# ...` is not. */
function isComment(lineText: (line: number) => string, line: number): boolean {
  return line >= 0 && lineText(line).trimStart().startsWith('#');
}

/**
 * Does a comment block *begin* here?
 *
 * Blocks rather than lines, so a six-line explanatory paragraph is one stop
 * and not six. It also makes the rule self-terminating: standing on the first
 * line of a block, every later line of that block has a comment above it and
 * is therefore not a beginning, so the next press leaves the block instead of
 * crawling down it.
 */
function startsComment(
  lineText: (line: number) => string, line: number
): boolean {
  return isComment(lineText, line) && !isComment(lineText, line - 1);
}

/** The column the first non-blank character sits in. */
function indentOf(text: string): number {
  return text.length - text.trimStart().length;
}

/**
 * The next stop after `cursorLine`, given every top-level statement in the file.
 *
 * `stopAtComments` is the `evalens.advanceSkipsComments` setting, inverted at
 * the call site: on by default, the walk passes the paragraph that explains the
 * statement it is about to run.
 */
export function nextStop(
  statements: readonly StatementSpan[],
  cursorLine: number,
  lineText: (line: number) => string,
  stopAtComments = false
): Advance {
  // Stepping starts from the END of the statement the cursor is in, which is
  // what makes a multi-line statement one press rather than one press per
  // line. A cursor that is in no statement at all -- a blank line, a comment,
  // the header of the file -- steps from where it stands.
  const here = statements.find(
    (statement) => statement.range.start.line <= cursorLine
      && cursorLine <= statement.range.end.line);
  const from = here ? here.range.end.line : cursorLine;

  // Strictly after, so two statements written on one line (`a = 1; b = 2`)
  // are one stop. A cursor gives a line and resolution is line-based, so
  // stopping there twice would evaluate the first of them twice and never
  // reach the second.
  const next = statements.find(
    (statement) => statement.range.start.line > from);
  if (!next) {
    return { kind: 'end' };
  }

  if (stopAtComments) {
    // Only between statements. Everything from `from` to the next statement is
    // outside every statement in the file, so a `#` here cannot be inside a
    // string literal -- which is exactly the mistake a text scan makes when it
    // is allowed to look anywhere.
    for (let line = from + 1; line < next.range.start.line; line += 1) {
      if (startsComment(lineText, line)) {
        return {
          kind: 'move',
          position: { line, character: indentOf(lineText(line)) },
        };
      }
    }
  }

  // The start of the statement, not its anchor line: the anchor is where the
  // value gets written, which for a multi-line assignment is its last line.
  // Landing there would put the cursor at the far end of the statement it is
  // about to run.
  return { kind: 'move', position: next.range.start };
}

/** What is already known about a document's shape, and from which version. */
export interface OutlineCache {
  readonly key: string;
  readonly version: number;
  readonly statements: readonly StatementSpan[];
}

/** What `statementsOf` should do about asking for a fresh outline. */
export type OutlinePlan =
  /** Use these -- current, or the best that is known while the kernel cannot
   * be asked. */
  | { readonly kind: 'cached'; readonly statements: readonly StatementSpan[] }
  /** Nothing costs asking: send a fresh `outline` request. */
  | { readonly kind: 'fetch' }
  /** Nothing is known, and nothing can safely be asked right now. */
  | { readonly kind: 'unknown' };

/**
 * Whether to ask the kernel for a fresh outline before computing the next
 * stop, or to make do with whatever is already known.
 *
 * Asking is free when the kernel is idle -- nothing runs, so `outline`
 * answers at once. It is not free when the kernel is busy with a statement
 * dispatched earlier, because `outline` travels on the same request channel
 * as `eval` and that channel is read by one thread that services one request
 * at a time (`evalens_kernel.py`'s `main`). If the earlier statement is
 * itself blocked on `input()`, that channel does not free up until someone
 * answers a prompt for a line the cursor may have already left -- #90 found
 * Evaluate and Advance hanging exactly there, with nothing on screen to say
 * why.
 *
 * So a busy kernel is never asked. What is already cached is used even when
 * it is stale for this document version, because a file's statement
 * boundaries rarely move between one keypress and the next, and a next-stop
 * guess landing one line off costs far less than a keypress that silently
 * does nothing. Only a document this session has never outlined, asked about
 * while the kernel is busy, comes back `unknown` -- there is nothing to fall
 * back to, and nothing safe to ask for.
 */
export function outlinePlan(
  cache: OutlineCache | undefined, key: string, version: number, busy: boolean
): OutlinePlan {
  if (cache?.key === key && cache.version === version) {
    return { kind: 'cached', statements: cache.statements };
  }
  if (busy) {
    return cache?.key === key
      ? { kind: 'cached', statements: cache.statements }
      : { kind: 'unknown' };
  }
  return { kind: 'fetch' };
}
