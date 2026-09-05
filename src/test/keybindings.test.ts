import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  EVALUATE_AT_CURSOR, EVALUATE_WHEN, KNOWN_CONFLICTS, KnownConflict,
  conflictMessage, describeConflicts, detectConflicts, evaluateKey,
  keybindingEntries, keybindingSnippet, keybindingsQuery, platformOf,
} from '../keybindings';

const AREPL = 'almenon.arepl';
const JUPYTER = 'ms-toolsai.jupyter';

const only = (...ids: string[]) => (id: string) => ids.includes(id);
const nothing = () => false;

/** The snippet is JSON with comments; strip them and it must still parse. */
function parseSnippet(snippet: string): unknown {
  const withoutComments = snippet
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  return JSON.parse(`[${withoutComments}]`);
}

test('the platform is decided by process.platform, not by guessing', () => {
  assert.equal(platformOf('darwin'), 'mac');
  assert.equal(platformOf('win32'), 'other');
  assert.equal(platformOf('linux'), 'other');
  assert.equal(platformOf('freebsd'), 'other');
});

test('the key is cmd+enter on macOS and ctrl+enter everywhere else', () => {
  assert.equal(evaluateKey('mac'), 'cmd+enter');
  assert.equal(evaluateKey('other'), 'ctrl+enter');
});

test('AREPL is detected on both platforms when it is installed', () => {
  for (const platform of ['mac', 'other'] as const) {
    const found = detectConflicts(only(AREPL), platform);
    assert.equal(found.length, 1, `expected AREPL on ${platform}`);
    assert.equal(found[0].extensionId, AREPL);
  }
});

test('nothing is reported on a machine without the conflicting extension', () => {
  assert.deepEqual(detectConflicts(nothing, 'mac'), []);
  assert.deepEqual(detectConflicts(nothing, 'other'), []);
});

test('Jupyter is documented but never notified about', () => {
  // Its overlap is real, and the README says so. It bites only inside a file
  // with `# %%` cells, though, and Jupyter is installed on a large share of
  // Python setups -- a notification most of them cannot act on is how users
  // learn to dismiss the one that matters.
  const jupyter = KNOWN_CONFLICTS.find((c) => c.extensionId === JUPYTER);
  assert.ok(jupyter, 'Jupyter must stay in the table for the README');
  assert.equal(jupyter.notify, false);
  assert.deepEqual(detectConflicts(only(JUPYTER), 'other'), []);
  assert.deepEqual(detectConflicts(only(JUPYTER, AREPL), 'other').length, 1);
});

test('Jupyter overlaps only where our key is ctrl+enter', () => {
  // It ships no `mac` override, so on macOS it sits on ctrl+enter while we
  // sit on cmd+enter, and the two never meet.
  const jupyter = KNOWN_CONFLICTS.find((c) => c.extensionId === JUPYTER);
  assert.deepEqual(jupyter?.platforms, ['other']);
});

test('the fix binds our command on this platform, in the manifest context', () => {
  const [ours] = keybindingEntries('mac');
  assert.deepEqual(ours, {
    key: 'cmd+enter',
    command: EVALUATE_AT_CURSOR,
    when: EVALUATE_WHEN,
  });
  assert.equal(keybindingEntries('other')[0].key, 'ctrl+enter');
});

test('each conflict also gets a removal entry, on that binding\'s own when', () => {
  // Ours only wins where its `when` holds, so without the removal AREPL still
  // answers with the find widget open -- a dead key in a different disguise.
  const conflicts = detectConflicts(only(AREPL), 'mac');
  const entries = keybindingEntries('mac', conflicts);

  assert.equal(entries.length, 2);
  assert.deepEqual(entries[1], {
    key: 'cmd+enter',
    command: '-extension.executeAREPLBlock',
    when: 'editorTextFocus && editorLangId == python',
  });
  assert.notEqual(entries[1].when, EVALUATE_WHEN);
});

test('the snippet is what those entries say, once its comments are stripped', () => {
  const conflicts = detectConflicts(only(AREPL), 'other');
  const snippet = keybindingSnippet('other', conflicts);

  assert.deepEqual(parseSnippet(snippet), keybindingEntries('other', conflicts));
});

test('the snippet parses with no conflicts detected at all', () => {
  // The palette command hands it out on any machine, including one whose key
  // was taken by an extension nobody here has heard of.
  assert.deepEqual(parseSnippet(keybindingSnippet('mac')), keybindingEntries('mac'));
});

test('the snippet names what each removal removes', () => {
  // A user is about to paste this into their own file. A line saying which
  // extension loses its key, and that deleting the line undoes it, is the
  // difference between explicit and merely reversible.
  const snippet = keybindingSnippet('mac', detectConflicts(only(AREPL), 'mac'));
  const prose = snippet.replace(/\n\s*\/\/ /g, ' ');
  assert.match(prose, /AREPL's binding/);
  assert.match(prose, /Delete this entry to keep it/);
});

test('the keybindings query filters that editor to our key', () => {
  // `@keybinding:` is a filter the keybindings editor implements, so this
  // opens on the conflict rather than on a search box.
  assert.equal(keybindingsQuery('mac'), '@keybinding:cmd+enter');
  assert.equal(keybindingsQuery('other'), '@keybinding:ctrl+enter');
});

test('the notification names the extension, the key, and the command', () => {
  const message = conflictMessage(detectConflicts(only(AREPL), 'mac'), 'mac');
  assert.match(message, /AREPL/);
  assert.match(message, /cmd\+enter/);
  assert.match(message, /Evaluate at Cursor/);
});

test('two conflicts are named together rather than in two notifications', () => {
  const both: KnownConflict[] = [
    { ...KNOWN_CONFLICTS[0] },
    { ...KNOWN_CONFLICTS[1], notify: true },
  ];
  assert.match(conflictMessage(both, 'other'), /AREPL and Jupyter/);
});

test('the log line carries the identity, the reason, and the whole fix', () => {
  // The notification shows once ever; this is the way back for a user who
  // dismissed it, and the log line whose absence made the bug take three
  // rounds of diagnosis to find.
  const conflicts = detectConflicts(only(AREPL), 'mac');
  const log = describeConflicts(conflicts, 'mac');

  assert.match(log, /almenon\.arepl/);
  assert.match(log, /extension\.executeAREPLBlock/);
  assert.match(log, /load order/);
  assert.ok(log.includes(keybindingSnippet('mac', conflicts)),
    'the log must contain the fix, not a pointer to it');
});
