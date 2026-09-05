/**
 * Turning a `repr()` into the string that gets painted after a line.
 *
 * Pure on purpose: this is the part with a right answer that can be checked
 * without an editor, and the part with the one non-obvious rule.
 */

import { BindingTrace, LoopTrace, NamedValue } from '../kernel/protocol';

/** Reads as annotation rather than as code the user wrote. */
export const SEPARATOR = '=>';

/**
 * What separates one `name: value` from the next.
 *
 * Wide enough to read as a break between two answers rather than as one long
 * one, narrow enough that a line carrying three of them still fits. Rider
 * separates its inline values the same way -- by a gap, with no delimiter and
 * no chip -- and it turns out to read better than the punctuation would.
 */
export const GAP = '   ';

const NBSP = ' ';

/**
 * VS Code collapses runs of ordinary spaces in a decoration's `contentText`.
 *
 * Without substituting non-breaking spaces, `{'a': 1, 'b': 2}` renders as
 * `{'a':1,'b':2}` and a padded or aligned value loses its shape entirely --
 * the annotation stops being a faithful `repr()` and starts being an
 * approximation of one. Calva hit this and solves it the same way; it looks
 * like a mistake to anyone who has not.
 */
export function preserveSpacing(text: string): string {
  return text.replace(/ /g, NBSP);
}

/**
 * A decoration is one line. A `repr()` containing newlines -- a dataclass, a
 * DataFrame -- would otherwise render as undefined behaviour rather than as
 * anything readable.
 *
 * Collapsing is the minimum that keeps it truthful; #12 gives long and
 * multi-line values a proper treatment with the full text on hover.
 */
export function collapseLines(text: string): string {
  return text.replace(/\r?\n/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

/**
 * A bare or dotted identifier -- something that now exists in the namespace,
 * as opposed to an expression that is already on screen.
 */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;

/**
 * Thousands separators, without asking the host what locale it is in.
 *
 * `toLocaleString()` would render `9,994` here and `9.994` on a German
 * machine, which makes the count ambiguous next to a Python `repr()` and
 * makes the test for it depend on where it runs.
 */
function grouped(count: number): string {
  return String(count).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * A loop's iterations on one line: `1, 2, 3, … (+9,994 more) … 10000`.
 *
 * The elision is what makes this safe to paint at all. Ten thousand values
 * would not fit and would not be read; the first few say what the loop starts
 * with, the last says where it ended up -- which for a loop stopped by
 * `break` is the value it broke on, the thing you were looking for -- and the
 * count in between says how much is not being shown, so the summary never
 * pretends to be the whole run.
 *
 * A loop that ran zero times says so. It is a real and easily missed answer:
 * the target is left holding whatever a previous run put there, so "the
 * sequence was empty" and "the sequence ended at 4" look identical otherwise.
 */
export function sequenceText(loop: LoopTrace): string {
  if (loop.count === 0) {
    return '(no iterations)';
  }
  const shown = loop.values.map(collapseLines);
  if (loop.last === null) {
    return shown.join(', ');
  }
  const elided = loop.count - loop.values.length - 1;
  const tail = collapseLines(loop.last);
  return elided > 0
    ? `${shown.join(', ')}, … (+${grouped(elided)} more) … ${tail}`
    : [...shown, tail].join(', ');
}

/**
 * One name the loop's body bound, and the sequence it took: `u: 4, 8, 12`.
 *
 * Rendered by exactly the same rule as the target's sequence, and separately
 * from it. The two are not columns of one table -- an iteration that hit
 * `continue` computed no result, so `v: 1, 2, 3   u: 4, 12` is a correct
 * annotation of a filter loop rather than a dropped value. Anything that
 * zipped them, or padded the shorter one, would invent an observation.
 */
export function bindingText(binding: BindingTrace): string {
  return `${binding.name}: ${sequenceText(binding)}`;
}

/**
 * The painted annotation for a successful evaluation.
 *
 * Several `name: value` pairs on one line, following Rider's inline values
 * rather than one value per statement. One value per statement is right for a
 * binding and has nothing to say for everything else, which is most lines:
 * `print("y unaffected by rebind:", y)` produced `None`, and `None` is not an
 * answer on the line whose whole point is `y`.
 *
 * Three rules decide what ends up where.
 *
 * **A binding leads; a result follows.** `lst: [1, 2, 3]` is what the line
 * did, so it goes first and the names it read follow it. An expression's
 * result is what those reads produced, so it goes last.
 *
 * **`=>` survives only for a genuine expression.** `sum([10, 20])` stays
 * `=> 30`; labelling it `sum([10, 20]): 30` would repeat the line back at the
 * reader and crowd out the only new information on it.
 *
 * **A produced `None` gives way to anything else on the line.** `y.append(4)`
 * changed `y` and returned nothing, which is the shape of every mutating
 * method in Python, and the `None` adds nothing the reader has not already
 * read to its left. It survives where there is nothing else: `d.get('missing')`
 * on its own really did answer `None`. The suppressed value is not lost -- the
 * hover still carries it, the third use of the same shelf.
 *
 * A loop displaces `value` with its whole sequence: `p: 1, 2, 3, 4` rather
 * than `p: 4`. `value` is still the last iteration, so a caller that ignores
 * the trace shows something true rather than nothing.
 *
 * **What the loop's body bound goes between the two**, which is where the
 * reader was already finding it -- `for v in x:` with `u = 4 * v` inside
 * annotates `v: 1, 2, 3   u: 4, 8, 12   x: [1, 2, 3]`. The order follows the
 * same rule the rest of the line does: what the statement did, then what it
 * read. The difference is that `u` used to be one value from the namespace
 * sitting beside a history, and is now the history it actually took.
 */
export function resultText(
  value: string | null, display?: string | null, loop?: LoopTrace | null,
  names?: readonly NamedValue[], bindings?: readonly BindingTrace[]
): string {
  const bound = (bindings ?? []).map(bindingText);
  const pairs = (names ?? []).map(
    (each) => `${each.name}: ${collapseLines(each.value)}`);
  const produced = loop
    ? sequenceText(loop)
    : value === null ? null : collapseLines(value);
  const binds = display !== undefined && display !== null
    && IDENTIFIER.test(display);
  // A loop's sequence is what the statement did, whatever its target unparses
  // to, so it leads even where `(key, value)` is too much of an expression to
  // label with.
  const leads = binds || Boolean(loop);

  if (produced === null
      || (!leads && produced === 'None' && pairs.length > 0)) {
    return preserveSpacing([...bound, ...pairs].join(GAP));
  }
  const slot = `${binds ? `${display}:` : SEPARATOR} ${produced}`;
  return preserveSpacing(
    (leads ? [slot, ...bound, ...pairs] : [...bound, ...pairs, slot])
      .join(GAP));
}

function iterations(count: number): string {
  return `${count} iteration${count === 1 ? '' : 's'}`;
}

/**
 * Why a binding's sequence is shorter than the loop it belongs to, if it is.
 *
 * Two different shortenings, and telling them apart is the whole point: a name
 * that never changed was recorded every time and is shown once, and a name
 * bound on fewer iterations than the loop ran was genuinely not computed on
 * the others. Silence when neither applies -- the sequence speaks for itself.
 */
function bindingNote(
  binding: BindingTrace, loop?: LoopTrace | null
): string {
  if (loop && binding.count !== loop.count) {
    return ` (bound on ${binding.count} of ${iterations(loop.count)})`;
  }
  return binding.constant
    ? ` (unchanged over ${iterations(binding.count)})`
    : '';
}

/**
 * The full text for the hover, where there is room for what the line elides.
 *
 * One place rather than two: the cursor path and the file-load path both need
 * it, and a hover that says something different depending on which command
 * produced it is a bug nobody would think to look for.
 *
 * This is where a suppressed `None` goes, and it is why suppressing it is not
 * the same as throwing it away:
 *
 *     inline:  y: [1, 2, 3, 4]
 *     hover:   y.append(4) = None
 *              y = [1, 2, 3, 4]
 *
 * The beginner trap that protects -- `y = y.append(4)` silently binding None
 * -- is real, and is learned exactly once. After that it is noise on every
 * mutating call for the rest of a career, which is what the hover is for.
 */
export function hoverText(
  display: string | null | undefined, value: string | null,
  loop?: LoopTrace | null, names?: readonly NamedValue[],
  bindings?: readonly BindingTrace[]
): string {
  const lines: string[] = [];
  if (loop) {
    const sequence = sequenceText(loop);
    lines.push(display ? `${display} = ${sequence}` : sequence);
    lines.push(iterations(loop.count));
  } else if (value !== null) {
    lines.push(display ? `${display} = ${value}` : value);
  }
  for (const each of bindings ?? []) {
    // Where the line's two elisions are spelled out. A binding shown once is
    // either one iteration's work or a value that never changed, and a
    // sequence shorter than the loop's is a body that took an early exit --
    // both look like the same short answer inline, and the difference is
    // exactly what someone hovering is asking about.
    lines.push(
      `${each.name} = ${sequenceText(each)}${bindingNote(each, loop)}`);
  }
  for (const each of names ?? []) {
    // The untouched repr where there is one, on the same terms as the value
    // above it: describing hides nothing, it only moves it here.
    lines.push(`${each.name} = ${each.repr ?? each.value}`);
  }
  return lines.join('\n');
}

/**
 * The painted annotation for a failure: type and message, never the
 * traceback. The traceback goes on hover, where it does not shove the code
 * sideways.
 */
export function errorText(type: string, message: string): string {
  const summary = collapseLines(message);
  return preserveSpacing(summary ? `${SEPARATOR} ${type}: ${summary}` : `${SEPARATOR} ${type}`);
}

/**
 * How wide `text` is on screen, in columns.
 *
 * Not `text.length`: a tab is worth however many columns it takes to reach
 * the next tab stop, so a file indented with tabs would otherwise align to a
 * column that is nowhere near where its code actually ends.
 */
export function columnWidth(text: string, tabSize: number): number {
  let column = 0;
  for (const character of text) {
    column += character === '\t' ? tabSize - (column % tabSize) : 1;
  }
  return column;
}

/**
 * Columns of gap between the end of a line and its annotation.
 *
 * A line already past the target gets `minimumGap` instead of being dragged
 * further right. Aligning to the longest line in the file would let one long
 * statement push every other result off the screen -- the ragged case is the
 * cheap one to accept.
 */
export function alignmentGap(
  lineWidth: number, targetColumn: number, minimumGap: number
): number {
  if (targetColumn <= 0) {
    return minimumGap;
  }
  return Math.max(targetColumn - lineWidth, minimumGap);
}
