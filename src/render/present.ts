import { EvalResponse, Range } from '../kernel/protocol';

/**
 * What to show for a kernel response.
 *
 * Separated from the editor so the decision -- which of the kernel's four
 * answer shapes maps to which of three presentations -- can be checked
 * without one. The shapes are easy to get subtly wrong: "ran, nothing to
 * show" and "nothing to run" look alike in a response and must not look alike
 * on screen.
 */
export type Presentation =
  | { readonly kind: 'nothing'; readonly message: string }
  | {
      readonly kind: 'value';
      readonly range: Range;
      /** null when the statement ran but has nothing to display. */
      readonly value: string | null;
      readonly hover?: string;
    }
  | {
      readonly kind: 'error';
      readonly range: Range;
      readonly type: string;
      readonly message: string;
      readonly hover: string;
    };

function atLine(line: number): Range {
  return { start: { line, character: 0 }, end: { line, character: 0 } };
}

export function present(response: EvalResponse, cursorLine: number): Presentation {
  if (response.ok === false) {
    return {
      kind: 'error',
      // A protocol-level failure carries no range; anchor it where the user
      // was looking rather than dropping it silently.
      range: response.range ?? atLine(cursorLine),
      type: response.error.type,
      message: response.error.message,
      hover: response.error.traceback || response.error.message,
    };
  }

  if (response.resolved === false) {
    // A blank line. Not an error, and not a reason to paint anything -- but
    // the user pressed a key and deserves to know it was received.
    return { kind: 'nothing', message: 'Evalens: nothing to evaluate here' };
  }

  return {
    kind: 'value',
    range: response.range,
    value: response.value,
    ...(response.value === null
      ? {}
      : { hover: hoverFor(response.display, response.value) }),
  };
}

function hoverFor(display: string | null, value: string): string {
  // The hover shows the full, unwrapped value; the inline annotation is a
  // one-line summary of it.
  return display ? `${display} = ${value}` : value;
}
