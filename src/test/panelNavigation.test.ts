import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { ValuesRow, valuesHtml } from '../panel/html';

/** Execute the shipped script against a small event/geometry DOM. Browser
 * layout and theme appearance are checked separately in a real host. */
function webview(followCursor = true, revealLine?: number) {
  let focused: Row | undefined;
  const posted: Array<Record<string, unknown>> = [];
  type Listener = (event: { key: string; preventDefault(): void }) => void;
  class Row {
    tabIndex = -1;
    readonly dataset: { goto: string; start: string; end: string };
    readonly attributes = new Map<string, string>();
    readonly events = new Map<string, Listener>();
    readonly classes = new Set<string>();
    readonly classList = {
      toggle: (name: string, active: boolean) => {
        if (active) this.classes.add(name); else this.classes.delete(name);
      },
    };
    top = 40;
    bottom = 60;
    scrolls = 0;
    constructor(line: number, start = line, end = line) {
      this.dataset = { goto: String(line), start: String(start), end: String(end) };
    }
    getAttribute(name: string) { return this.dataset[name.slice(5) as 'goto']; }
    setAttribute(name: string, value: string) { this.attributes.set(name, value); }
    addEventListener(name: string, listener: Listener) { this.events.set(name, listener); }
    getBoundingClientRect() { return { top: this.top, bottom: this.bottom }; }
    scrollIntoView(options: unknown) {
      assert.equal((options as { block: string }).block, 'nearest');
      this.scrolls++;
    }
    focus(options: unknown) {
      assert.equal((options as { preventScroll: boolean }).preventScroll, true);
      focused = this;
    }
    fire(name: string, key = '') {
      let prevented = false;
      this.events.get(name)?.({ key, preventDefault: () => { prevented = true; } });
      return prevented;
    }
  }
  const rows = [new Row(0), new Row(2, 1, 3), new Row(5), new Row(8, 6, 10)];
  rows[2].top = 500;
  rows[2].bottom = 520;
  rows[3].top = -50;
  rows[3].bottom = 700;
  let messageListener: ((event: { data: unknown }) => void) | undefined;
  let changed: (() => void) | undefined;
  const control = {
    checked: followCursor,
    addEventListener: (_name: string, listener: () => void) => { changed = listener; },
  };
  const data: ValuesRow[] = rows.map((row) => ({
    line: Number(row.dataset.goto), startLine: Number(row.dataset.start),
    endLine: Number(row.dataset.end), state: 'evaluated', codeLines: ['x'],
  }));
  const html = valuesHtml({ fileName: 'x.py', rows: data }, undefined, 'n',
    revealLine, followCursor, 7);
  const script = /<script nonce="n">([\s\S]*?)<\/script>/.exec(html)![1];
  runInNewContext(script, {
    acquireVsCodeApi: () => ({ postMessage: (value: Record<string, unknown>) => {
      posted.push(JSON.parse(JSON.stringify(value)));
    } }),
    document: { querySelectorAll: () => rows,
      getElementById: (id: string) => id === 'follow-cursor' ? control
        : { getBoundingClientRect: () => ({ bottom: 30 }) } },
    window: { innerHeight: 300, scrollBy: ({ top }: { top: number }) => {
      const row = rows.find((row) => row.classes.has('cursor')) ?? rows[2];
      row.scrolls++;
      assert.notEqual(top, 0);
    }, addEventListener: (_name: string,
      listener: typeof messageListener) => { messageListener = listener; } },
  });
  return {
    rows, posted, control, focused: () => focused,
    message: (data: unknown) => messageListener!({ data }),
    change: () => changed!(),
  };
}

test('editor messages match compound body lines and reveal only off-screen rows', () => {
  const view = webview();
  view.message({ cursor: 3, reveal: true });
  assert.ok(view.rows[1].classes.has('cursor'));
  assert.equal(view.rows[1].scrolls, 0);
  view.message({ cursor: 5, reveal: true });
  assert.equal(view.rows[2].scrolls, 1);
  assert.equal(view.rows[1].attributes.get('aria-current'), 'false');
  assert.equal(view.rows[2].attributes.get('aria-current'), 'true');
  assert.equal(view.focused(), undefined, 'editor messages cannot take keyboard focus');
  assert.equal(view.posted.length, 0, 'editor messages cannot echo navigation');
  view.message({ cursor: 4, reveal: true });
  assert.ok(view.rows.every((row) => !row.classes.has('cursor')));
});

test('tall values already crossing the viewport stay put', () => {
  const view = webview();
  view.message({ cursor: 9, reveal: true });
  assert.equal(view.rows[3].scrolls, 0);
  view.rows[3].top = 400;
  view.rows[3].bottom = 1000;
  view.message({ cursor: 9, reveal: true });
  assert.equal(view.rows[3].scrolls, 1);
});

test('keyboard navigation retains row focus and sends a bounded target', () => {
  const view = webview();
  assert.equal(view.rows[0].tabIndex, 0);
  assert.ok(view.rows[0].fire('keydown', 'ArrowDown'));
  assert.equal(view.focused(), view.rows[1]);
  assert.deepEqual(view.posted, [{ goto: 2, revision: 7, explicit: false }]);
  view.rows[1].fire('keydown', 'End');
  assert.equal(view.focused(), view.rows[3]);
  view.rows[3].fire('keydown', 'ArrowDown');
  assert.equal(view.focused(), view.rows[3]);
  view.rows[3].fire('keydown', 'Home');
  assert.equal(view.focused(), view.rows[0]);
  view.rows[0].fire('keydown', 'ArrowUp');
  assert.equal(view.focused(), view.rows[0]);
  assert.equal(view.rows[0].fire('keydown', 'Tab'), false);
});

test('independent browsing still permits explicit Enter, Space and click activation', () => {
  const view = webview(false);
  view.rows[0].fire('keydown', 'ArrowDown');
  assert.equal(view.posted.length, 0);
  assert.equal(view.focused(), view.rows[1]);
  view.message({ cursor: 5, reveal: false });
  assert.equal(view.rows[2].scrolls, 0);
  view.rows[1].fire('keydown', 'Enter');
  view.rows[1].fire('keydown', ' ');
  view.rows[2].fire('click');
  assert.deepEqual(view.posted, [
    { goto: 2, revision: 7, explicit: true },
    { goto: 2, revision: 7, explicit: true },
    { goto: 5, revision: 7, explicit: true },
  ]);
});

test('setting changes apply without rebuilding; evaluation reveal is independent', () => {
  const view = webview(false, 5);
  assert.equal(view.rows[2].scrolls, 1);
  view.message({ followCursor: true });
  assert.equal(view.control.checked, true);
  view.rows[0].fire('keydown', 'ArrowDown');
  assert.equal(view.posted.length, 1);
  view.control.checked = false;
  view.change();
  assert.deepEqual(view.posted[1], { followCursor: false, revision: 7 });
  view.rows[1].fire('keydown', 'ArrowDown');
  assert.equal(view.posted.length, 2);
});
