import { test } from 'node:test';
import assert from 'node:assert/strict';

import { InspectChild, Inspected } from '../kernel/protocol';
import {
  breadcrumbTitle, hasMoreToExplore, inspectionTable, isInspectableName,
  quickPickItems,
} from '../render/inspector';

function child(over: Partial<InspectChild> = {}): InspectChild {
  return {
    name: 'host', kind: 'attr', type: 'str', value: "'localhost'",
    expandable: false, step: { kind: 'attr', name: 'host' },
    ...over,
  };
}

function inspected(over: Partial<Inspected> = {}): Inspected {
  return {
    id: 1, ok: true, type: 'dict', value: "{'host': 'localhost'}",
    children: [child()], count: 1, truncated: false,
    ...over,
  };
}

// -- isInspectableName --------------------------------------------------------

test('a bare name is inspectable', () => {
  assert.equal(isInspectableName('config'), true);
  assert.equal(isInspectableName('_private'), true);
  assert.equal(isInspectableName('x9'), true);
});

test('anything that is not a bare name is not, without asking the kernel', () => {
  // Every one of these is exactly the shape design rule 3 forbids evaluating
  // again: an attribute, a subscript, a tuple target, a call, a literal.
  for (const display of [
    'self.x', "d['key']", 'a, b', 'print(x)', '42', '', '  ',
  ]) {
    assert.equal(isInspectableName(display), false, display);
  }
});

test('null and undefined are not inspectable, and narrow the type', () => {
  assert.equal(isInspectableName(null), false);
  assert.equal(isInspectableName(undefined), false);
});

// -- inspectionTable ----------------------------------------------------------

test('an empty set of children renders no table at all', () => {
  assert.equal(inspectionTable(inspected({ children: [] })), undefined);
});

test('a table has one row per child, with type in braces', () => {
  const table = inspectionTable(inspected({
    children: [
      child({ name: "'host'", type: 'str', value: "'localhost'" }),
      child({ name: "'port'", type: 'int', value: '8080' }),
    ],
  }))!;
  assert.match(table, /\| Field \| Type \| Value \|/);
  assert.match(table, /\| 'host' \| \{str\} \| 'localhost' \|/);
  assert.match(table, /\| 'port' \| \{int\} \| 8080 \|/);
});

test('a property is shown as not evaluated, never with a value', () => {
  const table = inspectionTable(inspected({
    children: [child({
      name: 'url', kind: 'property', type: 'property', value: null,
      expandable: false, evaluated: false, step: undefined,
    })],
  }))!;
  assert.match(table, /\| url \| \{property\} \| \*not evaluated\* \|/);
});

test('a pipe in a value cannot break the table', () => {
  const table = inspectionTable(inspected({
    children: [child({ value: "'a | b'" })],
  }))!;
  // Exactly one row of data plus the two header lines -- a literal `|`
  // that survived unescaped would read as extra table columns or rows.
  assert.equal(table.split('\n').length, 3);
  assert.match(table, /'a \\\| b'/);
});

test('a newline in a value does not break the table into extra rows', () => {
  const table = inspectionTable(inspected({
    children: [child({ value: "'line one\\nline two'" })],
  }))!;
  assert.equal(table.split('\n').length, 3);
});

test('a truncated table says how much it left out, with a real count', () => {
  const table = inspectionTable(inspected({
    children: [child()], count: 5_000_000, truncated: true,
  }))!;
  assert.match(table, /… and 4,999,999 more/);
});

test('an untruncated table carries no such note', () => {
  const table = inspectionTable(inspected({ truncated: false }))!;
  assert.doesNotMatch(table, /more\*/);
});

// -- hasMoreToExplore ----------------------------------------------------------

test('a flat, fully shown table has nothing more to explore', () => {
  assert.equal(hasMoreToExplore(inspected({
    children: [child({ expandable: false })], truncated: false,
  })), false);
});

test('a truncated table always has more to explore', () => {
  assert.equal(hasMoreToExplore(inspected({ truncated: true })), true);
});

test('an expandable child is itself a reason to explore further', () => {
  assert.equal(hasMoreToExplore(inspected({
    children: [child({ expandable: true })], truncated: false,
  })), true);
});

// -- quickPickItems -------------------------------------------------------------

test('an expandable row is marked with a chevron; a leaf is not', () => {
  const items = quickPickItems(inspected({
    children: [
      child({ name: 'inner', expandable: true }),
      child({ name: 'leaf', expandable: false }),
    ],
  }));
  assert.equal(items[0]!.label, '$(chevron-right) inner');
  assert.equal(items[1]!.label, 'leaf');
});

test('every item keeps the child it came from, step included', () => {
  const theChild = child({ name: 'host' });
  const items = quickPickItems(inspected({ children: [theChild] }));
  assert.deepEqual(items[0]!.child, theChild);
});

test('a property item says it is not evaluated instead of showing a value', () => {
  const items = quickPickItems(inspected({
    children: [child({
      name: 'url', kind: 'property', evaluated: false, value: null,
    })],
  }));
  assert.equal(items[0]!.detail, 'not evaluated');
});

// -- breadcrumbTitle -------------------------------------------------------------

test('a breadcrumb reads root, then each name picked along the way', () => {
  assert.equal(breadcrumbTitle(['user', 'address']), 'user › address');
  assert.equal(breadcrumbTitle(['user']), 'user');
});
