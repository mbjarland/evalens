/**
 * How several coloured pieces of one annotation reach the screen in the order
 * they were written.
 *
 * CSS cannot colour part of a text node and one `after` attachment is one text
 * node, so an annotation in three colours is three attachments at the same
 * end-of-line position -- which means three decoration types. Whether VS Code
 * paints them in a knowable order is not documented anywhere, and a VS Code
 * maintainer asked this exact question declined to guarantee it. It was
 * therefore read out of the shipped renderer, and this module is the half of
 * the answer that can be tested without an editor.
 *
 * ## The order is a string comparison, not creation order
 *
 * Every end-of-line attachment ties on start column, end column and
 * decoration kind, so the renderer's comparator falls through to its last
 * rule: a plain JavaScript `<` on the generated CSS class name, which is
 * `ced-<instanceId>-<key>-4`. The key is a counter --
 * `TextEditorDecorationType` followed by an integer -- shared by every
 * extension in the host, so which integers this extension gets depends on
 * what else is installed.
 *
 * **Because the comparison is on strings, creation order is not paint order.**
 * With keys 7 through 12 the digits cross a boundary -- `"…Type10"` sorts
 * before `"…Type9"` because `'1' < '9'` -- and six segments made in order
 * paint as `3 printed: hi => 12 x:`. Sorting the types by the name they will be
 * compared under is what makes the order the one that was intended, and it is
 * the whole reason this function exists rather than an array in creation
 * order.
 *
 * Nothing here imports `vscode`: a decoration type is read only through its
 * public `key`, so the rule is checked by a test rather than by launching an
 * editor -- which matters, because this rests on undocumented behaviour and
 * is exactly the kind of thing that must fail loudly if a VS Code release
 * changes it.
 */

import { Segment } from './format';

/**
 * The rule number VS Code appends for an `after` attachment.
 *
 * `beforeContentClassName` is 3 and `afterContentClassName` is 4; the number
 * is part of the class name and therefore part of what gets compared. It is
 * the same for every type here, so it cannot change the order -- it is
 * included so the string being sorted is the string the renderer sorts.
 */
const AFTER_RULE = 4;

/**
 * How many segments one line can be painted in.
 *
 * A fixed pool, because a decoration type has to exist before anything can be
 * painted with it and the order they paint in is settled when they are made.
 * The number is derived rather than guessed: the kernel caps a line at four
 * names and three loop-body bindings, which with the statement's own value,
 * two streams of output, the cap footnote and the reduced-context caveat is
 * twelve pieces. A test builds that line and checks it still fits.
 *
 * Twenty-six segments after merging neighboring chrome within each piece:
 * four history slots each have a label, value and trailing count; four plain
 * names and two streams each have two segments; the two footnotes have one.
 * The eleven boundaries between pieces each cost two slots, for a spacer
 * and a hairline divider (see `decorations.ts`'s `DIVIDER_LEAD_SHAPE`). That
 * totals forty-eight slots. Separate count segments keep metadata quieter
 * than values without making a full line fall back to one color.
 *
 * A line that somehow wants more is painted as one string in the value colour:
 * the rendering this replaced, which is still correct, only less legible.
 */
export const SEGMENT_SLOTS = 48;

/** The class name an `after` attachment on this type will be compared under. */
export function afterClassName(key: string): string {
  return `ced-${key}-${AFTER_RULE}`;
}

/**
 * Decoration types in the order VS Code will paint them, left to right.
 *
 * A plain `<` rather than `localeCompare`, because a plain `<` is what the
 * renderer does. A locale-aware comparison agrees on these strings today and
 * would be a different rule the first time it did not.
 *
 * The instance id the main thread prefixes onto every key is the same for all
 * of them, so leaving it out cannot change the relative order.
 */
export function paintOrder<T extends { readonly key: string }>(
  types: readonly T[]
): readonly T[] {
  return [...types].sort((one, other) => {
    const first = afterClassName(one.key);
    const second = afterClassName(other.key);
    if (first === second) {
      return 0;
    }
    return first < second ? -1 : 1;
  });
}

/**
 * Neighbouring segments of the same role, merged into one.
 *
 * Purely an economy, and it changes nothing about what is painted: the text is
 * the same and the colour is the same, so the only difference is how many
 * attachments carry it. It matters because every attachment is a decoration
 * type held for the life of the extension, a `setDecorations` call on every
 * paint and a generated CSS rule for every distinct text and colour on screen.
 *
 * The run it removes is the common one. A gap is chrome, like the label that
 * follows it, so `…3` `<gap>` `y: ` is three segments that are one colour and
 * can be one node -- which also puts the gap and the label it introduces in a
 * single formatting context, where nothing can trim between them.
 */
export function coalesce(segments: readonly Segment[]): readonly Segment[] {
  const merged: Segment[] = [];
  for (const segment of segments) {
    const last = merged[merged.length - 1];
    if (last !== undefined && last.role === segment.role) {
      merged[merged.length - 1] = {
        role: last.role, text: last.text + segment.text,
      };
      continue;
    }
    merged.push(segment);
  }
  return merged;
}

/**
 * Which edge of the one continuous #118 chip one segment carries.
 *
 * #95 shaped each `resultGroups` group as its own box, so an edge used to
 * mark a position within one group. #118 paints the whole annotation as a
 * single box instead -- see `decorations.ts`'s doc comment on
 * `COLOR_ANNOTATION_TINT` for why -- so an edge now marks a position in the
 * WHOLE flattened run of segments, groups and dividers alike.
 */
export type ChipEdge = 'single' | 'first' | 'middle' | 'last';

export interface ChipSlot {
  readonly edge: ChipEdge;
  /**
   * True for exactly one segment across a whole annotation: the first one,
   * which is the annotation's leading edge and therefore the one the #95
   * accent bar is drawn on. Kept as its own field even though it is now
   * fully determined by `edge` (`leading` iff `edge` is `'first'` or
   * `'single'`): `chipShape` needs only the edge to compute padding and
   * rounding, but `decorations.ts`'s `show` needs `leading` on its own to
   * decide whether to draw the bar, and reads it as a plain boolean rather
   * than re-deriving it from a string on every segment of every line.
   */
  readonly leading: boolean;
}

/**
 * Which chip edge every slot of one continuous #118 annotation carries,
 * given how many slots it paints in total -- content segments and divider
 * slots alike, since a divider is chrome painted from this same pool (see
 * `decorations.ts`'s `DIVIDER_LEAD_SHAPE` / `DIVIDER_RULE_SHAPE`), not a gap
 * sitting outside it the way #95's did.
 *
 * Only the two ends of the WHOLE run are special now: the first slot gets
 * the padding and the square corner that belong at the leading edge (and
 * the bar, via `leading`), the last gets the padding and the rounded corner
 * at the trailing edge, and a run of exactly one slot gets both at once.
 * Every slot in between -- a group's own interior segments, a group's first
 * or last segment when it is not the annotation's own, and both of a
 * divider's slots -- carries neither: the tint is continuous across all of
 * them, so there is nothing left to round or pad except at the two outer
 * ends.
 */
export function chipSlots(total: number): readonly ChipSlot[] {
  return Array.from({ length: total }, (_, index) => ({
    edge: total === 1
      ? 'single'
      : index === 0
        ? 'first'
        : index === total - 1 ? 'last' : 'middle',
    leading: index === 0,
  }));
}
