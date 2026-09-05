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
 * twelve pieces -- twenty-three segments once neighbouring chrome is merged.
 * A test builds that line and checks it still fits.
 *
 * A line that somehow wants more is painted as one string in the value colour:
 * the rendering this replaced, which is still correct, only less legible.
 */
export const SEGMENT_SLOTS = 24;

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
