import { KernelError } from '../kernel/protocol';

/** The captured identity metadata needed alongside an error's original text. */
export type ErrorDetails = Pick<KernelError, 'type' | 'message' | 'builtinType'>;

export function errorDetails(error: ErrorDetails): ErrorDetails {
  return {
    type: error.type,
    message: error.message,
    ...(error.builtinType === undefined ? {} : { builtinType: error.builtinType }),
  };
}

/** Explain an exact built-in category, never diagnose from user-controlled
 * messages, class names or traceback text. Older kernels and custom classes
 * carry no identity metadata, so their presentation remains unchanged. */
export function errorGuidance(error: ErrorDetails | undefined): string | undefined {
  if (!error || error.type !== error.builtinType) return undefined;
  switch (error.builtinType) {
    case 'NameError':
      return 'Python uses NameError when it cannot find a referenced name. '
        + 'Check its spelling and whether the statement that defines it has run.\n\n'
        + '**Evalens: Evaluate Above Cursor** is a possible next step: it resets '
        + 'state and runs earlier statements, stopping at the first failure. '
        + 'Run it only when you want those statements to execute.';
    case 'ValueError':
      return 'Python uses ValueError when an operation receives a value it '
        + 'cannot accept. For example, `int("hello")` cannot convert that text '
        + 'to an integer. Check the original error message for details about '
        + 'the operation that failed.';
    default:
      return undefined;
  }
}
