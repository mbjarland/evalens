import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  KNOWN_CONFLICTS, advanceEntries, detectConflicts, keybindingSnippet,
} from '../keybindings';

const root = path.resolve(__dirname, '..', '..');
const manifest = JSON.parse(
  fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');

/** The text under one `## ` heading, up to the next one. */
function section(heading: string): string {
  const start = readme.indexOf(`## ${heading}\n`);
  assert.notEqual(start, -1, `README has no "## ${heading}" section`);
  const rest = readme.slice(start + heading.length + 4);
  const end = rest.indexOf('\n## ');
  return end === -1 ? rest : rest.slice(0, end);
}

test('every contributed command is in the README', () => {
  // A command nobody can find is a command that does not exist, and the
  // palette is the fallback for a user whose keybinding was stolen.
  const titles: string[] =
    (manifest.contributes?.commands ?? []).map((c: { title: string }) => c.title);
  assert.ok(titles.length > 0, 'no commands contributed');

  for (const title of titles) {
    assert.ok(readme.includes(title), `${title} is not in the README`);
  }
});

test('the README says every command is in the Command Palette', () => {
  assert.match(readme, /Command Palette/);
});

test('the keybinding conflict is stated next to the table, not footnoted', () => {
  // The whole failure mode is a silently dead key. A user who reads the
  // keybinding table and stops reading has to have been told there already;
  // a troubleshooting section at the bottom is read after the damage.
  const keybindings = section('Keybindings');

  for (const conflict of KNOWN_CONFLICTS) {
    assert.ok(keybindings.includes(conflict.extensionId),
      `${conflict.extensionId} is not named in the keybindings section`);
    assert.ok(keybindings.includes(conflict.command),
      `${conflict.command} is not named in the keybindings section`);
  }
  assert.match(keybindings, /load order/);
});

test('the README shows the fix the extension hands out, verbatim', () => {
  // Two copies of a JSON snippet drift, and the one in the README is the copy
  // people paste. This fails the build instead.
  const snippet = keybindingSnippet(
    'mac', detectConflicts((id) => id === 'almenon.arepl', 'mac'));
  assert.ok(readme.includes(snippet),
    'the README keybinding block is not what keybindingSnippet produces');
});

test('the README documents the key the manifest actually binds', () => {
  const keybindings = section('Keybindings');
  assert.match(keybindings, /Cmd\+Enter/);
  assert.match(keybindings, /Ctrl\+Enter/);
  assert.match(keybindings, /Cmd\+Shift\+Enter/);
  assert.match(keybindings, /Ctrl\+Shift\+Enter/);
});

test('the README says why the advance key is not shift+enter', () => {
  // The convention says shift+enter, so a reader who knows the neighbourhood
  // will assume we simply got it wrong. The four commands already sitting
  // there are the answer, and they belong beside the table rather than in a
  // commit message nobody reads.
  const keybindings = section('Keybindings');
  assert.match(keybindings, /Shift\+Enter/);
  for (const command of [
    'python.execSelectionInTerminal', 'python.execInREPL',
    'jupyter.execSelectionInteractive', 'jupyter.runcurrentcelladvance',
  ]) {
    assert.ok(keybindings.includes(command),
      `${command} is not named as a claimant of shift+enter`);
  }
});

test('the README shows the user binding that settles the advance key', () => {
  // Windows and Linux get what #45 gave AREPL: the fix stated where the
  // conflict is, in a form that can be pasted. Built from the same constants
  // the manifest is checked against, so the block cannot drift from the key,
  // the command or the context.
  for (const entry of advanceEntries('other')) {
    const json = JSON.stringify(entry, null, 2)
      .split('\n').map((line) => `  ${line}`).join('\n');
    assert.ok(readme.includes(json),
      `the README does not show this entry verbatim:\n${json}`);
  }
});
