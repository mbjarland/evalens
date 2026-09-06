import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TableWire } from '../kernel/protocol';
import { tableMarkdown } from '../render/table';

function table(overrides: Partial<TableWire> = {}): TableWire {
  return {
    kind: 'records',
    columns: ['name', 'age'],
    rows: [['Ada', '36'], ['Alan', '41']],
    row_count: 2,
    shown_rows: 2,
    col_count: 2,
    shown_cols: 2,
    ...overrides,
  };
}

test('a fully shown table states the exact row count', () => {
  const markdown = tableMarkdown(table());
  assert.match(markdown, /\*records — 2 rows\*/);
});

test('a single row is not pluralised', () => {
  const markdown = tableMarkdown(table({
    rows: [['Ada', '36']], row_count: 1, shown_rows: 1,
  }));
  assert.match(markdown, /\*records — 1 row\*/);
});

test('a bounded sample says how many of how many were shown', () => {
  const markdown = tableMarkdown(table({ row_count: 1_000_000 }));
  assert.match(markdown, /\*records — 2 of 1,000,000 rows shown\*/);
});

test('the header and a separator row are both markdown table rows', () => {
  const markdown = tableMarkdown(table());
  const lines = markdown.split('\n');
  assert.equal(lines[2], '| name | age |');
  assert.equal(lines[3], '| :--- | :--- |');
  assert.equal(lines[4], '| Ada | 36 |');
  assert.equal(lines[5], '| Alan | 41 |');
});

test('the separator requests explicit left alignment, not bare dashes', () => {
  // Bare `---` asks a renderer for no alignment, which is what left a
  // hover table's header centred over left-aligned data (#105).
  // `inspectionTable`'s table carries the identical separator, because two
  // tables sharing one hover must agree on how they align.
  const markdown = tableMarkdown(table({ columns: ['solo'],
    rows: [['x']], col_count: 1, shown_cols: 1 }));
  assert.equal(markdown.split('\n')[3], '| :--- |');
});

test('a dataframe is labelled by its real name, not its wire kind', () => {
  const markdown = tableMarkdown(table({ kind: 'dataframe' }));
  assert.match(markdown, /\*DataFrame — /);
});

test('namedtuples and rows keep their own label', () => {
  assert.match(
    tableMarkdown(table({ kind: 'namedtuples' })), /\*namedtuples — /);
  assert.match(tableMarkdown(table({ kind: 'rows' })), /\*rows — /);
});

test('more columns than shown add a trailing column, not a silent drop', () => {
  const markdown = tableMarkdown(table({
    columns: ['a', 'b'], col_count: 5, shown_cols: 2, more_cols: 3,
    rows: [['1', '2']],
  }));
  assert.match(markdown, /, 2 of 5 columns shown\*/);
  const lines = markdown.split('\n');
  assert.equal(lines[2], '| a | b | … (+3 more) |');
  assert.equal(lines[3], '| :--- | :--- | :--- |');
  // The data row gains a matching empty cell rather than running short of
  // the header it sits under.
  assert.equal(lines[4], '| 1 | 2 |  |');
});

test('a pipe in a cell is escaped rather than splitting the column', () => {
  const markdown = tableMarkdown(table({
    columns: ['expr'], rows: [["a|b"]], col_count: 1, shown_cols: 1,
  }));
  assert.match(markdown, /\| a\\\|b \|/);
});

test('a backslash in a cell is escaped before the pipe check runs', () => {
  const markdown = tableMarkdown(table({
    columns: ['path'], rows: [['C:\\temp']], col_count: 1, shown_cols: 1,
  }));
  assert.match(markdown, /C:\\\\temp/);
});

test('a newline in a cell becomes a visible marker, not a broken row', () => {
  const markdown = tableMarkdown(table({
    columns: ['text'], rows: [['line one\nline two']],
    col_count: 1, shown_cols: 1,
  }));
  const lines = markdown.split('\n');
  // Exactly the header, its separator and one data row -- a literal
  // newline in the cell must not have become a second markdown-table row.
  assert.equal(lines.length, 5);
  assert.match(lines[4], /line one ⏎ line two/);
});

test('a pipe in a header is escaped the same way a cell is', () => {
  const markdown = tableMarkdown(table({
    columns: ['a|b'], rows: [['1']], col_count: 1, shown_cols: 1,
  }));
  assert.match(markdown, /\| a\\\|b \|/);
});
