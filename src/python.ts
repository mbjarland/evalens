/**
 * Choosing an interpreter, and being able to say why.
 *
 * Getting this wrong makes the whole extension non-functional in the one
 * component the user cannot see, so the chain is probed rather than assumed:
 * every candidate is asked what version it is instead of being taken at its
 * word. That catches three failures that would otherwise surface as three
 * unrelated-looking errors -- a path that does not exist, a Python 2, and a
 * Python below the floor `ast.unparse` needs.
 *
 * No `vscode` import: the ordering rules are the part worth testing.
 */

/** `ast.unparse`, which the resolver depends on. */
export const MINIMUM_PYTHON: readonly [number, number] = [3, 9];

export interface Candidate {
  readonly path: string;
  /** Where this came from, for the message when nothing works. */
  readonly source: string;
  /**
   * True for an interpreter the user named. A configured interpreter that
   * fails is a hard error rather than something to fall past -- silently
   * using a different one hides a misconfiguration they need to know about.
   */
  readonly explicit?: boolean;
}

export type ProbeResult =
  | { readonly ok: true; readonly version: readonly [number, number] }
  | { readonly ok: false; readonly reason: string };

export interface Attempt {
  readonly candidate: Candidate;
  readonly reason: string;
}

export type Choice =
  | {
      readonly ok: true;
      readonly path: string;
      readonly source: string;
      readonly version: readonly [number, number];
    }
  | { readonly ok: false; readonly attempts: readonly Attempt[] };

export function isSupported(version: readonly [number, number]): boolean {
  const [major, minor] = version;
  const [minMajor, minMinor] = MINIMUM_PYTHON;
  return major > minMajor || (major === minMajor && minor >= minMinor);
}

function tooOld(version: readonly [number, number]): string {
  return `Python ${version[0]}.${version[1]} is too old ` +
    `(Evalens needs ${MINIMUM_PYTHON[0]}.${MINIMUM_PYTHON[1]} or later)`;
}

/**
 * The first candidate that actually runs.
 *
 * Stopping at the first candidate *offered* was the bug: the Python
 * extension reports a bare `python` when it has nothing resolved, and on a
 * machine with only `python3` that meant the working fallback was never
 * reached.
 */
export async function chooseInterpreter(
  candidates: readonly Candidate[],
  probe: (path: string) => Promise<ProbeResult>
): Promise<Choice> {
  const attempts: Attempt[] = [];

  for (const candidate of candidates) {
    if (candidate.path.trim() === '') {
      continue;
    }
    const result = await probe(candidate.path);

    if (result.ok && isSupported(result.version)) {
      return {
        ok: true,
        path: candidate.path,
        source: candidate.source,
        version: result.version,
      };
    }

    const reason = result.ok ? tooOld(result.version) : result.reason;
    attempts.push({ candidate, reason });

    if (candidate.explicit) {
      // Named by the user. Falling past it would hide the misconfiguration.
      return { ok: false, attempts };
    }
  }

  return { ok: false, attempts };
}

/** The failure, written so it names what to fix. */
export function describeFailure(attempts: readonly Attempt[]): string {
  if (attempts.length === 0) {
    return 'Evalens found no Python interpreter to try.';
  }
  const lines = attempts.map(
    (a) => `  ${a.candidate.path} (${a.candidate.source}) - ${a.reason}`);
  return ['Evalens could not start a Python kernel. Tried:', ...lines].join('\n');
}
