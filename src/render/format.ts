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
 * `v ×3: 1, 2, 3` for a loop target -- so output is another label in the same
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
 *
 * #81: this used to be the *only* answer to "is `display` a binding", tested
 * against the display text itself, and it is wrong for exactly the targets
 * that do not read as a name -- `led['a']` for `led['a'] = 1`, which is no
 * less a binding than `x` is for `x = 1` and unparses with brackets rather
 * than letters. The resolver knows the true answer from the statement's own
 * shape (`Form.is_binding` in `resolver.py`) and the kernel now sends it, so
 * `paintedSlots` takes it as `isBinding` and asks this regex only when a
 * caller has not reached it yet -- see `paintedSlots` for exactly where that
 * fallback still applies and why it is not simply gone.
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
 * What is redundant is a piece of text, so text is what gets compared -- which
 * is what keeps
 *
 *     @shout
 *     def greeting():        greeting: def <lambda>()
 *
 * saying what the decorator produced. Whether a statement is *exempt* from the
 * question is a separate matter and is settled by the caller: see
 * `opensDefinition`, which is why a plain `def` reaches the screen even though
 * this answers true for it.
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
 * The three ways Python opens a statement that brings a name into existence.
 *
 * `async` qualifies `def` and nothing else here: `async for` and `async with`
 * are ordinary compound statements and are exempt from nothing.
 */
const DEFINITION = /^[ \t]*(?:async[ \t]+def|def|class)\b/;

/**
 * Does the line this annotation sits on open a definition?
 *
 * The exemption from `restatesLine`, and the whole of the ticket. `def
 * greet(name)` beside `def greet(name):` is the same characters and it is not
 * the same claim: the source says *when this runs, bind a function to this
 * name*, while the annotation says *a function of this signature exists now,
 * and `greet` refers to it*. Those coincide only once the line has actually
 * been evaluated -- which is the fact the reader cannot see, most needs, and
 * has nowhere else to get. A definition edited and not re-evaluated is the
 * classic hazard of working this way, and an inline annotation is the one
 * thing positioned to answer it.
 *
 * There is a teaching argument on top of it. `def` in Python is a statement
 * that runs and binds, not a declaration, and a tool whose whole thesis is
 * state made visible taught the opposite by showing nothing there.
 *
 * Without the exemption the family split on an accident of prefix matching:
 * `class Config()` escaped on its parentheses, `def gen(n) -> generator` on an
 * arrow that runs past the end of its own line, and the plain synchronous
 * function -- the one form a beginner writes on page one -- was the only thing
 * on screen that said nothing at all.
 *
 * **The line, never the annotation.** An object of the user's own whose
 * `repr()` begins with `def ` would collect an exemption that read the
 * rendered text, and that is precisely the class of defect this exists to
 * repair. What is read here is Python the user typed, anchored at the start of
 * the line.
 *
 * Read off the line rather than off the kernel's own word for the statement,
 * which is the one compromise here and is worth naming. The wire already
 * carries `"kind": "FunctionDef"`; what it does not have is a way to the
 * renderer, because every annotation is built from a response somewhere else
 * again, so keying on `annotation.kind` is a change across three files rather
 * than this one. Two shapes are invisible to a line and would not be to the
 * kind -- a signature wrapped over several lines, which anchors on its `):`,
 * and a `def` whose body opens with a comment, which anchors on the comment.
 * Neither costs anything today: a line like that is not a prefix of its own
 * annotation, so nothing was suppressing it in the first place.
 */
export function opensDefinition(line: string): boolean {
  return DEFINITION.test(line);
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
 * What says "this is a history of N moments," not a value that happens to
 * hold several.
 *
 * #36: beside `x = 16`, `p: 16` and, once a loop's sequence is rendered,
 * `p: 0, 1, 4, 9, 16` are still the same *shape* -- a label and a value --
 * and a comma-joined list reads as a tuple or a list, not as a trace of five
 * separate moments. The count is the cue, and it has to survive whatever the
 * font substitutes for it: measured in Menlo, SF Mono, Monaco and Courier
 * New the way `PRINTED_LABEL` above was, `↻`/`↺` exist only in Menlo, and
 * `⟳`/`⭮`/`⥁` exist in none of the four -- so the pretty loop arrows are all
 * disqualified except by the same default-only accident. `×` and `…`
 * measured clean in all four, and Python already uses `×` for exactly this
 * meaning outside code (`5×`, "five of these"), so the count is spelled
 * `p ×5: 0, 1, 4, 9, 16` -- two characters that exist wherever this renders,
 * reading correctly whether or not `sequenceText` had to elide anything.
 *
 * `evalens.loopGlyph` is meant to let this be overridden, for anyone whose
 * font does carry `↻`. Wiring a setting through touches `config.ts` and
 * `decorations.ts`, which belong to #99 and #23 respectively -- what is here
 * is the half `format.ts` owns: `Rendered.loopGlyph` already carries a
 * caller's choice down to this constant's only use, so the setting is
 * additive from here rather than a rework.
 */
export const LOOP_GLYPH = '×';

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
 * One name the loop's body bound, and the sequence it took:
 * `u ×3: 4, 8, 12`.
 *
 * Rendered by exactly the same rule as the target's sequence, and separately
 * from it. The two are not columns of one table -- an iteration that hit
 * `continue` computed no result, so `v ×3: 1, 2, 3   u ×2: 4, 12` is a
 * correct annotation of a filter loop rather than a dropped value: the two
 * counts differing is itself the fact that a filter ran. Anything that zipped
 * them, or padded the shorter one, would invent an observation.
 */
export function bindingText(binding: BindingTrace): string {
  return `${binding.name}${iterationLabel(binding.count, LOOP_GLYPH)}: `
    + sequenceText(binding);
}

/**
 * `" ×5"`, the count `slotSegments` and `bindingText` fold into a label --
 * or nothing, for a value that was only ever read once and so carries no
 * history to mark. `grouped` so a five-figure loop reads the way every other
 * large count on this line already does.
 */
function iterationLabel(count: number, glyph: string): string {
  return count > 0 ? ` ${glyph}${grouped(count)}` : '';
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
  /**
   * How many iterations this value's history covers, when it is one -- the
   * loop target's own count, or one of `bindings`'s. `sequenceText` is what
   * both of those are built from, and `undefined` for everything else this
   * paints: a name merely read, or a statement's own single value, was
   * observed once and carries nothing to count (#36).
   */
  readonly iterations?: number;
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
 * result is what those reads produced, so it goes last. Which one a
 * statement is comes from `isBinding` (#81) wherever a caller has it --
 * `led['a'] = 1` is exactly as much a binding as `x = 1` is, and unparsing
 * to `led['a']` rather than a bare name is not evidence otherwise.
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
 * A loop displaces `value` with its whole sequence: `p ×4: 1, 2, 3, 4` rather
 * than `p: 4`. `value` is still the last iteration, so a caller that ignores
 * the trace shows something true rather than nothing. The `×4` is the same
 * decision said in glyphs rather than commas -- see `LOOP_GLYPH` (#36): a
 * history and a value that happens to be a list are the same *shape* of
 * annotation and need a cue that tells them apart before either is read.
 *
 * **What the loop's body bound goes between the two**, which is where the
 * reader was already finding it -- `for v in x:` with `u = 4 * v` inside
 * annotates `v ×3: 1, 2, 3   u ×3: 4, 8, 12   x: [1, 2, 3]`. The order
 * follows the same rule the rest of the line does: what the statement did,
 * then what it read. The difference is that `u` used to be one value from
 * the namespace sitting beside a history, and is now the history it actually
 * took.
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

/**
 * Whether `display` names a place the statement bound, so `paintedSlots`
 * knows to lead with it rather than fall back to `=>` (#81).
 *
 * `undefined` here is not "no", it is "not asked yet" -- the wire's own
 * `is_binding` is present only when true (`Kernel._run` in
 * `evalens_kernel.py`), and a caller still on the identifier-shaped guess
 * this replaces has no opinion to offer at all, rather than an opinion of
 * `false`. `paintedSlots` therefore asks the regex only in that gap: once
 * every caller threads the flag through, `isBinding` is always `true` or
 * `false` and `IDENTIFIER` has nothing left to do. Until then, removing the
 * regex outright would relabel every `led['a'] = 1` in the shipped extension
 * as `led['a']: 1` and, the same day, every ordinary `x = 1` as `=> 1` for
 * any caller that has not been updated to pass the flag -- trading a narrow,
 * known bug for a total one.
 */
function isBoundTarget(
  display: string | null | undefined, isBinding: boolean | undefined
): display is string {
  return display !== undefined && display !== null
    && (isBinding ?? IDENTIFIER.test(display));
}

export function paintedSlots(
  value: string | null, display?: string | null, loop?: LoopTrace | null,
  names?: readonly NamedValue[], bindings?: readonly BindingTrace[],
  printed?: Printed, isBinding?: boolean
): readonly Slot[] {
  // A body binding is part of what the statement did, so it counts as the
  // statement's own however many iterations it took.
  const bound: Slot[] = (bindings ?? []).map((each) => ({
    name: each.name, value: sequenceText(each), own: true,
    ...(each.count > 0 ? { iterations: each.count } : {}),
  }));
  const pairs: Slot[] = (names ?? []).map((each) => ({
    name: each.name, value: collapseLines(each.value), own: false,
  }));
  const produced = loop
    ? sequenceText(loop)
    : value === null ? null : collapseLines(value);
  const target = isBoundTarget(display, isBinding) ? display : null;
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
  const slot: Slot = { name: target, value: produced, own: true,
    ...(loop && loop.count > 0 ? { iterations: loop.count } : {}) };
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
 *
 * **A slot with `iterations` folds the count into the same label** (#36):
 * `p ×5: 0, 1, 4, 9, 16` rather than `p: 0, 1, 4, 9, 16`, so the shape of a
 * loop's history reads differently from a single value's before either is
 * read. It goes wherever the label goes, and disappears with it: a value that
 * already names itself has no chrome left to carry the count either, which
 * is right -- nothing here has ever recorded a `def` or `class` running in a
 * loop's target.
 */
function slotSegments(slot: Slot, glyph: string): readonly Segment[] {
  const count = slot.iterations === undefined
    ? '' : iterationLabel(slot.iterations, glyph);
  if (slot.name === null) {
    return [asLabel(`${SEPARATOR}${count} `), asValue(slot.value)];
  }
  // A dropped label leaves the value alone on the line, which is exactly
  // right: `def greet(name)` is what the statement produced, and there is no
  // longer any chrome in front of it to colour.
  return slot.own && namesItself(slot.name, slot.value)
    ? [asValue(slot.value)]
    : [asLabel(`${slot.name}${count}: `), asValue(slot.value)];
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
  /**
   * Whether `display` names a place this statement bound, from the wire's
   * own `is_binding` -- present only when true, so `undefined` here means
   * "not sent" rather than "no" (#81). `undefined` falls back to guessing
   * from `display`'s own text, which is the whole defect this exists to
   * retire: see `isBoundTarget`.
   */
  readonly isBinding?: boolean;
  /** Every value a loop's target held; displaces `value` when present. */
  readonly loop?: LoopTrace | null;
  /** What the names on the line held when it ran. */
  readonly names?: readonly NamedValue[];
  /** Every value the loop's body bound, per name. */
  readonly bindings?: readonly BindingTrace[];
  /** What the statement wrote to stdout and stderr, when it wrote anything. */
  readonly printed?: Printed;
  /**
   * How many further names are not shown on this line -- the kernel's own
   * transport cap, the renderer's display cap applied after repeat
   * suppression (see `capNames` in `repeats.ts`), or both added together.
   */
  readonly more?: number;
  /** The 0-based line the file stopped parsing at, if it did. */
  readonly partialFrom?: number;
  /** The break that reduced the context, spelled out for the hover. */
  readonly partial?: {
    readonly truncated_at: number;
    readonly message: string;
  };
  /**
   * The glyph a loop's iteration count is shown with -- `LOOP_GLYPH` (`×`)
   * when absent. Exists so `evalens.loopGlyph` (#36) has somewhere to land:
   * this module reads the choice, it does not read the setting, the same
   * split `printed`'s `label` already makes for `evalens.printedLabel`.
   */
  readonly loopGlyph?: string;
  /**
   * How many graphemes a single value is shown in before `truncateValue`
   * cuts it -- `DEFAULT_MAX_VALUE_LENGTH` when absent. Exists so
   * `evalens.maxValueLength` (#12) has somewhere to land, on the same terms
   * as `loopGlyph` above: this module reads the width, a caller that knows
   * the editor's is free to pass a narrower one down.
   */
  readonly maxValueLength?: number;
}

/**
 * The kernel's own notice that a `repr()` was already cut to fit the wire --
 * `_capped` in `evalens_kernel.py`, reached once a value's `repr()` outgrows
 * `WIRE_REPR_LIMIT`. Detected so `truncateValue`'s own, shorter cut never
 * lands inside it: chopping "… <truncated from 50000 chars>" in half would
 * print a broken sentence carrying a count that belongs to neither cut,
 * which is exactly the defect #12 was filed to avoid, not merely to survive.
 */
const WIRE_TRUNCATION = /… <truncated from \d+ chars>$/;

/**
 * How many characters a value is shown in on the line before it is cut,
 * absent a narrower width from `Rendered.maxValueLength` or, eventually,
 * `evalens.maxValueLength` (#12).
 *
 * Chosen by running `bin/audit-corpus.js --listings` over a real first-year
 * course (`python-walkthrough`) and looking at what actually reaches this
 * width, rather than picking a round number: every value a reader would
 * want in full -- a six-tuple `deck` (102 characters), a grouped
 * `defaultdict` (103), a `namedtuple` signature (82) -- tops out under 105.
 * What crosses 120 in that corpus is a different kind of thing entirely: a
 * `dataclass` signature nobody asked for (171), and every bare `import`'s
 * absolute interpreter path (137-158). 120 sits in the gap between those two
 * clusters, so it catches the second without touching the first.
 */
export const DEFAULT_MAX_VALUE_LENGTH = 120;

/**
 * `text`, cut to `limit` graphemes with an explicit marker, or `text`
 * itself when it already fits.
 *
 * Grapheme clusters, not UTF-16 code units or code points (#12): a `repr()`
 * can legitimately contain an emoji, a flag, or a letter with a combining
 * accent, and a cut through the middle of one would produce a different,
 * broken character rather than a shorter version of the same string.
 *
 * A value the kernel already truncated at the wire is cut before its own
 * notice, never through it -- see `WIRE_TRUNCATION`. If what remains still
 * fits `limit`, the kernel's notice rides along exactly as it arrived; if it
 * does not, this function's own marker replaces it rather than standing
 * beside it, because two counts describing two different cuts on one value
 * would read as one count, and a wrong one.
 *
 * The marker never claims the number the value's own author would recognise
 * -- only how many graphemes this cut removed from what it was given, which
 * stays true whatever else already happened to the string before it arrived.
 */
export function truncateValue(text: string, limit: number): string {
  const body = text.replace(WIRE_TRUNCATION, '');
  const graphemes = [...new Intl.Segmenter().segment(body)]
    .map((each) => each.segment);
  if (graphemes.length <= limit) {
    return text;
  }
  const shown = graphemes.slice(0, limit).join('');
  const removed = graphemes.length - limit;
  return `${shown}… (+${grouped(removed)} more character${removed === 1 ? '' : 's'})`;
}

/** One piece with every `value` segment cut to `limit`; chrome untouched. */
function truncatedPiece(
  piece: readonly Segment[], limit: number
): readonly Segment[] {
  return piece.map((segment) => segment.role === 'value'
    ? { ...segment, text: truncateValue(segment.text, limit) }
    : segment);
}

/**
 * The shared count `paintedPieces` folds into one leading piece (#118), or
 * null when there is nothing worth folding.
 *
 * Three ways to be disqualified, and each is a different reason:
 *
 * - **Fewer than two slots carry a count.** Folding a single `×5` into its
 *   own leading piece is a net loss -- `×5   p: 1, 2, 3, 4, 5` is longer than
 *   `p ×5: 1, 2, 3, 4, 5` by exactly one gap, and the whole point of #118 is
 *   width. A solo loop keeps its inline count.
 * - **A slot carries no count at all.** A name merely read alongside a loop
 *   -- `for v in x: ...` leaves `x` sitting beside `v ×3` -- has nothing to
 *   do with the loop's own iteration count, and hoisting `×3` to the head of
 *   the line would put it where it reads as a claim about the whole line,
 *   `x` included. That over-claims by position rather than by text, which
 *   design rule 1 rules out exactly as firmly as a wrong word would.
 * - **The counts differ.** `for v in x: if v > 1: u = 4 * v` gives `v ×3`
 *   and `u ×2` -- the difference is itself the fact that a filter ran (see
 *   `bindingText`), and folding it away would erase the one thing the line
 *   is reporting.
 *
 * Only when every slot on the line carries the very same count does saying
 * it once, first, cost nothing and lose nothing.
 */
function sharedIterationCount(slots: readonly Slot[]): number | null {
  if (slots.length < 2 || slots.some((slot) => slot.iterations === undefined)) {
    return null;
  }
  const first = slots[0]!.iterations!;
  return slots.every((slot) => slot.iterations === first) ? first : null;
}

/**
 * The pieces `resultSegments` joins with a gap between each two, before that
 * gap goes in. A label and the value it introduces are one piece; `printed:`
 * and its text are one piece; the `…+N more` footnote and the reduced-context
 * caveat are each a piece of one segment. Factored out so `resultSegments`
 * and `resultGroups` (#95) are the same computation read two ways, rather
 * than two computations that can drift apart.
 *
 * What the statement printed follows every value on the line, and `more` --
 * how many further names are not shown, whether a cap left them off the wire
 * or the display cap left them off the line -- follows that. Saying so is the
 * difference between an annotation that looks wrong and one that is honest: a
 * reader who counts five names on the line and four beside it cannot
 * otherwise tell whether the fifth was omitted, unreadable, or somehow not a
 * name. It is last of all, because it is a footnote about the line rather
 * than another thing on it.
 *
 * Segments rather than one string because CSS cannot colour part of a text
 * node, and one `after` attachment is one text node. Splitting the decision
 * from the painting keeps the decision here, where it is pure and can be
 * checked without an editor -- which matters more than usual, because the
 * painting side rests on behaviour VS Code does not document.
 *
 * **#118: when `sharedIterationCount` finds one count common to every slot,
 * it leads as its own bare piece** -- `×3`, no name, no colon -- **and every
 * slot loses its own copy of it**, so `v ×3: 1, 2, 3   u ×3: 4, 8, 12`
 * becomes `×3   v: 1, 2, 3   u: 4, 8, 12`: the same fact, said once. This
 * runs only here, never inside `paintedSlots` itself -- `announce.ts` calls
 * `paintedSlots` directly for speech, where repeating "3 iterations" once per
 * clause costs nothing and the fold has no equivalent, so leaving the shared
 * function alone is what keeps the two channels from disagreeing about what
 * `paintedSlots` itself hands back.
 */
function paintedPieces(rendered: Rendered): readonly (readonly Segment[])[] {
  const { value, display, loop, names, bindings, printed, isBinding } = rendered;
  const more = rendered.more ?? 0;
  const partialFrom = rendered.partialFrom;
  const glyph = rendered.loopGlyph ?? LOOP_GLYPH;
  const limit = rendered.maxValueLength ?? DEFAULT_MAX_VALUE_LENGTH;
  const slots = paintedSlots(
    value, display, loop, names, bindings, printed, isBinding);
  const shared = sharedIterationCount(slots);
  // Cut here, once every piece has its final shape, rather than inside
  // `slotSegments` or `streamPiece`: those are shared with `announce.ts` (via
  // `paintedSlots` and `outputPieces`), which already caps what it says on
  // its own, more generous terms (`SPOKEN_LIMIT`) -- baking a column width
  // into a shared function would quietly tighten speech to match the line,
  // which is exactly the drift the split between the two channels exists to
  // prevent. Nothing here reaches `namesItself` either: that check ran
  // inside `slotSegments` against the whole value, before this shortens it,
  // so a dropped label stays dropped on the same evidence it always was.
  const painted: (readonly Segment[])[] = [
    ...(shared === null ? [] : [[asLabel(`${glyph}${grouped(shared)}`)]]),
    ...slots.map((slot) => slotSegments(
      shared === null ? slot : { ...slot, iterations: undefined }, glyph)),
    ...streamsOf(printed).map(([label, text]) => streamPiece(label, text)),
  ].map((piece) => truncatedPiece(piece, limit));
  // `more` is only ever positive because a cap left something off this exact
  // line -- see `Rendered.more` and `capNames` in `repeats.ts` -- so it never
  // needs a surviving name slot to justify it the way an earlier version of
  // this guard required. That version collapsed two different reasons a line
  // could show no names: there were never any to show, where `more` is
  // already zero and stays silent on its own, and every one of them was
  // suppressed as a repeat, where `more` can still be positive and was being
  // hidden anyway. Only the first should be quiet; `printed: hello   …+1
  // more` reads a little like a claim about one more line of output, but the
  // alternative -- a line that hid names and said nothing about it -- is the
  // worse of the two readings.
  if (more > 0) {
    painted.push([asLabel(`…+${grouped(more)} more`)]);
  }
  // The caveat goes last of all: it qualifies the whole line -- every value on
  // it and both footnotes after them -- rather than any one thing on it. It is
  // a remark this extension is making, so it is chrome rather than a value.
  if (partialFrom !== undefined) {
    painted.push([asLabel(partialNote(partialFrom))]);
  }
  return painted;
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
  // Applied per segment rather than to the joined line, which comes to the
  // same string: it is a per-character substitution, and doing it here means
  // no caller can paint a segment that lost its spacing.
  return spaced(paintedPieces(rendered)).map(
    (segment) => ({ ...segment, text: preserveSpacing(segment.text) }));
}

/**
 * The same pieces `resultSegments` joins, kept apart (#95).
 *
 * `resultSegments` is `joinSegments(resultGroups(r).flat())` with a `GAP`
 * segment inserted between every two groups; this is that computation with
 * the gap not yet inserted. It exists because the chip painted from these
 * groups needs the boundary before the gap is joined in, not one it can
 * recover afterwards: #95 painted each group as its own tinted box with the
 * gap between two of them left bare; #118 paints one continuous tinted box
 * for the whole annotation and turns that same boundary into the hairline
 * divider (`decorations.ts`'s `show`) instead. Either way the boundary is a
 * fact about where one group ends and the next begins, which only this
 * function still holds once `resultSegments` has joined it away.
 * `coalesce` (`layers.ts`) merges a gap into whichever same-role segment
 * sits next to it for economy, which is correct for a single continuous run
 * and wrong for a run of separately painted groups: it would paint the gap
 * inside the label it merged into. Every segment already carries its
 * non-breaking spacing, the same as `resultSegments`, and each group should
 * still be passed through `coalesce` on its own before it is painted --
 * merging within a group is still the economy it always was, only merging a
 * gap into a group is not.
 *
 * A line #118 hoists (see `sharedIterationCount`) adds one more group at the
 * front, holding nothing but the shared count: `[[{role: 'nameLabel', text:
 * '×3'}]]` ahead of `v: 1, 2, 3` and everything after it. It is a group like
 * any other here -- the divider before the first per-name group is what
 * separates it from `v`, exactly as one already separates `v` from `u`.
 */
export function resultGroups(rendered: Rendered): readonly (readonly Segment[])[] {
  return paintedPieces(rendered).map((piece) => piece.map(
    (segment) => ({ ...segment, text: preserveSpacing(segment.text) })));
}

/**
 * Does this group, one of `resultGroups`' own, say what a statement wrote to
 * a stream, rather than one of its values or footnotes?
 *
 * `streamPiece` is the only place that ever produces the `streamLabel`
 * role, and always as the group's first segment, so asking about the group
 * is asking about that one segment. Exported for `panel/html.ts` (#152): the
 * values panel rebuilds printed output as its own full block and has to cut
 * `resultGroups`' elided version back out, and an earlier version did that
 * by position -- trusting the statement's own slots to come first and the
 * streams right after them, which broke the moment #118 started hoisting a
 * shared count to the front of the line and shifted every index by one. A
 * group is what it is regardless of where `resultGroups` puts it, and
 * checking the role also sidesteps matching against the label's own text,
 * which `evalens.printedLabel` can change out from under a caller that
 * tried.
 */
export function isStreamGroup(group: readonly Segment[]): boolean {
  return group[0]?.role === 'streamLabel';
}

/** The same annotation as the one string it used to be. */
export function resultText(rendered: Rendered): string {
  return joinSegments(resultSegments(rendered));
}

/**
 * `"3 iterations"`, or `"1 iteration"`. Exported for `announce.ts`: the
 * spoken form needs the same words the hover already uses for the count a
 * line's `×N` abbreviates, on the same "cannot drift" terms as every other
 * function this module shares with that one.
 */
export function iterations(count: number): string {
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
