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
 */

import { BindingTrace, LoopTrace, NamedValue } from '../kernel/protocol';
import { paintedSlots } from './format';

/** The parts of an annotation the rule reads. */
export interface Annotated {
  readonly value?: string | null;
  readonly display?: string | null;
  readonly loop?: LoopTrace;
  readonly bindings?: readonly BindingTrace[];
  readonly names?: readonly NamedValue[];
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
   * The hover is not touched, so a value suppressed from a surviving line is
   * still one hover away rather than gone -- the same shelf a truncated value
   * and a described function already use.
   */
  keep<T extends Annotated>(annotation: T): T | undefined {
    const slots = paintedSlots(
      annotation.value ?? null, annotation.display, annotation.loop,
      annotation.names, annotation.bindings);

    const repeated = new Set<string>();
    for (const slot of slots) {
      if (slot.name === null) {
        continue;
      }
      if (!slot.own && this.lastPainted.get(slot.name) === slot.value) {
        // Identical to what the reader can already see above, so it is not
        // painted -- and recording it again would say the same thing.
        repeated.add(slot.name);
        continue;
      }
      this.lastPainted.set(slot.name, slot.value);
    }

    if (repeated.size === 0) {
      // Including every annotation with no pairs at all: an error, a bare
      // `=> 30`. Returned by identity, so nothing downstream has to guess
      // whether it was rewritten.
      return annotation;
    }
    if (slots.every((slot) => slot.name !== null && repeated.has(slot.name))) {
      return undefined;
    }
    return {
      ...annotation,
      names: (annotation.names ?? []).filter(
        (each) => !repeated.has(each.name)),
    };
  }
}
