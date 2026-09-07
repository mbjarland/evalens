import * as vscode from 'vscode';

import { printedLabel as printedLabelSetting, resultColumn } from '../config';
import {
  BindingTrace, LoopExplorerWire, LoopTrace, NamedValue, Range as KernelRange, TableWire,
} from '../kernel/protocol';
import {
  GAP, Printed, Segment, SegmentRole, alignmentGap, columnWidth, errorText,
  hasOutput, joinSegments, opensDefinition, preserveSpacing, restatesLine,
  resultGroups,
} from './format';
import {
  ChipEdge, SEGMENT_SLOTS, chipSlots, coalesce, paintOrder,
} from './layers';
import { inlineLoopHistories } from './loopHistories';
import { Marker, Traced, markerFor, normalizeSource } from './registry';
import { Pending, isAsking, pendingText } from './status';
import { ErrorDetails } from './errorGuidance';

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
 * Used only for a value that is currently and genuinely `evaluated`. A
 * still-pending annotation greys the bar through `COLOR_PENDING`, matching
 * what that state's own text is painted in. A stale one takes its own
 * `COLOR_STALE_BORDER` instead (#109) -- not `COLOR_PENDING`, because "not
 * finished yet" and "finished, but out of date" are different claims, and a
 * bar answering both the same way could not be retuned independently
 * through `workbench.colorCustomizations`. An error reddens the bar through
 * `COLOR_ERROR`, unless it is also stale, in which case stale outranks it
 * here exactly as `markerFor` says it does everywhere else.
 *
 * Deliberately not `COLOR_LABEL`, though the ticket's first draft asked for
 * "the label colour": that colour is dimmed on purpose, to recede behind the
 * value it introduces, which makes it the quietest possible choice for a mark
 * whose whole job is to be seen. The annotation sits beside the user's own
 * trailing comment on real lines, often in near-identical text, and the bar
 * is the one element that can say where one stops and the other starts -- so
 * its default is a visible amber shared with the Values panel (#163),
 * darker on light themes. The error's red and pending/stale greys remain
 * separate states; explicit user colour customizations still take priority.
 */
export const COLOR_ANNOTATION_BORDER = 'evalens.annotationBorder';

/**
 * The wash behind an annotation (#95, reshaped by #118).
 *
 * A bar alone read as a stray character rather than as structure: characters
 * do not have backgrounds, so nothing about a lone stroke told the reader it
 * was looking at a surface rather than punctuation. A tint is what a glyph
 * cannot have, which is what makes it read as a panel instead -- but a single
 * continuous tint across the whole annotation (#95's third revision) turned
 * out to be the wrong shape *for that revision*: with nothing else marking a
 * boundary, it erased the separation between `x: 1` and `y: 2` that lets a
 * reader parse the line into distinct facts. #95 shipped painting one tint
 * per `resultGroups` group instead -- a label and the value it introduces, or
 * `printed:` and its text -- with the gap between two groups left untinted,
 * so the boundary *was* the tint's own edge.
 *
 * #118 revisits that trade rather than reversing it: once a 1px hairline
 * (`COLOR_CHIP_DIVIDER`) sits at every one of those same boundaries, the
 * boundary is the rule, not the edge of the tint, and a continuous wash no
 * longer erases anything -- what #95 protected against was a plain gap
 * being the *only* signal, and it no longer is. So the whole annotation is
 * one tinted surface again, from its leading edge to its trailing one,
 * dividers included, and rounds only at those two outer ends (see
 * `chipShape`); the maintainer's own rendering of a half-width editor
 * (#118's motivating case) was the evidence that the gap this bought back
 * was worth more than the second separation cue cost.
 *
 * One colour for every segment and every role, for `evaluated` and `pending`
 * alike -- the bar already carries most of a state's distinction, and a
 * tint that also changed hue per role would be a second signal for one
 * fact. `stale` is the one exception (#109): before `COLOR_STALE_TINT`
 * existed, a stale chip stayed exactly this colour at exactly this
 * strength, and only a 3px bar and a 13px gutter icon said otherwise --
 * signal too weak to survive the surface #95 gave every annotation, which
 * is the defect this ticket exists to fix.
 *
 * Computed faint, the way #83's palette was: low enough alpha that it cannot
 * drop any foreground colour below the contrast floor `colors.test.ts`
 * already asserts, so it can sit behind every role's text without needing a
 * role of its own. It takes the value colour's own hue at low opacity rather
 * than a hue-neutral wash, so the surface reads as part of the same palette
 * the text already uses rather than as a fourth, unrelated colour.
 */
export const COLOR_ANNOTATION_TINT = 'evalens.annotationTint';

/**
 * The 1px rule that separates two value groups of one continuous #118 chip
 * -- what a plain, untinted gap (`CHIP_GAP_SHAPE`, #95) used to do on its
 * own, and now does beside a tinted surface rather than instead of one; see
 * `COLOR_ANNOTATION_TINT` for why the two together read better than the gap
 * alone did.
 *
 * Its own contributed colour, not `COLOR_ANNOTATION_BORDER`: the leading
 * accent bar answers "what state is this line in" -- evaluated, stale,
 * erroring -- and switches accordingly (see `chip.leading` in `show`,
 * below), while the divider answers "where does one fact end and the next
 * begin", a question with the same answer regardless of state. Folding the
 * two into one colour would mean a reader retuning the state colour through
 * `workbench.colorCustomizations` silently retunes the punctuation too.
 * Default `#d1a35c66`: the value colour (`COLOR_RESULT`'s default amber) at
 * 40% -- struck by eye against the same rendering that settled #118's other
 * numbers, not computed from the contrast floor the tint colours answer to,
 * because a divider is a rule for the eye to catch, not text a screen
 * reader's contrast check has to pass.
 */
export const COLOR_CHIP_DIVIDER = 'evalens.chipDivider';

/**
 * The stale chip's own tint (#109), replacing `COLOR_ANNOTATION_TINT` only
 * for a value `markerFor` calls `stale`.
 *
 * A stale value is still painted in its own colour -- see `COLOR_FOR` and
 * `IDEA.md`'s rule against dimming a value, which this ticket leaves
 * untouched -- so the only thing left that can say "this has expired"
 * without competing with the text is the surface behind it. Computed the
 * way `COLOR_ANNOTATION_TINT` was, from `COLOR_PENDING`'s own grey hue
 * rather than the value's, and at roughly half its alpha (10% there, a
 * little under 6% here): not merely a different hue at the same strength,
 * but a visibly fainter surface, because a reader who missed a
 * same-strength chip once (#109's report) is not helped by one that only
 * changed colour.
 */
export const COLOR_STALE_TINT = 'evalens.staleTint';

/**
 * The stale chip's own leading-edge border (#109), replacing
 * `COLOR_ANNOTATION_BORDER` only for a value `markerFor` calls `stale`.
 *
 * The same grey `COLOR_PENDING` already uses, but under its own contributed
 * id rather than that one directly: pending and stale are different claims
 * -- "not finished yet" against "finished, but out of date" -- and a reader
 * retuning what a still-running statement looks like through
 * `workbench.colorCustomizations` should not silently retune what an
 * expired one looks like too.
 */
export const COLOR_STALE_BORDER = 'evalens.staleBorder';

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
 * Padding and rounding for the one continuous #118 chip, smuggled through
 * `textDecoration` -- the decoration API exposes no padding of its own.
 * Given per `ChipEdge` (`layers.ts`), which since #118 marks a position in
 * the WHOLE flattened run of segments and dividers rather than a position
 * within one `resultGroups` group: only the run's own two outer ends get
 * breathing room and a rounded corner (see `chipShape` below); everything
 * between them -- a group's interior, a later group's own first or last
 * segment, both of a divider's slots -- gets neither, because the tint is
 * continuous across all of it and there is no edge there to round or pad.
 *
 * Eight pixels at each outer end -- final numbers, chosen by the maintainer
 * against a rendering rather than by description: six read as a printing
 * mistake, hugging the text it was meant to set off. All horizontal, so
 * nothing here grows the inline-block vertically -- vertical padding would
 * push lines apart, which is worse than any width this settles on. The same
 * number also happens to be the divider's own clear space on each side of
 * its rule (`DIVIDER_LEAD_SHAPE` / `DIVIDER_RULE_SHAPE`, below) -- one
 * constant, reused, because #118 chose one number for "room around an edge"
 * and used it at both places that needed one, not because a chip's outer
 * padding and an interior rule's clearance are the same concern.
 *
 * The leading edge's corner is square rather than rounded, because it also
 * carries the #95 accent bar: `border-radius` rounds whatever border is
 * drawn on the same box, and a rounded corner under the bar made a short,
 * curved, text-height stroke immediately before italic text -- which the
 * maintainer correctly read as an opening parenthesis rather than as
 * structure before this was diagnosed. `leading` (see `ChipSlot`) is true
 * for exactly one segment across a whole annotation, so it is the only one
 * `chipShape` ever squares; the trailing edge, the run's other special
 * position, rounds.
 */
const CHIP_PAD = 8;

/**
 * The `textDecoration` shape for one segment, given the `ChipEdge` it
 * carries across the whole annotation (#118: no longer within its own
 * `resultGroups` group -- see `CHIP_PAD` above). Background and border are
 * separate render-option fields (see `show`, below) -- this is padding and
 * rounding only.
 *
 * Takes only the edge, not `leading` (`ChipSlot`'s other field), because
 * under one continuous chip the two now agree completely: `'first'` and
 * `'single'` are the only edges a leading segment can ever carry, and
 * `'last'` and `'middle'` are the only ones a non-leading one can. A second
 * parameter that could only ever repeat what `edge` already said would be a
 * second place for the two to quietly disagree; `show` still reads
 * `leading` on its own, because deciding whether to draw the bar is a
 * different question from deciding padding and rounding, and asks it as a
 * plain boolean rather than re-deriving it from a string.
 */
function chipShape(edge: ChipEdge): string {
  switch (edge) {
    case 'single':
      return `none; padding: 0 ${CHIP_PAD}px; border-radius: 0 3px 3px 0;`;
    case 'first':
      return `none; padding: 0 0 0 ${CHIP_PAD}px; border-radius: 0;`;
    case 'last':
      return `none; padding: 0 ${CHIP_PAD}px 0 0; border-radius: 0 3px 3px 0;`;
    case 'middle':
      return 'none; padding: 0;';
  }
}

/**
 * The two slots that make up one #118 divider between two value groups of
 * the same continuous chip -- what the untinted, three-non-breaking-space
 * `resultGroups` gap used to be painted as (#95's `CHIP_GAP_SHAPE`, now
 * gone), before the whole box became one tinted surface (see
 * `COLOR_ANNOTATION_TINT`) and the gap itself became a 1px rule.
 *
 * Two slots, not one, because a `border` always sits at the very outermost
 * edge of its own box -- outside any padding on that same side, the same
 * reason the leading edge's own accent bar has padding on only one side of
 * it (`chipShape`'s `'first'` case: the bar, then clear space, never clear
 * space before the bar). A single element carrying both `border-left` and
 * a `CHIP_PAD` padding therefore cannot put that clearance on both sides of
 * the rule it draws -- the border eats the space in front
 * of it. So the lead slot stands in for the padding a border cannot put in
 * front of itself: `CHIP_PAD` of plain tinted space and no border of its
 * own, immediately followed by the rule slot, whose own trailing padding
 * supplies the other `CHIP_PAD`. Neither slot rounds a corner or leaves the
 * annotation's continuous tint -- see `chipSlots` in `layers.ts`, which
 * `show` gives the true, two-slots-per-divider total so a divider always
 * lands on `'middle'`, never on the one leading or trailing position the
 * whole run keeps for its own two outer ends.
 *
 * Both paint `DIVIDER_TEXT`, a zero-width space, rather than truly empty
 * content -- the bug an earlier revision of this shipped, caught by the
 * maintainer pixel-probing the rendered still rather than trusting
 * `getBoundingClientRect()`: an attachment with no content at all has no
 * line box, so its horizontal-only padding still gives it a width, but its
 * *height* collapses to zero, and a zero-height box paints neither a
 * background nor a `border-left` of any width, however many pixels wide
 * its box measures. A character with real text metrics and zero advance
 * width gives the box the same text-height every other segment already
 * has -- from real content, the same reason every other segment has one --
 * while adding nothing to the 8px / 1px / 8px this geometry depends on.
 */
const DIVIDER_LEAD_SHAPE = `none; padding: 0 0 0 ${CHIP_PAD}px;`;
const DIVIDER_RULE_SHAPE = `none; padding: 0 ${CHIP_PAD}px 0 0;`;
/**
 * Content for both divider slots: a zero-width space (`U+200B`), not an
 * empty string -- see the doc comment above. It is text with zero advance
 * width in every font this renders in (a formatting character, not a
 * glyph, so no font has to cover it and no fallback-font substitution can
 * widen it the way a missing glyph would), which is what makes it safe to
 * use purely to give the box a height rather than anything to read.
 */
const DIVIDER_TEXT = '​';

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

/**
 * The `border` value for the #118 divider's own rule -- the same
 * left-only-side override as `BORDER_LEFT`, but a 1px hairline rather than a
 * 3px bar: this is punctuation between two facts already inside one chip,
 * not the accent that has to announce the chip's own state from across a
 * busy, syntax-highlighted line. Its colour is `COLOR_CHIP_DIVIDER`, set
 * where `show` builds the rule slot's `renderOptions`, never
 * `COLOR_ANNOTATION_BORDER` or `COLOR_STALE_BORDER` -- see
 * `COLOR_CHIP_DIVIDER`'s own doc comment for why the two never share one.
 */
const DIVIDER_BORDER = 'none; border-left: 1px solid;';

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
  readonly loopExplorer?: LoopExplorerWire;
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
   * Whether `display` names a place this statement bound (#81).
   *
   * `led['a'] = 1` binds a subscript, which is not an identifier, so the
   * regex that used to decide this labelled it as a bare expression result.
   * The kernel answers it from the AST instead; absent means "not a
   * binding, or a kernel that does not say", and `isBoundTarget` keeps the
   * old regex as the fallback for the second.
   */
  readonly isBinding?: boolean;
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
  readonly error?: ErrorDetails;
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
      textDecoration: chipShape('single'),
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
      textDecoration: chipShape('single'),
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
      textDecoration: chipShape('single'),
      fontStyle: 'italic',
    },
  });

  private readonly regionType = vscode.window.createTextEditorDecorationType({
    // Finished code keeps the editor's own background. Its result, state
    // icon and scrollbar mark remain; only transient feedback paints source.
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
  private readonly currentMarkerTypes: ReadonlyMap<
    Marker | 'plain', vscode.TextEditorDecorationType>;
  private readonly currentLines = new WeakMap<vscode.TextEditor, number>();

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
            // segment slot in this shared pool paints the evaluated tint on
            // one annotation and the stale or pending one on the next (or,
            // since #118, one of the divider's own two shapes), so the tint
            // has to ride the per-range `renderOptions` `show` builds below
            // rather than this one static config every slot would otherwise
            // share regardless of which annotation lands in it.
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
    this.currentMarkerTypes = new Map(([...MARKERS, 'plain'] as const).map((marker) => [
      marker,
      vscode.window.createTextEditorDecorationType({
        gutterIconSize: 'contain',
        dark: { gutterIconPath: vscode.Uri.joinPath(extensionUri,
          'media', 'gutter', `current-${marker}-dark.svg`) },
        light: { gutterIconPath: vscode.Uri.joinPath(extensionUri,
          'media', 'gutter', `current-${marker}-light.svg`) },
      }),
    ]));
  }

  markCurrentLine(
    editor: vscode.TextEditor, line: number | undefined,
    annotations: readonly Annotation[]
  ): void {
    if (line === undefined) this.currentLines.delete(editor);
    else this.currentLines.set(editor, line);
    this.paintMarkers(editor, annotations);
  }

  /** One glyph per line: VS Code can layer gutter images in the same slot.
   * A combined image keeps the short current-line tick separate from the
   * evaluated, stale or error symbol without masking either one. */
  private paintMarkers(editor: vscode.TextEditor, annotations: readonly Annotation[]): void {
    const markers = new Map<Marker, vscode.DecorationOptions[]>(
      MARKERS.map((marker) => [marker, []]));
    const selected = this.currentLines.get(editor);
    const current = selected !== undefined && annotations.some((annotation) =>
      annotation.range.start.line <= selected && annotation.range.end.line >= selected)
      ? selected : undefined;
    let currentState: Marker | 'plain' = 'plain';
    for (const annotation of annotations) {
      // Pending has no state icon: it has not produced a value yet. Nested
      // chips share the owner's state rather than adding independent icons.
      if (annotation.pending) continue;
      const line = annotation.anchor ?? annotation.range.end.line;
      const marker = markerFor(annotation);
      if (line === current) currentState = marker;
      else markers.get(marker)!.push({ range: new vscode.Range(line, 0, line, 0) });
    }
    for (const [marker, type] of this.markerTypes) {
      editor.setDecorations(type, markers.get(marker)!);
    }
    for (const [marker, type] of this.currentMarkerTypes) {
      editor.setDecorations(type, current !== undefined && marker === currentState
        ? [{ range: new vscode.Range(current, 0, current, 0) }] : []);
    }
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

    const targetColumn = resultColumn();
    // Read here rather than captured, so editing the setting takes effect on
    // the next paint the way the alignment column does.
    const label = printedLabelSetting();
    const tabSize = typeof editor.options.tabSize === 'number'
      ? editor.options.tabSize
      : 4;

    // Child chips are views of one capture, not independent annotations.
    // Only their owner paints a region/gutter mark or participates in state.
    const rows = annotations.flatMap((annotation) => {
      const histories = inlineLoopHistories(annotation);
      return [
        { annotation: histories
          ? { ...annotation, loop: histories[0]!.trace, names: [], more: 0 }
          : annotation, child: false },
        ...(histories && annotation.staleReason !== 'edited'
          ? histories.slice(1).map((history) => ({ child: true,
            annotation: {
              range: annotation.range, anchor: history.line,
              display: history.site.target, value: '', loop: history.trace,
              isBinding: true, stale: annotation.stale,
              partialFrom: annotation.partialFrom,
            } as Annotation })) : []),
      ];
    });
    for (const { annotation, child } of rows) {
      // Greyed, loud, or evaluated -- three lists rather than one, so a
      // statement is painted as exactly one of them and never two at once.
      // Which of the first two it is is `isAsking`'s question: a statement
      // merely taking a while is greyed, one blocked on the reader is not.
      if (!child) {
        if (annotation.pending) {
          (isAsking(annotation.pending) ? askingRegions : pendingRegions)
            .push({ range: annotation.range });
        } else {
          regions.push({ range: annotation.range });
        }
      }

      // End of the LINE, not end of the statement. Anchoring mid-line would
      // insert the annotation before any trailing comment and shove it
      // right, and there would be no column to align to.
      const host = editor.document.lineAt(
        annotation.anchor ?? annotation.range.end.line);
      const at = new vscode.Range(host.range.end, host.range.end);

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
        // `annotation.error` is set, so `markerFor` can only answer `error`
        // or `stale` here -- never `evaluated`. Stale outranks it (#109,
        // and see `markerFor`'s own doc comment): a red, saturated chip
        // claims the code in front of the reader raises right now, and
        // once that code has been edited nobody has checked that it still
        // does. Only the chrome recedes -- the message stays in
        // `COLOR_ERROR`, the one colour this ticket does not touch.
        const stale = markerFor(annotation) === 'stale';
        errors.push({
          range: at,
          renderOptions: {
            after: {
              margin,
              contentText: errorText(
                annotation.error.type, annotation.error.message,
                annotation.partialFrom),
              ...(stale
                ? {
                    backgroundColor: new vscode.ThemeColor(COLOR_STALE_TINT),
                    borderColor: new vscode.ThemeColor(COLOR_STALE_BORDER),
                  }
                : {}),
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
          isBinding: annotation.isBinding,
          partialFrom: annotation.partialFrom,
        }).map(coalesce).filter((group) => group.length > 0);

        // The gap `resultGroups` leaves between two groups, kept as its own
        // segment rather than let `coalesce` fold it into either neighbour
        // (#95) -- folding it in would paint three non-breaking spaces
        // inside that neighbour's own label or value. This is the plain-text
        // form only, used below for the restates-the-line comparison and as
        // the fallback body when the annotation does not fit the pool: the
        // #118 chip painted further down never paints this segment at all,
        // and draws its own hairline divider in its place instead (see
        // `DIVIDER_LEAD_SHAPE` / `DIVIDER_RULE_SHAPE`) -- painting a divider
        // costs two slots of the pool where this text form costs one, which
        // is exactly why the two are counted separately below rather than
        // both being read off `flat.length`.
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
          // The true cost of painting every group as one #118 chip: one slot
          // per content segment, and -- since #118 -- two per divider
          // between two groups, not `flat.length`'s one (see `gapSegment`
          // above). Beyond the pool there is no type left to paint in, so
          // the line falls back to the rendering this replaced: one
          // attachment, one colour, every character still there. Less
          // legible, never wrong. A single chip, and it is the annotation's
          // own leading edge.
          const contentCount = groups.reduce(
            (total, group) => total + group.length, 0);
          const dividerCount = Math.max(0, groups.length - 1);
          const fits = contentCount + dividerCount * 2 <= results.length;
          const paintedGroups: readonly (readonly Segment[])[] = fits
            ? groups
            : [[{ role: 'value', text }]];
          // `annotation.error` is undefined on this branch (it is handled
          // above), so `markerFor` can only answer `evaluated` or `stale`
          // here -- exactly the two states a chip's own chrome has to tell
          // apart (#109). Both colours belong to the chip, never to the
          // text: `COLOR_FOR[segment.role]` below is unconditional, so what
          // recedes when a value goes stale is only the surface around it.
          // The divider's own rule never joins this switch -- it keeps
          // `COLOR_CHIP_DIVIDER` regardless of state, see that colour's doc
          // comment.
          const stale = markerFor(annotation) === 'stale';
          const borderColor = stale
            ? COLOR_STALE_BORDER
            : COLOR_ANNOTATION_BORDER;
          const tintColor = stale ? COLOR_STALE_TINT : COLOR_ANNOTATION_TINT;

          // Computed once, across every slot the annotation paints in --
          // content and dividers alike -- because #118 paints one continuous
          // chip rather than one per group: see `chipSlots` in `layers.ts`.
          const edges = chipSlots(fits ? contentCount + dividerCount * 2 : 1);
          let slot = 0;
          paintedGroups.forEach((group, groupIndex) => {
            if (fits && groupIndex > 0) {
              // The #118 divider between two chips takes two slots of its
              // own -- see `DIVIDER_LEAD_SHAPE` for why one rule needs two
              // -- painted with the same tint as every other segment and
              // none of a chip's own outer padding or rounding: `edges` puts
              // both on `'middle'`, since a divider can never be the whole
              // run's own leading or trailing slot (`groups` never carries
              // an empty group for one to follow or precede).
              results[slot]!.push({
                range: at,
                renderOptions: {
                  after: {
                    contentText: DIVIDER_TEXT,
                    color: new vscode.ThemeColor(COLOR_FOR[gapSegment.role]),
                    backgroundColor: new vscode.ThemeColor(tintColor),
                    textDecoration: DIVIDER_LEAD_SHAPE,
                  },
                },
              });
              slot += 1;
              results[slot]!.push({
                range: at,
                renderOptions: {
                  after: {
                    contentText: DIVIDER_TEXT,
                    color: new vscode.ThemeColor(COLOR_FOR[gapSegment.role]),
                    backgroundColor: new vscode.ThemeColor(tintColor),
                    border: DIVIDER_BORDER,
                    borderColor: new vscode.ThemeColor(COLOR_CHIP_DIVIDER),
                    textDecoration: DIVIDER_RULE_SHAPE,
                  },
                },
              });
              slot += 1;
            }
            group.forEach((segment) => {
              const chip = edges[slot]!;
              results[slot]!.push({
                range: at,
                renderOptions: {
                  after: {
                    // Only the very first segment of the whole annotation is
                    // pushed out to the alignment column and carries the #95
                    // bar -- `chip.leading` and `slot === 0` are the same
                    // fact, since neither a divider's slots nor a later
                    // group's first segment can ever be slot 0.
                    ...(slot === 0 ? { margin } : {}),
                    ...(chip.leading
                      ? {
                          border: BORDER_LEFT,
                          borderColor: new vscode.ThemeColor(borderColor),
                        }
                      : {}),
                    contentText: segment.text,
                    color: new vscode.ThemeColor(COLOR_FOR[segment.role]),
                    backgroundColor: new vscode.ThemeColor(tintColor),
                    textDecoration: chipShape(chip.edge),
                  },
                },
              });
              slot += 1;
            });
          });
        }
      }
      // A statement with nothing to show still gets its gutter and scrollbar
      // marks. It ran; there is simply no value to report.
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
    this.paintMarkers(editor, annotations);
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
    for (const type of this.currentMarkerTypes.values()) {
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
