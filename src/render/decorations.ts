import * as vscode from 'vscode';

import { printedLabel as printedLabelSetting, resultColumn } from '../config';
import {
  BindingTrace, LoopTrace, NamedValue, Range as KernelRange, TableWire,
} from '../kernel/protocol';
import {
  GAP, Printed, Segment, SegmentRole, alignmentGap, columnWidth, errorText,
  hasOutput, joinSegments, opensDefinition, preserveSpacing, restatesLine,
  resultGroups,
} from './format';
import {
  ChipEdge, SEGMENT_SLOTS, chipSlots, coalesce, paintOrder,
} from './layers';
import { Marker, Traced, markerFor, normalizeSource } from './registry';
import { Pending, isAsking, pendingText } from './status';

/**
 * Theme colour ids contributed in package.json. Colours come from the theme
 * rather than literals so results adapt to the user's and stay overridable
 * through `workbench.colorCustomizations`.
 *
 * A `ThemeColor` naming an id that is not contributed resolves to nothing and
 * paints invisibly, which is why a test checks these against the manifest.
 */
export const COLOR_RESULT = 'evalens.resultForeground';
export const COLOR_LABEL = 'evalens.labelForeground';
export const COLOR_OUTPUT_LABEL = 'evalens.outputLabelForeground';
export const COLOR_RESULT_BG = 'evalens.resultBackground';
export const COLOR_ERROR = 'evalens.errorForeground';
export const COLOR_ERROR_BG = 'evalens.errorBackground';
export const COLOR_REGION = 'evalens.evaluatedRegionBackground';
export const COLOR_PENDING = 'evalens.pendingForeground';
export const COLOR_PENDING_REGION = 'evalens.pendingRegionBackground';
export const COLOR_FLASH_REGION = 'evalens.flashRegionBackground';
/**
 * The border marking an annotation as a distinct surface (#95), on its
 * leading edge only -- the far side of the same margin the alignment gap
 * already reserves, so painting it costs no character cell and moves nothing.
 *
 * Used only for a value that is currently and genuinely `evaluated`. A stale
 * or still-pending annotation greys the bar through `COLOR_PENDING` instead,
 * and an error reddens it through `COLOR_ERROR` -- both already contributed
 * and already what that state's own text is painted in -- so the bar never
 * claims more confidence than the state it marks.
 *
 * Deliberately not `COLOR_LABEL`, though the ticket's first draft asked for
 * "the label colour": that colour is dimmed on purpose, to recede behind the
 * value it introduces, which makes it the quietest possible choice for a mark
 * whose whole job is to be seen. The annotation sits beside the user's own
 * trailing comment on real lines, often in near-identical text, and the bar
 * is the one element that can say where one stops and the other starts -- so
 * its default is its own saturated colour, distinct from the value's amber,
 * the error's red, the output label's blue and the pending grey.
 */
export const COLOR_ANNOTATION_BORDER = 'evalens.annotationBorder';

/**
 * The wash behind one chip of an annotation (#95).
 *
 * A bar alone read as a stray character rather than as structure: characters
 * do not have backgrounds, so nothing about a lone stroke told the reader it
 * was looking at a surface rather than punctuation. A tint is what a glyph
 * cannot have, which is what makes it read as a panel instead -- but a single
 * continuous tint across the whole annotation (#95's third revision) turned
 * out to be the wrong shape: it erased the separation between `x: 1` and
 * `y: 2` that lets a reader parse the line into distinct facts. The final
 * shape paints one tint per `resultGroups` group -- a label and the value it
 * introduces, or `printed:` and its text -- with the gap between two groups
 * left untinted, so the panel reads as several facts rather than one blur.
 *
 * One colour for every group and every state rather than one per `Marker` --
 * the bar already carries the state distinction, and a tint that also
 * changed hue per state or per role would be a second signal for one fact.
 * Computed faint, the way #83's palette was: low enough alpha that it cannot
 * drop any foreground colour below the contrast floor `colors.test.ts`
 * already asserts, so it can sit behind every role's text without needing a
 * role of its own. It takes the value colour's own hue at low opacity rather
 * than a hue-neutral wash, so the surface reads as part of the same palette
 * the text already uses rather than as a fourth, unrelated colour.
 */
export const COLOR_ANNOTATION_TINT = 'evalens.annotationTint';

/**
 * The blocked half of "pending" -- see `isAsking`. Its own colour rather than
 * a louder pending: a slow statement asks the reader to wait, a blocked one
 * asks the reader to act, and grey says the first of those regardless of
 * which is true. Not the error colour either -- a prompt is not a failure,
 * and painting it red would teach a student to fear a line that is working.
 */
export const COLOR_ASKING = 'evalens.askingForeground';
export const COLOR_ASKING_REGION = 'evalens.askingRegionBackground';

/**
 * The command the hover's link runs -- the one click from the annotation to
 * the whole of what a statement wrote.
 *
 * Contributed in package.json under the same id; a hover link naming a command
 * that is not there does nothing at all when clicked, which is the same silent
 * failure an uncontributed `ThemeColor` has, so a test checks the two agree.
 */
export const SHOW_OUTPUT = 'evalens.showOutput';

/** Columns between the code and its annotation when the line overruns. */
const MINIMUM_GAP = 2;

/**
 * Padding and rounding for one #95 chip, smuggled through `textDecoration` --
 * the decoration API exposes no padding of its own. Both are given per
 * `ChipEdge`, because a chip is now painted per `resultGroups` group rather
 * than once across the whole annotation: each group gets its own breathing
 * room and its own rounded corners, and the gap between two groups gets
 * neither (see `chipShape` below, and the untinted gap segment `show` builds
 * for it).
 *
 * Eight pixels on every outer edge -- final numbers, chosen by the maintainer
 * against a rendering rather than by description: six read as a printing
 * mistake, hugging the text it was meant to set off; padding only at the
 * outer ends of the *whole run*, which an earlier attempt tried, does not fix
 * that, because each chip is now its own box and needs its own room at both
 * of its own edges. All horizontal, so nothing here grows the inline-block
 * vertically -- vertical padding would push lines apart, which is worse than
 * any width this settles on.
 *
 * Corners round 3px, except the one edge carrying the #95 accent bar, which
 * is square. `border-radius` rounds whatever border is drawn on the same
 * box, and a rounded corner under the bar made a short, curved, text-height
 * stroke immediately before italic text -- which the maintainer correctly
 * read as an opening parenthesis rather than as structure before this was
 * diagnosed. `leading` (see `ChipSlot`) is true for exactly one segment
 * across a whole annotation, so it is the only one `chipShape` ever squares.
 */
const CHIP_PAD = 8;

/**
 * The `textDecoration` shape for one segment, given the `ChipEdge` it
 * carries within its own group and whether it is the annotation's leading
 * segment. Background and border are separate render-option fields (see
 * `show`, below) -- this is padding and rounding only.
 */
function chipShape(edge: ChipEdge, leading: boolean): string {
  switch (edge) {
    case 'single':
      return leading
        ? `none; padding: 0 ${CHIP_PAD}px; border-radius: 0 3px 3px 0;`
        : `none; padding: 0 ${CHIP_PAD}px; border-radius: 3px;`;
    case 'first':
      return leading
        ? `none; padding: 0 0 0 ${CHIP_PAD}px; border-radius: 0;`
        : `none; padding: 0 0 0 ${CHIP_PAD}px; border-radius: 3px 0 0 3px;`;
    case 'last':
      return `none; padding: 0 ${CHIP_PAD}px 0 0; border-radius: 0 3px 3px 0;`;
    case 'middle':
      return 'none; padding: 0;';
  }
}

/**
 * The gap `resultGroups` leaves for `show` to join back in, painted plainly:
 * no tint, no padding, no rounding, no border. It is what separates one chip
 * from the next, which is the whole reason #95 stopped tinting it along with
 * its neighbour -- a gap that looked like part of a chip was not a gap a
 * reader could see.
 */
const CHIP_GAP_SHAPE = 'none;';

/**
 * The `border` value that makes only the leading edge visible: every side
 * reset to `none`, then the left overridden to a solid rule. `border` and
 * `borderColor` are the one place this file needs no CSS smuggled through
 * `textDecoration` -- the decoration API exposes both directly, and
 * `borderColor` takes a genuine `ThemeColor` the same way `color` does -- but
 * a single side is still not a shorthand CSS has a name for, so the override
 * is written the same way the padding above is: as a second declaration
 * inside the one string the field accepts.
 *
 * 3px rather than a 2px hairline, on the maintainer's revision to #95 after
 * seeing the annotation in his own editor: a bar competing with a busy
 * syntax-highlighted line, and sitting next to the user's own trailing
 * comment on many real lines, has to be unmissable rather than tasteful. See
 * `COLOR_ANNOTATION_BORDER` for the colour half of the same revision.
 */
const BORDER_LEFT = 'none; border-left: 3px solid;';

/** The colour each role is painted in. */
const COLOR_FOR: Record<SegmentRole, string> = {
  value: COLOR_RESULT,
  nameLabel: COLOR_LABEL,
  streamLabel: COLOR_OUTPUT_LABEL,
};

/**
 * Where the three state markers live, relative to the extension root.
 *
 * Files rather than theme colours, because `gutterIconPath` takes an image and
 * there is no `ThemeColor` equivalent for the gutter -- so the light and dark
 * variants are two files rather than two defaults. A test checks that every
 * one of them exists, since a missing icon paints nothing at all and reports
 * nothing at all.
 */
const GUTTER_DIR = ['media', 'gutter'];

/** The three states, in the order they are painted. */
const MARKERS: readonly Marker[] = ['evaluated', 'stale', 'error'];

export interface Annotation extends Traced {
  readonly range: vscode.Range;
  /**
   * The line to write the value on, when that is not the end of `range`.
   *
   * A compound statement's value belongs beside the line that introduces it --
   * `def greet(name):`, `for p in squares:` -- and not beside the last line of
   * its body, which with a twenty-line body is twenty lines from the thing it
   * describes and inside a folded region is not visible at all. The range is
   * left covering the whole statement, because that is what the region
   * highlight uses to show how much code ran.
   */
  readonly anchor?: number;
  /** The value's `repr()`, or the error to show in its place. */
  readonly value?: string;
  /** The expression whose value this is, when it names a binding. */
  readonly display?: string | null;
  /** Every value a loop's target held; displaces `value` when present. */
  readonly loop?: LoopTrace;
  /** Every value the loop's body bound, per name; painted after the target. */
  readonly bindings?: readonly BindingTrace[];
  /** What the names on the line held; painted beside `value`, not instead. */
  readonly names?: readonly NamedValue[];
  /**
   * How many further names the kernel's per-line cap left out, so the line
   * can say so rather than look as though it lost one.
   */
  readonly more?: number;
  /**
   * A bounded table description of `value`, for #24 -- a `pandas.DataFrame`,
   * or a list/tuple of dicts, `namedtuple`s, or same-length lists/tuples.
   * Never painted here: it is an elaboration reached from the hover
   * (`render/hover.ts`, via `render/table.ts`'s `tableMarkdown`), not a
   * second thing beside the line. Set by whoever turns a `Presentation`
   * into an `Annotation` -- see `Presentation`'s own `table` field in
   * `render/present.ts` for where it comes from on the wire.
   */
  readonly table?: TableWire;
  /**
   * What the statement printed; painted after everything else, not instead.
   *
   * The label is filled in at paint time from the setting, so the raw streams
   * are what is stored -- an annotation that cached the label would keep
   * whatever was configured when it was made.
   */
  readonly printed?: Printed;
  readonly error?: { readonly type: string; readonly message: string };
  /**
   * The full, untruncated answer -- read by `render/hover.ts`'s
   * `HoverProvider`, not painted here. See #46: a decoration's own
   * `hoverMessage` cannot do this job, because it keys off `range`, and this
   * type's `range` is deliberately real while the paint position (`at`,
   * below) is a zero-width point built only to host `after` content.
   */
  readonly hover?: string;
  /**
   * Set while the statement has not finished, displacing everything above.
   *
   * Its presence is the state; the message it carries is what the statement is
   * waiting for, when that is something more specific than time. Not a
   * boolean, because "still running" and "waiting for you to type an answer to
   * `Enter a value:`" are different things the reader has to tell apart, and a
   * flag can only say that one of them is true.
   */
  readonly pending?: Pending;
  /**
   * The 0-based line the file stopped parsing at, when this answer was
   * computed without the rest of the file.
   *
   * A value from a reduced context is a weaker claim than a value from the
   * whole file. Painting the two identically would make every annotation on
   * screen mean "one of these two things", which is the failure this project
   * treats as worse than showing nothing.
   */
  readonly partialFrom?: number;
}

/**
 * Paints evaluation results into an editor.
 *
 * Three decoration layers rather than one, following Calva for two of them:
 * the result text hangs off the end of the line as an `after` decoration, and
 * the region that was evaluated gets its own background. Keeping them separate
 * is what makes the display legible -- one says what the answer is, the other
 * says what question was asked.
 *
 * The third is the state marker in the gutter, and where it goes is the whole
 * of the decision. Marking the annotation itself -- dimming it, greying it,
 * striking it through -- makes the value compete with a claim about the value,
 * in the one place on screen the reader is trying to read. A mark in the
 * gutter sits outside the reading path and answers a question that is only
 * ever asked deliberately. CIDER puts it in the fringe, Mathematica has put it
 * in the cell bracket since 1996, and JupyterLab's review of the same feature
 * turned down a request to mark the output. Three independent arrivals at the
 * margin is not a coincidence.
 *
 * A statement that has not finished displaces all three with the pending mark
 * and a greyed region. That is a state rather than a remark, which is why it
 * lives here and the brief emphasis on a statement that just *did* finish does
 * not -- that one is a gesture on a timer and belongs to `Flash`.
 */
export class Decorator implements vscode.Disposable {
  /**
   * One decoration type per segment of a line, in the order they will paint.
   *
   * They are identical, and that is the point: what differs between two
   * segments -- the text, the colour, the chip edge, the alignment margin --
   * rides on the per-range `renderOptions`, and what does not differ stays
   * here. A sub-type's CSS selector carries both its own class and its
   * parent's, so anything set on both would be won by the sub-type; keeping
   * the two apart is what stops that mattering.
   *
   * Sorted rather than used in creation order. VS Code breaks the tie between
   * two attachments at one position with a string comparison of the generated
   * class name, and the counter that name is built from crosses digit
   * boundaries -- see `layers.ts`, where the rule is written down and tested.
   */
  private readonly segmentTypes: readonly vscode.TextEditorDecorationType[];

  private readonly errorType = vscode.window.createTextEditorDecorationType({
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedOpen,
    after: {
      color: new vscode.ThemeColor(COLOR_ERROR),
      // The #95 surface tint, not `COLOR_ERROR_BG`: the wash is one colour
      // for every state (see `COLOR_ANNOTATION_TINT`), and an error's own
      // loudness is the bar and the text, not a second background. An error
      // is always a single chip that is also the annotation's leading edge.
      backgroundColor: new vscode.ThemeColor(COLOR_ANNOTATION_TINT),
      textDecoration: chipShape('single', true),
      fontStyle: 'italic',
      // The #95 bar takes the error colour here, never the annotation-border
      // one -- an error is exactly as loud as the text beside it already is.
      border: BORDER_LEFT,
      borderColor: new vscode.ThemeColor(COLOR_ERROR),
    },
  });

  /**
   * The unfinished state: no colour of its own beyond a muted one, because
   * what it has to say is that there is nothing to read here yet.
   */
  private readonly pendingType = vscode.window.createTextEditorDecorationType({
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedOpen,
    after: {
      color: new vscode.ThemeColor(COLOR_PENDING),
      // The same surface tint as every other state, so a still-running
      // statement is marked as a distinct surface exactly like a finished
      // one -- the point the tint exists for does not stop applying just
      // because there is nothing to read yet.
      backgroundColor: new vscode.ThemeColor(COLOR_ANNOTATION_TINT),
      textDecoration: chipShape('single', true),
      fontStyle: 'italic',
      // Greyed with the rest of this state, for the same reason: a bright
      // bar would be the loudest thing on a row that is saying "not yet".
      border: BORDER_LEFT,
      borderColor: new vscode.ThemeColor(COLOR_PENDING),
    },
  });

  /**
   * The blocked state: the opposite of muted, because nothing moves until the
   * reader answers and grey would tell them to wait when they are the one
   * being waited on. See `isAsking` for how a pending statement lands here
   * rather than in `pendingType`.
   */
  private readonly askingType = vscode.window.createTextEditorDecorationType({
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedOpen,
    after: {
      color: new vscode.ThemeColor(COLOR_ASKING),
      textDecoration: chipShape('single', true),
      fontStyle: 'italic',
    },
  });

  private readonly regionType = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor(COLOR_REGION),
    isWholeLine: false,
    // The scrollbar mark is what makes evaluated regions findable in a file
    // longer than a screen.
    overviewRulerColor: new vscode.ThemeColor(COLOR_REGION),
    overviewRulerLane: vscode.OverviewRulerLane.Right,
  });

  /** The same region, greyed, while the kernel has not answered for it. */
  private readonly pendingRegionType =
    vscode.window.createTextEditorDecorationType({
      backgroundColor: new vscode.ThemeColor(COLOR_PENDING_REGION),
      isWholeLine: false,
      overviewRulerColor: new vscode.ThemeColor(COLOR_PENDING_REGION),
      overviewRulerLane: vscode.OverviewRulerLane.Right,
    });

  /**
   * The same region again, loud, while the statement is blocked on the
   * reader rather than merely running.
   *
   * `pendingRegionType` sits at low alpha on purpose -- "there is nothing to
   * read here yet". This is the opposite claim, so it is not that region
   * turned up; it is the one line on screen the reader has to act on, and the
   * ruler mark is `Full` rather than `Right` so it is the one mark that finds
   * the reader even when every other decoration is scrolled out of view.
   */
  private readonly askingRegionType =
    vscode.window.createTextEditorDecorationType({
      backgroundColor: new vscode.ThemeColor(COLOR_ASKING_REGION),
      isWholeLine: false,
      overviewRulerColor: new vscode.ThemeColor(COLOR_ASKING_REGION),
      overviewRulerLane: vscode.OverviewRulerLane.Full,
    });

  /** One decoration type per state, because each carries a different icon. */
  private readonly markerTypes: ReadonlyMap<
    Marker, vscode.TextEditorDecorationType>;

  constructor(extensionUri: vscode.Uri) {
    this.segmentTypes = paintOrder(
      Array.from({ length: SEGMENT_SLOTS }, () =>
        vscode.window.createTextEditorDecorationType({
          // ClosedOpen: the decoration does not absorb text typed at its
          // boundary, so an annotation does not smear along the line as the
          // user keeps editing.
          rangeBehavior: vscode.DecorationRangeBehavior.ClosedOpen,
          after: {
            // No background here, unlike `errorType` and `pendingType`: a
            // segment slot in this shared pool paints a tinted chip on one
            // annotation and the untinted gap between two chips on the next,
            // so the #95 tint has to ride the per-range `renderOptions`
            // `show` builds below rather than this one static config every
            // slot would otherwise share.
            //
            // Italic is what makes an annotation legible as not-code at a
            // glance, before colour is even processed. Rider leans on this and
            // it carries most of the separation.
            fontStyle: 'italic',
          },
        })));
    this.markerTypes = new Map(MARKERS.map((marker) => [
      marker,
      vscode.window.createTextEditorDecorationType({
        gutterIconSize: 'contain',
        // Light and dark are separate images rather than separate colours:
        // the gutter takes an icon, and an icon carries its own palette.
        dark: { gutterIconPath: iconFor(extensionUri, marker, 'dark') },
        light: { gutterIconPath: iconFor(extensionUri, marker, 'light') },
      }),
    ]));
  }

  /** Replace this editor's annotations with `annotations`. */
  show(editor: vscode.TextEditor, annotations: readonly Annotation[]): void {
    // One list per segment slot, so slot n of every line on screen goes to the
    // same decoration type and the types paint in the order they were sorted
    // into.
    const results: vscode.DecorationOptions[][] =
      this.segmentTypes.map(() => []);
    const errors: vscode.DecorationOptions[] = [];
    const waiting: vscode.DecorationOptions[] = [];
    const asking: vscode.DecorationOptions[] = [];
    const regions: vscode.DecorationOptions[] = [];
    const pendingRegions: vscode.DecorationOptions[] = [];
    const askingRegions: vscode.DecorationOptions[] = [];
    const markers = new Map<Marker, vscode.DecorationOptions[]>(
      MARKERS.map((marker) => [marker, []]));

    const targetColumn = resultColumn();
    // Read here rather than captured, so editing the setting takes effect on
    // the next paint the way the alignment column does.
    const label = printedLabelSetting();
    const tabSize = typeof editor.options.tabSize === 'number'
      ? editor.options.tabSize
      : 4;

    for (const annotation of annotations) {
      // Greyed, loud, or evaluated -- three lists rather than one, so a
      // statement is painted as exactly one of them and never two at once.
      // Which of the first two it is is `isAsking`'s question: a statement
      // merely taking a while is greyed, one blocked on the reader is not.
      if (annotation.pending) {
        (isAsking(annotation.pending) ? askingRegions : pendingRegions)
          .push({ range: annotation.range });
      } else {
        regions.push({ range: annotation.range });
      }

      // End of the LINE, not end of the statement. Anchoring mid-line would
      // insert the annotation before any trailing comment and shove it
      // right, and there would be no column to align to.
      const host = editor.document.lineAt(
        annotation.anchor ?? annotation.range.end.line);
      const at = new vscode.Range(host.range.end, host.range.end);

      // On the line the value is written on, not on every line the statement
      // covers: the marker is a claim about that value, and a twenty-line
      // `def` with twenty markers down its side would read as twenty claims.
      //
      // A statement still running gets no marker at all. The three states are
      // claims about how a value stands against the code beside it, and a
      // statement that has not produced one yet is in none of them -- a green
      // `evaluated` there would say the kernel had answered when it has not.
      if (!annotation.pending) {
        markers.get(markerFor(annotation))?.push({
          range: new vscode.Range(host.range.start, host.range.start),
        });
      }

      // The gap goes in the margin rather than in the content, so it stays
      // outside the annotation's background. Padding the content instead
      // would render sixty columns of coloured block.
      const gap = alignmentGap(
        columnWidth(host.text, tabSize), targetColumn, MINIMUM_GAP);
      const margin = `0 0 0 ${gap}ch`;

      const printed = annotation.printed === undefined
        ? undefined
        : { ...annotation.printed, label };

      // The one click from the annotation to the channel used to hang off a
      // `hoverMessage` here, on a range with no width -- see #46. A
      // `DecorationOptions.range` the API itself documents as "must not be
      // empty" cannot be what a mouse or a keyboard ever lands on, so nothing
      // here was ever reachable. `render/hover.ts` answers the same question
      // from a real `HoverProvider`, registered on the position instead of on
      // this paint, and reads `annotation.hover` for itself.

      if (annotation.pending) {
        // First, and displacing whatever the statement said last time. Taking
        // the old value away is half the transition: an evaluation that
        // produces the same string again has still visibly happened, because
        // the string left and came back.
        (isAsking(annotation.pending) ? asking : waiting).push({
          range: at,
          renderOptions: {
            after: { margin, contentText: pendingText(annotation.pending) },
          },
        });
      } else if (annotation.error) {
        errors.push({
          range: at,
          renderOptions: {
            after: {
              margin,
              contentText: errorText(
                annotation.error.type, annotation.error.message,
                annotation.partialFrom),
            },
          },
        });
      } else if (annotation.value !== undefined
                 || annotation.loop !== undefined
                 || (annotation.names?.length ?? 0) > 0
                 || hasOutput(printed)) {
        // Output goes through the result layer, not the error one, and that
        // is the whole of how `stderr:` stays uncoloured: a library logging a
        // warning has not failed, and painting it red would teach a beginner
        // to fear a line that worked.
        //
        // A loop that ran zero times has a trace and no value, and still has
        // something to report. So does an `if` that bound a name: no value of
        // its own, and the name is the answer.
        //
        // Coalesced within each group, never across one: merging a gap into
        // the label next to it is the economy `coalesce` exists for, and it
        // is exactly wrong here, because it would paint the gap in that
        // label's chip. Empty groups are dropped -- `coalesce` can produce
        // one from a piece that was entirely non-breaking spaces, which
        // nothing downstream expects.
        const groups = resultGroups({
          value: annotation.value ?? null,
          display: annotation.display,
          loop: annotation.loop,
          names: annotation.names,
          bindings: annotation.bindings,
          printed,
          more: annotation.more,
          partialFrom: annotation.partialFrom,
        }).map(coalesce).filter((group) => group.length > 0);

        // The untinted gap between two chips, kept as its own segment rather
        // than let `coalesce` fold it into either neighbour (#95) -- painting
        // it in a neighbour's chip is the defect the per-group tint exists to
        // avoid. Non-breaking, the same as every other segment: an ordinary
        // space here would collapse exactly the way #83 measured and close
        // the gap `resultGroups` left for it.
        const gapSegment: Segment = {
          role: 'nameLabel', text: preserveSpacing(GAP),
        };
        const flat: Segment[] = [];
        groups.forEach((group, index) => {
          if (index > 0) {
            flat.push(gapSegment);
          }
          flat.push(...group);
        });
        const text = joinSegments(flat);
        // Rendered first, then compared with the line it would sit on: an
        // annotation that only restates its own line is not worth the width,
        // and the region highlight below already says that it ran. The
        // comparison happens here, at the last moment, because here is the
        // only place that holds both halves of it.
        //
        // A definition never asks the question. `def greet(name)` and `def
        // greet(name):` are the same characters and a different claim -- the
        // line says what happens when it runs, the annotation says it has run
        // -- so the whole family paints, rather than the four members of it
        // whose descriptions happen not to be prefixes of their own lines.
        // The exemption is here, on the kind of statement, and not inside
        // `restatesLine`, which is right about text and stays that way.
        if (opensDefinition(host.text) || !restatesLine(text, host.text)) {
          // Beyond the pool there is no type left to paint in, so the line
          // falls back to the rendering this replaced: one attachment, one
          // colour, every character still there. Less legible, never wrong.
          // A single chip, and it is the annotation's own leading edge.
          const fits = flat.length <= results.length;
          const paintedGroups: readonly (readonly Segment[])[] = fits
            ? groups
            : [[{ role: 'value', text }]];
          // `annotation.error` is undefined on this branch (it is handled
          // above), so `markerFor` can only answer `evaluated` or `stale`
          // here -- exactly the two the #95 bar needs to tell apart. Stale
          // reuses the pending colour rather than getting one of its own: the
          // same mark, not a second kind of amber, this time for a bar
          // instead of the gutter icon `registry.ts` says that about.
          const borderColor = markerFor(annotation) === 'stale'
            ? COLOR_PENDING
            : COLOR_ANNOTATION_BORDER;

          let slot = 0;
          paintedGroups.forEach((group, groupIndex) => {
            if (fits && groupIndex > 0) {
              // The gap between two chips takes a slot of its own, painted
              // with none of a chip's tint, padding or rounding.
              results[slot]!.push({
                range: at,
                renderOptions: {
                  after: {
                    contentText: gapSegment.text,
                    color: new vscode.ThemeColor(COLOR_FOR[gapSegment.role]),
                    textDecoration: CHIP_GAP_SHAPE,
                  },
                },
              });
              slot += 1;
            }
            const edges = chipSlots(group.length, groupIndex === 0);
            group.forEach((segment, index) => {
              const chip = edges[index]!;
              results[slot]!.push({
                range: at,
                renderOptions: {
                  after: {
                    // Only the very first segment of the whole annotation is
                    // pushed out to the alignment column and carries the #95
                    // bar -- `chip.leading` and `slot === 0` are the same
                    // fact, since neither a gap nor a later group's first
                    // segment can ever be slot 0.
                    ...(slot === 0 ? { margin } : {}),
                    ...(chip.leading
                      ? {
                          border: BORDER_LEFT,
                          borderColor: new vscode.ThemeColor(borderColor),
                        }
                      : {}),
                    contentText: segment.text,
                    color: new vscode.ThemeColor(COLOR_FOR[segment.role]),
                    backgroundColor: new vscode.ThemeColor(
                      COLOR_ANNOTATION_TINT),
                    textDecoration: chipShape(chip.edge, chip.leading),
                  },
                },
              });
              slot += 1;
            });
          });
        }
      }
      // A statement with nothing to show -- an `if`, a `del` -- still gets its
      // region highlighted. It ran; there is simply no value to report.
    }

    this.segmentTypes.forEach((type, slot) => {
      // Every slot is set on every paint, empty included, for the same reason
      // the markers are: a slot left out keeps whatever it painted last time,
      // so a line that got shorter would keep the tail of the old one.
      editor.setDecorations(type, results[slot] ?? []);
    });
    editor.setDecorations(this.errorType, errors);
    editor.setDecorations(this.pendingType, waiting);
    editor.setDecorations(this.askingType, asking);
    editor.setDecorations(this.regionType, regions);
    editor.setDecorations(this.pendingRegionType, pendingRegions);
    editor.setDecorations(this.askingRegionType, askingRegions);
    for (const [marker, type] of this.markerTypes) {
      // Every state is set on every paint, empty included: leaving one out
      // leaves its previous icons in the gutter, so a marker that has gone
      // amber would keep a green twin underneath it.
      editor.setDecorations(type, markers.get(marker) ?? []);
    }
  }

  clear(editor: vscode.TextEditor): void {
    this.show(editor, []);
  }

  dispose(): void {
    for (const type of this.segmentTypes) {
      type.dispose();
    }
    this.errorType.dispose();
    this.pendingType.dispose();
    this.askingType.dispose();
    this.regionType.dispose();
    this.pendingRegionType.dispose();
    this.askingRegionType.dispose();
    for (const type of this.markerTypes.values()) {
      type.dispose();
    }
  }
}

/** Kernel coordinates are already VS Code's; this only changes the type. */
export function toVsCodeRange(range: KernelRange): vscode.Range {
  return new vscode.Range(
    range.start.line, range.start.character,
    range.end.line, range.end.character
  );
}

/** Where one state's icon lives, for one theme kind. */
export function iconFor(
  extensionUri: vscode.Uri, marker: Marker, theme: 'dark' | 'light'
): vscode.Uri {
  return vscode.Uri.joinPath(
    extensionUri, ...GUTTER_DIR, `${marker}-${theme}.svg`);
}

/**
 * What the lines an annotation covers say right now, folded for comparison.
 *
 * Whole lines rather than the statement's exact range, and that is the point
 * rather than a shortcut: an edit that changes a line's indentation moves
 * every column on it, so a range-precise read would start mid-token and
 * report a change that is not one. A top-level statement owns its lines.
 *
 * Clamped, because an edit can shorten the document under an annotation that
 * is on its way out.
 */
export function sourceAt(
  document: vscode.TextDocument, range: vscode.Range
): string {
  const last = Math.min(range.end.line, document.lineCount - 1);
  const first = Math.min(Math.max(range.start.line, 0), last);
  return normalizeSource(document.getText(
    new vscode.Range(first, 0, last, document.lineAt(last).text.length)));
}
