/**
 * The rule that keeps a bulk-annotated file from reading as a wall.
 *
 * Annotating every statement in a real teaching file puts the same answer on
 * screen over and over -- four consecutive lines calling methods on one dict
 * were each annotated `inventory: {'apples': 3, 'pears': 5}` -- and the
 * repetition, not the annotation, is what makes the difference between a
 * worked example and a log. So: a `name: value` pair that already appears,
 * unchanged, above the line does not appear again.
 *
 * Pure on purpose. This is a decision about what the reader sees, it has a
 * right answer that can be checked without an editor, and the editor shell is
 * the one place it could not be tested.
 *
 * Three things about it are load-bearing.
 *
 * **The comparison is on the rendered value, not on identity.** Three of
 * those four `inventory` lines call methods that could have mutated it, and
 * the kernel is not asked whether the object changed -- reading that would
 * mean snapshotting and comparing values that may not compare cheaply. What
 * the reader needs to know is whether the *shown* value changed, which is a
 * string comparison against what was last painted for that name.
 *
 * **"Above" means earlier in the file, not scrolled into view.** Nothing here
 * knows or asks what is on screen. Scroll-dependent suppression would make
 * annotations appear and vanish as the user moves through the file, which is
 * worse than the repetition it removes -- and the case that decides it is
 * ordinary: a group of bindings and the line that restates them eleven lines
 * later, which in a longer file are never visible together.
 *
 * **Nothing is ever re-read.** An annotation is a trace: it says what a name
 * held when its statement ran. This compares two strings the kernel already
 * sent and never asks it for a value again, so suppression cannot turn into
 * a watch by the back door.
 *
 * A second, smaller rule lives here too since #85: once repeats are gone,
 * whatever survives is cut to `evalens.readNamesPerLine` names, and the rest
 * are folded into `more` rather than dropped. That decision belongs beside
 * this one rather than beside the kernel's, because it needs the same
 * information -- which names are actually new -- and the kernel is precisely
 * what does not have that information. A cap applied on the wire, before
 * suppression runs, can only choose by position, which is how #85 could keep
 * four names the reader had already seen and drop the one that had just
 * changed. See `capNames`.
 */

import { BindingTrace, LoopTrace, NamedValue } from '../kernel/protocol';
import { Printed, hasOutput, paintedSlots } from './format';

/** The parts of an annotation the rule reads. */
export interface Annotated {
  readonly value?: string | null;
  readonly display?: string | null;
  readonly loop?: LoopTrace;
  readonly bindings?: readonly BindingTrace[];
  readonly names?: readonly NamedValue[];
  /**
   * What the statement printed, which this rule reads and never suppresses.
   *
   * Here for two reasons, both about agreeing with the renderer rather than
   * about repetition. Output decides whether a produced `None` is painted, so
   * `paintedSlots` has to be given it or the slots this rule reasons about
   * would not be the slots the line shows. And output is not a `name: value`
   * pair at all -- it is what this statement did on this run, so there is
   * nothing above it to be a repeat of.
   */
  readonly printed?: Printed;
  /**
   * How many further names are not on this line, added up rather than
   * replaced: `capNames` reads whatever is here already and adds its own
   * count to it, since a response can carry a nonzero one of its own -- the
   * kernel's transport bound is generous, not infinite -- and `keep` passes
   * an incoming value through untouched wherever suppression is all that
   * changed the line. `resultSegments` shows the footnote on nothing more
   * than `more > 0`, so this is the one place either cap has to add to.
   */
  readonly more?: number;
}

/**
 * How many `name: value` pairs a line shows when nobody's cap says otherwise.
 *
 * `evalens.readNamesPerLine`'s own default, so a caller with no preference --
 * most of them, in a test -- gets the same answer the setting would give.
 */
const DEFAULT_NAME_CAP = 4;

/**
 * `annotation` with `names` cut to `cap` entries, the rest folded into
 * `more` instead of thrown away.
 *
 * Used twice. `PaintedAbove.keep` calls it after suppression, on whatever
 * survives being compared to what the reader has already seen -- which is
 * the fix for #85: capping novel names rather than positional ones. And a
 * single evaluation, which never suppresses anything because nobody's
 * `PaintedAbove` runs over one line's history, calls it directly on the raw
 * response: the kernel's own cap is a transport bound now, generous enough
 * that a request ordinarily never reaches it, so this is the only cap most
 * lines ever see.
 *
 * Identity is preserved when there is nothing to cut, on the same terms as
 * `keep` itself: a caller downstream should not have to compare two objects
 * to learn that nothing changed.
 */
export function capNames<T extends Annotated>(annotation: T, cap: number): T {
  const pairs = annotation.names ?? [];
  if (pairs.length <= cap) {
    return annotation;
  }
  const overflow = pairs.length - cap;
  return {
    ...annotation,
    names: pairs.slice(0, cap),
    more: (annotation.more ?? 0) + overflow,
  };
}

/**
 * What each name last had painted beside it, walking a file top to bottom.
 *
 * One of these per bulk annotation run, fed the statements in file order.
 * It holds strings the kernel already sent, so it costs one map entry per
 * name and never touches the kernel again.
 */
export class PaintedAbove {
  /**
   * Keyed on the name, holding the *most recent* text painted for it rather
   * than every text ever painted for it.
   *
   * That is what makes a value coming back to an earlier one still count as a
   * change. A file that binds `x = 1`, rebinds `x = 2`, then rebinds `x = 1`
   * has a reader looking up from the third line at `x: 2`, so `x: 1` there is
   * news -- and "a changed value must always appear" is the one thing this
   * rule may not cost.
   */
  private readonly lastPainted = new Map<string, string>();

  /**
   * @param cap How many `name: value` pairs `keep` leaves on a line once
   * suppression is done -- see `capNames`. Defaults to
   * `evalens.readNamesPerLine`'s own default, for the many callers, mostly
   * tests, that have no preference of their own.
   */
  constructor(private readonly cap: number = DEFAULT_NAME_CAP) {}

  /**
   * `annotation` with every pair already painted above it removed, or
   * undefined when that leaves it with nothing to say.
   *
   * Undefined rather than an empty annotation: a line whose whole content was
   * a repeat should paint nothing at all, region highlight included. It is
   * also what keeps a demoted `None` from coming back. `print(inventory.get(
   * "bananas", 0))` produces `None`, which the formatter gives way to the
   * names on the line; if those names are then suppressed, re-promoting the
   * `None` would replace one wall with a worse one -- the `=> None` column
   * this display was built to get rid of. The space stays empty, for the
   * printed output that belongs in it.
   *
   * And where the statement *did* print, the line survives with only its
   * output on it. What it wrote happened on this run and stands above nothing,
   * so it is never a repeat -- dropping the whole annotation because the names
   * beside it were already shown would take away the only thing on the line
   * the reader had not seen.
   *
   * The hover is not touched, so a value suppressed from a surviving line is
   * still one hover away rather than gone -- the same shelf a truncated value
   * and a described function already use.
   *
   * The cap is applied last, by `capNames`, after suppression rather than
   * before it -- which is the whole of #85. Whatever is left once repeats are
   * gone is by definition new to the reader, so cutting it down to size at
   * this point discards by novelty. Cutting the kernel's raw list first, the
   * way the wire used to, discards by position instead, and position has no
   * way to tell a name the reader has just watched change from one they saw
   * on line one and never again.
   *
   * The ledger is written only once the cap is known, and only for names that
   * are actually going up on screen. A name the cap counted rather than
   * painted was never shown, so recording it as though it had been would let
   * a later line suppress it as a repeat of a value the reader never saw --
   * exactly the failure this whole file exists to prevent, just moved one
   * step later.
   */
  keep<T extends Annotated>(annotation: T): T | undefined {
    const slots = paintedSlots(
      annotation.value ?? null, annotation.display, annotation.loop,
      annotation.names, annotation.bindings, annotation.printed);

    const repeated = new Set<string>();
    for (const slot of slots) {
      if (slot.name === null || slot.own) {
        // An own value is never a repeat, and the ledger below records it
        // unconditionally -- neither question belongs in this loop.
        continue;
      }
      if (this.lastPainted.get(slot.name) === slot.value) {
        // Identical to what the reader can already see above, so it is not
        // painted.
        repeated.add(slot.name);
      }
    }

    if (repeated.size > 0
        && slots.every((slot) => slot.name !== null && repeated.has(slot.name))
        && !hasOutput(annotation.printed)) {
      return undefined;
    }

    const capped = repeated.size === 0
      ? capNames(annotation, this.cap)
      : capNames({
          ...annotation,
          names: (annotation.names ?? []).filter(
            (each) => !repeated.has(each.name)),
        }, this.cap);

    const painted = new Set((capped.names ?? []).map((each) => each.name));
    for (const slot of slots) {
      if (slot.name === null) {
        continue;
      }
      if (slot.own || painted.has(slot.name)) {
        this.lastPainted.set(slot.name, slot.value);
      }
    }

    return capped;
  }
}
