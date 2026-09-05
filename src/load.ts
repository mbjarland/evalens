/**
 * One file load's outcomes, handed to the painter in file order and once each.
 *
 * A load arrives twice over. Each statement is announced on the control
 * channel the moment it finishes -- which is the point of streaming it, and is
 * what puts values on lines 1-46 before line 47 stops to ask the reader for a
 * name -- and the whole set arrives again in the response's `results` when the
 * load is over. This is the one place that decides which of the two paints
 * what, and the decision is not "whichever came first wins" but an invariant:
 *
 * > **the painter is offered statements 0, 1, 2, … strictly ascending, exactly
 * > once each, and never anything else.**
 *
 * ## Why that has to be enforced rather than trusted
 *
 * Repeat suppression (#28) decides whether to paint a `name: value` pair by
 * comparing it against what was last painted for that name *above* it, so the
 * suppressor's state is a function of the order it was fed. Feed it line 30
 * before line 12 and it suppresses the wrong one -- and nothing on screen says
 * which annotation is missing, because a suppressed annotation looks exactly
 * like a statement that had nothing to say. It is invisible in a test that
 * checks a range and obvious in a file, which is the worst combination this
 * project has a rule about.
 *
 * Three things can reorder or lose a frame, and none of them are exotic:
 *
 * - **The two channels are two pipes.** A statement frame and the response
 *   that follows it are written to different file descriptors, and nothing
 *   orders one against the other, so the response can be delivered first and
 *   `results` can reach the painter while frames are still queued behind it.
 * - **A kernel with no control channel sends no frames at all**, and the whole
 *   load arrives as `results`. That is the old behaviour and it must stay
 *   exactly as correct as it was.
 * - **A frame can simply be missing** -- an unparseable control line, a kernel
 *   restarted mid-load. Counting arrivals would then shift every annotation
 *   below the gap onto the wrong statement without anything noticing.
 *
 * So the index the kernel puts on each frame is load-bearing rather than
 * decoration, and this refuses what does not fit it: a frame for a statement
 * already painted is dropped, and a frame that skips one stops the streaming
 * path outright and leaves the rest to `results`, which is ordered by
 * construction. The invariant holds in every one of those cases, and the worst
 * that a lost frame costs is that the file stops painting progressively and
 * paints all at once at the end -- which is exactly where this started.
 *
 * Pure on purpose, like `repeats.ts` and for the same reason: it is a decision
 * about what the reader sees, it has a right answer that can be checked
 * without an editor, and the editor shell is the one place it could not be
 * tested.
 */

export class InOrder<T> {
  /** How many statements have been handed on: also the only index accepted. */
  private taken = 0;
  /** A frame skipped one, so the streaming path is over for this load. */
  private missed = false;

  /**
   * `paint` is called synchronously, once per statement, ascending. It must
   * not be given anything else -- see the invariant above.
   */
  constructor(private readonly paint: (outcome: T, index: number) => void) {}

  /** How many statements have been painted so far. */
  get painted(): number {
    return this.taken;
  }

  /**
   * Whether a frame arrived out of turn, so this load stopped streaming.
   *
   * Not an error and not reported to the user: the load still paints
   * everything, just all at once when `settle` runs. It is here because a
   * silent fallback nobody can observe is a silent fallback nobody can debug.
   */
  get interrupted(): boolean {
    return this.missed;
  }

  /**
   * A frame arrived claiming to be statement `index`.
   *
   * Answers whether it was painted, which is what a test asserts on and what
   * makes the two refusals distinguishable from the outside.
   */
  offer(index: number, outcome: T): boolean {
    if (index < this.taken) {
      // Already painted. The ordinary cause is the response overtaking the
      // last frames across the two pipes, which is expected rather than
      // anomalous -- `settle` painted them, and this is the frame arriving to
      // find the job done.
      return false;
    }
    if (this.missed || index > this.taken) {
      // A frame for a statement whose predecessor never arrived. Painting it
      // would put the suppressor one statement out of step for the rest of the
      // file, so the streaming path stops here and `settle` finishes the load
      // in order.
      this.missed = true;
      return false;
    }
    this.taken += 1;
    this.paint(outcome, index);
    return true;
  }

  /**
   * The load is over: paint everything the frames did not.
   *
   * `outcomes` is the response's `results`, which is the whole load in file
   * order. Starting at `taken` rather than at zero is what keeps a statement
   * from being painted twice, and walking to the end in order is what keeps
   * the invariant true for every statement no frame delivered -- including all
   * of them, which is a kernel with no control channel.
   */
  settle(outcomes: readonly T[]): void {
    for (let index = this.taken; index < outcomes.length; index++) {
      // `taken` is advanced with each paint rather than after the loop, so a
      // frame delivered while this runs cannot repaint what it has just done.
      this.taken = index + 1;
      this.paint(outcomes[index]!, index);
    }
  }
}
