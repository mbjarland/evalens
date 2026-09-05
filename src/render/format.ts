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

/**
 * What the line calls the stdout a statement wrote.
 *
 * A word rather than a glyph, and this word rather than `stdout`. The
 * annotation already reads `<label>: <value>` -- `x: [1, 2, 3]` for a binding,
 * `v: 1, 2, 3` for a loop target -- so output is another label in the same
 * grammar and there is nothing new to learn. `printed` is what a first-year
 * student literally did; `<stdout>` is jargon they have not met, and for
 * beginner code the two mean the same thing anyway.
 *
 * Bare output would have been ambiguous in a worse way than it looks:
 * annotating `print("hello")` with `hello` invites the reader to conclude the
 * expression *evaluated to* `hello`, which is the display asserting the wrong
 * kind of thing.
 *
 * A glyph was measured rather than argued about. `»` `›` `·` `|` exist in
 * Menlo, SF Mono, Monaco and Courier New; `▸` `▶` `⏎` are missing from Monaco
 * and Courier New, and the failure there is not a tofu box -- VS Code
 * substitutes from a fallback font, so the marker renders at a different
 * advance width and misaligns exactly the lines it exists to clarify. `»` is
 * available to anyone who wants it terse, through `evalens.printedLabel`.
 */
export const PRINTED_LABEL = 'printed';

/**
 * And what it calls stderr, which keeps the term.
 *
 * Writing to stderr is not a beginner action, and anyone doing it knows what
 * it is called. It is emphatically not a failure: a library logging a warning
 * painted in the error colour would teach a student to fear a line that
 * worked, so this is a label and never a colour.
 */
export const STDERR_LABEL = 'stderr';

/**
 * The caveat on a value computed without the rest of the file.
 *
 * A value from a reduced context is a weaker claim than a value from the whole
 * file, and painting the two identically would make every annotation on screen
 * mean "one of these two things". So it is said on the line, every time -- and
 * with the line number, because the first question it raises is *which* part
 * of the file was missing. The number is 1-based: it is for a human reading a
 * gutter, not for an index.
 *
 * Short on purpose. It appears beside an ordinary answer, and the rest of the
 * story is two places the reader already has -- the hover, and the error
 * painted in red on the broken line itself.
 */
export function partialNote(truncatedAt: number): string {
  return `(partial: line ${truncatedAt + 1})`;
}

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
 * What a statement wrote while it ran, ready to be painted.
 *
 * The kernel has captured both streams since it first redirected them -- it
 * has to, or a `print()` would corrupt the protocol -- and for a long time
 * nothing looked at them, so evaluating `print("hello")` painted `None` and
 * threw `hello` away. For the audience this is built for, `print()` is not one
 * feature among many; it is the tool.
 *
 * `label` is the shell's to supply, because it comes from a setting and this
 * module has no editor to ask.
 *
 * A statement that printed and then *raised* is deliberately not covered
 * here: its line keeps the error, and what it managed to print is in the
 * output channel where it already arrived live. Putting output on the error
 * annotation would paint it in the error colour, which is the one thing this
 * feature must not do.
 */
export interface Printed {
  readonly stdout?: string;
  readonly stderr?: string;
  /** What to call stdout here; `PRINTED_LABEL` when nobody said otherwise. */
  readonly label?: string;
}

/** The streams as a `Printed`, or nothing when neither was written to. */
export function printedFrom(
  stdout?: string, stderr?: string
): Printed | undefined {
  const out = stdout ?? '';
  const err = stderr ?? '';
  if (out === '' && err === '') {
    return undefined;
  }
  return { ...(out === '' ? {} : { stdout: out }),
    ...(err === '' ? {} : { stderr: err }) };
}

/** Each stream that was written to, labelled, stdout first. */
function streamsOf(printed?: Printed): [string, string][] {
  const streams: [string, string][] = [];
  if ((printed?.stdout ?? '') !== '') {
    streams.push([printed!.label ?? PRINTED_LABEL, printed!.stdout!]);
  }
  if ((printed?.stderr ?? '') !== '') {
    streams.push([STDERR_LABEL, printed!.stderr!]);
  }
  return streams;
}

/** Did the statement write anything worth a piece of its own? */
export function hasOutput(printed?: Printed): boolean {
  return streamsOf(printed).length > 0;
}

/**
 * What kind of thing one run of an annotation is, and therefore what colour
 * it takes.
 *
 * The rule is one sentence -- **labels are chrome, values are content** --
 * and chrome comes in two kinds:
 *
 * - `value` is every `repr()` the program produced: the statement's own value
 *   after `=>`, each name's value, each value in a loop's sequence, and **the
 *   text a statement printed**. Output is something the program made rather
 *   than something this extension wrote around it, which is what keeps the
 *   rule learnable in one sentence: a reader scanning for "what did my code
 *   actually produce" finds one colour, everywhere, output included.
 * - `nameLabel` is what this extension wrote to introduce a value: `x:`, the
 *   `=>` separator, the gap between two pieces, the `…+N more` footnote and
 *   the reduced-context caveat.
 * - `streamLabel` is `printed:` and `stderr:`, and nothing else. Output is a
 *   different kind of thing from state, so its label leaves the hue family
 *   the other two share -- and it is emphatically not an error colour, for
 *   the reason `STDERR_LABEL` gives.
 *
 * An elision stays part of the value it shortens. `…(3 lines)` after a print
 * and `… (+9,994 more) …` inside a loop's sequence describe the shape of what
 * the program produced rather than label it, so the split always falls in the
 * same place: the punctuation this extension wrote is the label, and every
 * character after it is what ran.
 */
export type SegmentRole = 'value' | 'nameLabel' | 'streamLabel';

/** One run of an annotation that takes one colour. */
export interface Segment {
  readonly role: SegmentRole;
  readonly text: string;
}

/** Something this extension wrote to introduce a value. */
function asLabel(text: string): Segment {
  return { role: 'nameLabel', text };
}

/** Something the program produced. */
function asValue(text: string): Segment {
  return { role: 'value', text };
}

/**
 * The segments as the one string they used to be.
 *
 * Kept as the definition of what the segments say, rather than as a second
 * implementation of it. Painting several `after` attachments at one position
 * is not officially supported by VS Code -- the ordering between them is a
 * tie-break on a generated class name -- so the single-colour rendering has to
 * remain a working path that a patch release can fall back to. It is also
 * what makes the alignment column safe to reason about: however the segments
 * are painted, the width they add up to is the width of this string.
 */
export function joinSegments(segments: readonly Segment[]): string {
  return segments.map((segment) => segment.text).join('');
}

/**
 * The pieces of an annotation, with a gap between each two.
 *
 * The gap is chrome like every other separator, and it is the reason a piece
 * is a list rather than a pair: `printed: hello` is a stream label and a
 * value, and what sits between it and the piece before is neither.
 */
function spaced(pieces: readonly (readonly Segment[])[]): Segment[] {
  const segments: Segment[] = [];
  for (const piece of pieces) {
    if (segments.length > 0) {
      segments.push(asLabel(GAP));
    }
    segments.push(...piece);
  }
  return segments;
}

/**
 * `printed: hello`, or `printed: hello …(3 lines)` when there was more.
 *
 * One line of output IS the annotation -- the user wrote the line to see
 * something, so the thing it showed is the answer. Several lines cannot be,
 * because a decoration is one line, so the first one leads and the count says
 * how much is not on screen. Nothing is lost: the whole text is on the hover
 * and in the output channel, and the count is what stops the summary
 * pretending to be the whole of it. Elision by first-plus-count is the rule a
 * loop's sequence already follows.
 *
 * The trailing newline `print` writes is how a line ends, not a line of its
 * own -- counting it would report every one-line `print` as two.
 *
 * A blank line is named rather than left as an empty label. `print()` on its
 * own is a thing beginners write, and `printed:` followed by nothing reads as
 * a bug in the extension rather than as the answer.
 */
function streamPiece(label: string, text: string): readonly Segment[] {
  const lines = text.replace(/\r?\n$/, '').split(/\r?\n/);
  const first = collapseLines(lines[0] ?? '');
  const head = first === '' ? '(blank line)' : first;
  const summary = lines.length > 1
    ? `${head} …(${lines.length} lines)`
    : head;
  // A word takes the colon the rest of the grammar uses; a glyph does not,
  // because `»: hello` stacks punctuation on punctuation for no gain.
  const said = `${label}${/[A-Za-z0-9]$/.test(label) ? ':' : ''} `;
  // The label is the extension's word for the stream; everything after it is
  // what the program wrote, elision and all.
  return [{ role: 'streamLabel', text: said }, asValue(summary)];
}

/**
 * The output pieces a line carries, stdout first.
 *
 * Both streams can be present at once and each keeps its own label, so a
 * statement that printed and warned says both without either being mistaken
 * for the other.
 */
export function outputPieces(printed?: Printed): string[] {
  return streamsOf(printed).map(
    ([label, text]) => joinSegments(streamPiece(label, text)));
}

/**
 * A bare or dotted identifier -- something that now exists in the namespace,
 * as opposed to an expression that is already on screen.
 */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;

/** What a name may continue with, so a prefix match is not a partial one. */
const NAME_CHARACTER = /[A-Za-z0-9_]/;

/**
 * Python's own words for what a value is, which a description leads with.
 *
 * The label has to look past them: `def greet(name)` says `greet` in second
 * position, not first, and a check that only compared the opening characters
 * would go on printing `greet: def greet(name)` forever.
 */
const KEYWORDS = ['def ', 'class '];

/**
 * Does this value's text already say the name the label was going to?
 *
 * `greet: greet(name)` was two features colliding -- one labels a binding with
 * its name, the other describes a function as its signature -- and neither
 * knew about the other, so every function definition in every file stated its
 * name twice. The label is the half that can go: the description cannot,
 * because it is where the arguments are.
 *
 * The boundary check is the whole safety of it. `Record: class
 * SimpleNamespace(...)` keeps its label, because the alias is exactly the fact
 * the reader needs; and `n: n_squared` is not a name said twice, which a bare
 * `startsWith` would have called one.
 */
function namesItself(name: string, text: string): boolean {
  const keyword = KEYWORDS.find((word) => text.startsWith(word));
  const said = keyword === undefined ? text : text.slice(keyword.length);
  return said.startsWith(name)
    && !NAME_CHARACTER.test(said.charAt(name.length));
}

/** Whitespace folded to what a reader sees, so two spellings compare equal. */
function squeezed(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Does this annotation say only what the line it sits on already says?
 *
 * `def greet(name)` beside `def greet(name):` is tidier duplication rather
 * than information, and the evaluated-region highlight already reports that it
 * ran. So the annotation goes and the highlight stays.
 *
 * **Compared against the rendered text, never against the kind of statement.**
 * A `def` is exactly where this rule looks like it could be a shortcut, and
 * exactly where the shortcut would destroy the one case worth keeping:
 *
 *     @shout
 *     def greeting():        greeting: def <lambda>()
 *
 * The decorator *replaced* the function, the line cannot show that, and
 * skipping annotations by statement kind would have taken it away. What is
 * redundant is a piece of text, so text is what gets compared.
 *
 * Whitespace folds, a trailing `:` and a trailing comment are allowed to
 * follow, and nothing else is: a match has to be the whole line. Anything
 * looser starts suppressing annotations that differ from their line in ways
 * the fold cannot see, and an annotation wrongly shown costs a few columns
 * while one wrongly hidden costs the answer.
 */
export function restatesLine(text: string, line: string): boolean {
  // Painted text carries the non-breaking spaces `preserveSpacing` put in it;
  // the line it is compared against was typed with ordinary ones.
  const said = squeezed(text.split(NBSP).join(' '));
  const code = squeezed(line);
  if (said === '' || !code.startsWith(said)) {
    return false;
  }
  return /^\s*:?\s*(#.*)?$/.test(code.slice(said.length));
}

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
 * One thing an annotation puts on the line, before it becomes text.
 *
 * The breakdown is exported because the repeat rule has to know exactly what
 * a line paints for each name -- see `repeats.ts`. Working that out a second
 * time from `value`, `display`, `loop`, `names` and `bindings` would be a
 * copy of the rules in `paintedSlots`, and the two would disagree the first
 * time either changed.
 */
export interface Slot {
  /** The name this reports on, or null for a bare `=> value`. */
  readonly name: string | null;
  /** What is painted after it: a collapsed `repr()`, or a sequence. */
  readonly value: string;
  /**
   * Whether this is what the statement itself produced, rather than a name it
   * merely read. The distinction is the repeat rule's: a statement's own value
   * is the claim that this line did something, not context borrowed from
   * further up the file, so it is never suppressed as a repeat.
   */
  readonly own: boolean;
}

/**
 * What an annotation paints, in the order it paints it.
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
 *
 * **What it printed comes last, and never in place of anything.**
 * `x = compute()` where `compute` prints wants `x: 42` *and* the output: they
 * answer different questions, so neither displaces the other and the binding
 * still leads. Output is not a slot -- it names no name, so the repeat rule
 * has nothing to key it on -- and `resultText` appends it after these. What
 * it is here for is the one decision it does make: output displaces the
 * `None` a `print` returns, on exactly the rule a shown name already
 * displaces it -- there is something better on the line now, and the `None`
 * is one hover away. That decision has to be taken here, or the repeat rule
 * and the renderer would disagree about whether the line said `None`.
 */
export function paintedSlots(
  value: string | null, display?: string | null, loop?: LoopTrace | null,
  names?: readonly NamedValue[], bindings?: readonly BindingTrace[],
  printed?: Printed
): readonly Slot[] {
  // A body binding is part of what the statement did, so it counts as the
  // statement's own however many iterations it took.
  const bound: Slot[] = (bindings ?? []).map((each) => ({
    name: each.name, value: sequenceText(each), own: true,
  }));
  const pairs: Slot[] = (names ?? []).map((each) => ({
    name: each.name, value: collapseLines(each.value), own: false,
  }));
  const produced = loop
    ? sequenceText(loop)
    : value === null ? null : collapseLines(value);
  const target = display !== undefined && display !== null
    && IDENTIFIER.test(display)
    ? display
    : null;
  // A loop's sequence is what the statement did, whatever its target unparses
  // to, so it leads even where `(key, value)` is too much of an expression to
  // label with.
  const leads = target !== null || Boolean(loop);

  // The caveat goes last wherever it goes: it qualifies the whole line rather
  // than any one value on it.
  if (produced === null
      || (!leads && produced === 'None'
          && (pairs.length > 0 || hasOutput(printed)))) {
    return [...bound, ...pairs];
  }
  const slot: Slot = { name: target, value: produced, own: true };
  return leads ? [slot, ...bound, ...pairs] : [...bound, ...pairs, slot];
}

/**
 * How one slot is painted: `name: value`, or a bare `=> value` for a genuine
 * expression.
 *
 * **A label that the value already states is dropped.** `greet: def
 * greet(name)` says the name twice, so the annotation is `def greet(name)`.
 * The label survives wherever it is not a repetition -- `f: def greet(name)`
 * is the whole point of that line, and so is `Record: class
 * SimpleNamespace(...)`; see `namesItself`.
 *
 * Only what the statement itself produced or bound can lose its label. A name
 * the line merely *read* keeps it, because several of those sit side by side
 * and the label is the only thing telling the reader which is which.
 */
function slotSegments(slot: Slot): readonly Segment[] {
  if (slot.name === null) {
    return [asLabel(`${SEPARATOR} `), asValue(slot.value)];
  }
  // A dropped label leaves the value alone on the line, which is exactly
  // right: `def greet(name)` is what the statement produced, and there is no
  // longer any chrome in front of it to colour.
  return slot.own && namesItself(slot.name, slot.value)
    ? [asValue(slot.value)]
    : [asLabel(`${slot.name}: `), asValue(slot.value)];
}

/**
 * Everything an annotation is rendered from, named rather than counted.
 *
 * Named because the positional form had already produced a silent defect: the
 * signature grew one parameter per feature, a rebase moved `partialFrom` from
 * slot five to slot six when `bindings` landed between them, and five call
 * sites went on passing a line number where a binding list belonged. They
 * compiled -- both parameters are optional, and `undefined` is assignable to
 * anything -- so nothing caught it but a reader. With an object, the same
 * rebase produces a missing key rather than a plausible line.
 *
 * Shared with `hoverText` on purpose. The two render the same answer at two
 * lengths, and one shape for both means a field cannot mean one thing on the
 * line and another on the hover.
 */
export interface Rendered {
  /** The `repr()` the statement produced, or null when it produced none. */
  readonly value: string | null;
  /** The expression the value came from, for labelling. */
  readonly display?: string | null;
  /** Every value a loop's target held; displaces `value` when present. */
  readonly loop?: LoopTrace | null;
  /** What the names on the line held when it ran. */
  readonly names?: readonly NamedValue[];
  /** Every value the loop's body bound, per name. */
  readonly bindings?: readonly BindingTrace[];
  /** What the statement wrote to stdout and stderr, when it wrote anything. */
  readonly printed?: Printed;
  /** How many further names the kernel's per-line cap left off the line. */
  readonly more?: number;
  /** The 0-based line the file stopped parsing at, if it did. */
  readonly partialFrom?: number;
  /** The break that reduced the context, spelled out for the hover. */
  readonly partial?: {
    readonly truncated_at: number;
    readonly message: string;
  };
}

/**
 * The painted annotation for a successful evaluation, in the pieces that take
 * different colours.
 *
 * What the statement printed follows every value on the line, and `more` --
 * how many names the kernel's per-line cap left off -- follows that. Saying
 * so is the difference between an annotation that looks wrong and one that is
 * honest: a reader who counts five names on the line and four beside it
 * cannot otherwise tell whether the fifth was omitted, unreadable, or somehow
 * not a name. It is last of all, because it is a footnote about the line
 * rather than another thing on it.
 *
 * Segments rather than one string because CSS cannot colour part of a text
 * node, and one `after` attachment is one text node. Splitting the decision
 * from the painting keeps the decision here, where it is pure and can be
 * checked without an editor -- which matters more than usual, because the
 * painting side rests on behaviour VS Code does not document.
 */
export function resultSegments(rendered: Rendered): readonly Segment[] {
  const { value, display, loop, names, bindings, printed } = rendered;
  const more = rendered.more ?? 0;
  const partialFrom = rendered.partialFrom;
  const slots = paintedSlots(value, display, loop, names, bindings, printed);
  const painted: (readonly Segment[])[] = slots.map(slotSegments);
  painted.push(
    ...streamsOf(printed).map(([label, text]) => streamPiece(label, text)));
  // The footnote counts names, so it needs a name on the line to be a
  // footnote to. A line whose names were all dropped as repeats keeps its
  // output and loses the count with them: `printed: hello   …+1 more` reads
  // as a claim about the output -- one more line of it -- which is not what
  // the cap left off and not something this knows.
  if (more > 0 && slots.some((slot) => !slot.own)) {
    painted.push([asLabel(`…+${grouped(more)} more`)]);
  }
  // The caveat goes last of all: it qualifies the whole line -- every value on
  // it and both footnotes after them -- rather than any one thing on it. It is
  // a remark this extension is making, so it is chrome rather than a value.
  if (partialFrom !== undefined) {
    painted.push([asLabel(partialNote(partialFrom))]);
  }
  // Applied per segment rather than to the joined line, which comes to the
  // same string: it is a per-character substitution, and doing it here means
  // no caller can paint a segment that lost its spacing.
  return spaced(painted).map(
    (segment) => ({ ...segment, text: preserveSpacing(segment.text) }));
}

/** The same annotation as the one string it used to be. */
export function resultText(rendered: Rendered): string {
  return joinSegments(resultSegments(rendered));
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
export function hoverText(rendered: Rendered): string {
  const { display, value, loop, names, bindings, printed, partial } = rendered;
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
  // Last, in the order the line paints them, and whole -- this is where the
  // `…(3 lines)` on the line is redeemed. A one-line output is repeated here
  // rather than assumed read, because without it the hover for
  // `print("hello")` would say only `print("hello") = None` and read as a
  // contradiction of the line it belongs to.
  for (const [label, text] of streamsOf(printed)) {
    const written = text.replace(/\r?\n$/, '').split(/\r?\n/);
    if (written.length === 1) {
      lines.push(`${label}: ${written[0]}`);
    } else {
      lines.push(`${label}:`, ...written);
    }
  }
  if (partial) {
    // The full version of the inline `(partial: line 19)`, which is short
    // enough to raise the question without room to answer it. This is where
    // the answer goes: what was left out, and what stopped the parse.
    lines.push(
      `evaluated without line ${partial.truncated_at + 1} onwards`);
    lines.push(`SyntaxError: ${partial.message}`);
  }
  return lines.join('\n');
}

/**
 * The painted annotation for a failure: type and message, never the
 * traceback. The traceback goes on hover, where it does not shove the code
 * sideways.
 *
 * A failure under a reduced context carries the same caveat a value does, and
 * needs it more: the lines that were left out are the likeliest reason a name
 * is not defined, and a `NameError` that does not say so sends the reader
 * hunting for a typo that is not there.
 */
export function errorText(
  type: string, message: string, partialFrom?: number
): string {
  const summary = collapseLines(message);
  const shown = summary ? `${SEPARATOR} ${type}: ${summary}`
    : `${SEPARATOR} ${type}`;
  return preserveSpacing(partialFrom === undefined
    ? shown
    : [shown, partialNote(partialFrom)].join(GAP));
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
