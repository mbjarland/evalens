import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  Attempt, Candidate, ProbeResult, chooseInterpreter, describeFailure,
  isSupported,
} from '../python';

const works = (major: number, minor: number): ProbeResult =>
  ({ ok: true, version: [major, minor] });
const missing: ProbeResult = { ok: false, reason: 'not found' };

function prober(answers: Record<string, ProbeResult>) {
  const asked: string[] = [];
  const probe = async (path: string): Promise<ProbeResult> => {
    asked.push(path);
    return answers[path] ?? missing;
  };
  return { probe, asked };
}

const PYTHON_EXT: Candidate = { path: 'python', source: 'the Python extension' };
const PATH3: Candidate = { path: 'python3', source: 'PATH' };

test('a candidate that does not exist falls through to one that does', async () => {
  // The actual bug: the Python extension reports a bare `python` when it has
  // nothing resolved, and stopping at the first candidate OFFERED meant the
  // working python3 was never reached.
  const { probe, asked } = prober({ python3: works(3, 12) });
  const choice = await chooseInterpreter([PYTHON_EXT, PATH3], probe);

  assert.equal(choice.ok, true);
  assert.equal((choice as { path: string }).path, 'python3');
  assert.deepEqual(asked, ['python', 'python3']);
});

test('a configured interpreter that fails is not fallen past', async () => {
  // Silently using a different one hides a misconfiguration the user needs
  // to know about.
  const { probe, asked } = prober({ python3: works(3, 12) });
  const choice = await chooseInterpreter(
    [{ path: '/nope/python', source: 'the evalens.pythonPath setting', explicit: true },
     PATH3],
    probe);

  assert.equal(choice.ok, false);
  assert.deepEqual(asked, ['/nope/python'], 'must not try further candidates');
});

test('a configured interpreter that works is used', async () => {
  const { probe } = prober({ '/venv/bin/python': works(3, 11) });
  const choice = await chooseInterpreter(
    [{ path: '/venv/bin/python', source: 'the evalens.pythonPath setting', explicit: true }],
    probe);
  assert.equal((choice as { path: string }).path, '/venv/bin/python');
});

test('a Python 2 is rejected rather than failing later on syntax', async () => {
  const { probe } = prober({ python: works(2, 7), python3: works(3, 13) });
  const choice = await chooseInterpreter([PYTHON_EXT, PATH3], probe);
  assert.equal((choice as { path: string }).path, 'python3');
});

test('a Python below the floor is rejected', async () => {
  // 3.9 is the floor because the resolver needs ast.unparse.
  assert.equal(isSupported([3, 8]), false);
  assert.equal(isSupported([3, 9]), true);
  assert.equal(isSupported([4, 0]), true);
  assert.equal(isSupported([2, 7]), false);
});

test('empty candidates are skipped, not probed', async () => {
  const { probe, asked } = prober({ python3: works(3, 12) });
  await chooseInterpreter([{ path: '  ', source: 'setting' }, PATH3], probe);
  assert.deepEqual(asked, ['python3']);
});

test('the failure names every attempt and why it failed', async () => {
  const { probe } = prober({ python: works(2, 7) });
  const choice = await chooseInterpreter([PYTHON_EXT, PATH3], probe);
  const message = describeFailure(
    (choice as { attempts: readonly Attempt[] }).attempts);

  assert.match(message, /python \(the Python extension\) - Python 2\.7 is too old/);
  assert.match(message, /python3 \(PATH\) - not found/);
});

test('nothing to try at all still produces a message', () => {
  assert.match(describeFailure([]), /no Python interpreter/);
});
