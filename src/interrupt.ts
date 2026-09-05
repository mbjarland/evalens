/**
 * The two decisions behind the Cancel affordance, kept away from the editor so
 * that both can be checked without one: when an evaluation has been slow
 * enough to be worth interrupting, and what to tell the user an interrupt
 * actually did.
 *
 * Nothing here imports `vscode`.
 */

/**
 * What an interrupt did, which is not always what was asked for.
 *
 * `interrupted` is the good case and the only one that claims anything: the
 * kernel acknowledged on the control channel, raised `KeyboardInterrupt` in
 * the running code, and the evaluation failed like any other failure --
 * leaving the namespace the session had built up exactly where it was.
 * `unconfirmed` is an interrupt that went out and was never acknowledged.
 * `idle` means there was nothing to stop.
 *
 * The distinction exists to be *said*. A Cancel button that silently does
 * something other than what the user expects is worse than no button at all.
 *
 * Note what `interrupted` does not claim. The kernel acknowledges from its
 * control thread, so the acknowledgement means "heard", not "stopped" -- a
 * tight loop inside a C extension will take the interrupt when it feels like
 * it. That is the honest limit of what any message here could promise.
 */
export type InterruptOutcome = 'idle' | 'interrupted' | 'unconfirmed';

export function describeInterrupt(outcome: InterruptOutcome): string {
  switch (outcome) {
    case 'idle':
      return 'Evalens: nothing is running';
    case 'interrupted':
      return 'Evalens: interrupted; the namespace is intact';
    case 'unconfirmed':
      return (
        'Evalens: the interrupt was sent but the kernel did not answer — ' +
        'if it stays stuck, Evalens: Restart Kernel will stop it and lose ' +
        'the namespace'
      );
  }
}

/**
 * True if `work` settled within `delayMs`, false if it is still running.
 *
 * This is the whole "progress UI, but only when it is slow" rule. Almost every
 * evaluation finishes in milliseconds, and a notification on each one would be
 * intolerable -- so the notification is not shown until an evaluation has
 * already failed to finish, at which point it is the only sign anything is
 * happening at all.
 *
 * A rejection counts as settled. Two seconds spent failing is still two
 * seconds of nothing on screen, and a notification whose work has already
 * blown up must come down either way. Handling both outcomes here is also what
 * keeps this from raising an unhandled rejection beside the caller's own catch.
 */
export function settlesWithin<T>(
  work: Promise<T>, delayMs: number
): Promise<boolean> {
  if (delayMs <= 0) {
    // Zero is "show it straight away", not "wait zero milliseconds and hope
    // the microtask queue is on our side".
    return Promise.resolve(false);
  }
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), delayMs);
    const settled = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    work.then(settled, settled);
  });
}
