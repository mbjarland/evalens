import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { ValuesRow, placeScroll, valuesHtml } from '../panel/html';

// -- placeScroll: the placement arithmetic, with no DOM at all --------------
//
// #169's own placement rule, checked directly against plain numbers before
// it is ever run inside a webview: a view 300px tall below a sticky control
// that ends at y=40 (so viewTop=40, viewBottom=340, viewSpan=300).

test('a short row is centred: its own middle lands at the view middle', () => {
  // Row at document y=500..520 (height 20, well under 80% of 300).
  // Row centre = 500 + 10 = 510. View middle = 40 + 150 = 190.
  // scrollY=0 -> rect.top as seen = 500. Target scroll = 510 - 190 = 320.
  assert.equal(placeScroll(500, 20, 0, 40, 340, 100000), 320);
});

test('scrollY shifts the document-relative rect back to absolute', () => {
  // Same row, but the page has already scrolled by 100: rect.top as seen
  // would be 400, and placeScroll is handed the viewport rect.top plus the
  // current scrollY works out to the same absolute target.
  assert.equal(placeScroll(400, 20, 100, 40, 340, 100000), 320);
});

test('a row taller than 80% of the view is top-aligned with an 8px margin', () => {
  // viewSpan=300, 80% = 240. A 260px-tall row cannot be centred.
  // rowTop (absolute) = 500. Target = 500 - (40 + 8) = 452.
  assert.equal(placeScroll(500, 260, 0, 40, 340, 100000), 452);
});

test('a row at exactly 80% of the view is still centred, not top-aligned', () => {
  // height 240 == 0.8 * 300 -- the boundary itself takes the centred branch.
  // centre = 500 + 120 = 620; target = 620 - 190 = 430.
  assert.equal(placeScroll(500, 240, 0, 40, 340, 100000), 430);
});

test('the target never asks for scroll past the top of the document', () => {
  // A row near the very top of the page: centring it would ask for
  // negative scroll, clamped to 0.
  assert.equal(placeScroll(10, 20, 0, 40, 340, 100000), 0);
});

test('the target never asks for scroll past the end of the document', () => {
  // The page can only scroll to 50 (a short document / last rows); the
  // uncapped centred target would be far past that.
  assert.equal(placeScroll(2000, 20, 0, 40, 340, 50), 50);
});

// -- the shipped script: real geometry through a scroll-position model ------
//
// Models the page as a document with rows at fixed absolute (document-
// relative) positions, a mutable scrollY, and a fixed viewport height --
// close enough to a real browser's own box model that the exact scroll
// position the script asks for can be asserted, not merely "moved" or "in
// view". Browser layout and theme appearance are checked separately in a
// real host (the puppeteer script under scratchpad/169).

const INNER_HEIGHT = 300;
const CONTROL_BOTTOM = 40; // matches the fake getElementById below
const VIEW_TOP = CONTROL_BOTTOM;
const VIEW_BOTTOM = INNER_HEIGHT;

interface RowLayout {
  readonly line: number;
  readonly start?: number;
  readonly end?: number;
  /** Document-relative (absolute) top and bottom -- what a real
   * getBoundingClientRect would report at scrollY = 0. */
  readonly top: number;
  readonly bottom: number;
}

function webview(rows: readonly RowLayout[], options: {
  followCursor?: boolean; revealLine?: number; scrollHeight?: number;
} = {}) {
  const followCursor = options.followCursor ?? true;
  let scrollY = 0;
  const scrollHeight = options.scrollHeight
    ?? Math.max(...rows.map((row) => row.bottom)) + 40;
  const scrollCalls: number[] = [];
  const posted: Array<Record<string, unknown>> = [];
  let focused: FakeRow | undefined;
  type Listener = (event: { key: string; preventDefault(): void }) => void;

  class FakeRow {
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
    constructor(private readonly layout: RowLayout) {
      this.dataset = { goto: String(layout.line),
        start: String(layout.start ?? layout.line), end: String(layout.end ?? layout.line) };
    }
    getAttribute(name: string) { return this.dataset[name.slice(5) as 'goto']; }
    setAttribute(name: string, value: string) { this.attributes.set(name, value); }
    addEventListener(name: string, listener: Listener) { this.events.set(name, listener); }
    getBoundingClientRect() {
      return { top: this.layout.top - scrollY, bottom: this.layout.bottom - scrollY };
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

  const fakeRows = rows.map((row) => new FakeRow(row));
  let messageListener: ((event: { data: unknown }) => void) | undefined;
  let changed: (() => void) | undefined;
  const control = {
    checked: followCursor,
    addEventListener: (_name: string, listener: () => void) => { changed = listener; },
  };
  const data: ValuesRow[] = rows.map((row) => ({
    line: row.line, startLine: row.start ?? row.line, endLine: row.end ?? row.line,
    state: 'evaluated', codeLines: ['x'],
  }));
  const html = valuesHtml({ fileName: 'x.py', rows: data }, undefined, 'n',
    options.revealLine, undefined, followCursor, 7);
  const script = /<script nonce="n">([\s\S]*?)<\/script>/.exec(html)![1];
  const maxScroll = () => Math.max(0, scrollHeight - INNER_HEIGHT);
  runInNewContext(script, {
    acquireVsCodeApi: () => ({ getState: () => undefined, setState: () => undefined,
      postMessage: (value: Record<string, unknown>) => {
        posted.push(JSON.parse(JSON.stringify(value)));
      } }),
    document: {
      querySelectorAll: (selector: string) => selector === 'tr.row' ? fakeRows : [],
      getElementById: (id: string) => id === 'follow-cursor' ? control
        : { getBoundingClientRect: () => ({ bottom: CONTROL_BOTTOM }) },
      documentElement: { get scrollHeight() { return scrollHeight; } },
    },
    window: {
      innerHeight: INNER_HEIGHT,
      get scrollY() { return scrollY; },
      get pageYOffset() { return scrollY; },
      scrollBy: ({ top }: { top: number }) => {
        scrollY = Math.max(0, Math.min(maxScroll(), scrollY + top));
        scrollCalls.push(scrollY);
      },
      scrollTo: (options: { top: number }) => {
        scrollY = Math.max(0, Math.min(maxScroll(), options.top));
        scrollCalls.push(scrollY);
      },
      addEventListener: (_name: string,
        listener: typeof messageListener) => { messageListener = listener; },
    },
  });
  return {
    rows: fakeRows, posted, control, scrollCalls, focused: () => focused,
    scrollY: () => scrollY,
    message: (data: unknown) => messageListener!({ data }),
    change: () => changed!(),
  };
}

/** A short row (well under 80% of the 300px view) at document position
 * `top`, defaulting to a 20px height. */
function shortRow(line: number, top: number, height = 20): RowLayout {
  return { line, top, bottom: top + height };
}

test('a cursor navigation centres a short row in the view', () => {
  const rows = [shortRow(0, 0), shortRow(2, 500), shortRow(5, 5000)];
  const view = webview(rows, { scrollHeight: 6000 });
  view.message({ cursor: 2, reveal: true });
  // Row centre = 500 + 10 = 510; view middle = 40 + 130 = 170.
  assert.equal(view.scrollY(), 510 - (VIEW_TOP + (VIEW_BOTTOM - VIEW_TOP) / 2));
  assert.equal(view.scrollCalls.length, 1);
});

test('a tall row is top-aligned at the sticky control plus an 8px margin', () => {
  // 260px tall -- past 0.8 * 300 = 240 -- cannot be centred.
  const rows = [shortRow(0, 0), { line: 4, top: 500, bottom: 760 }];
  const view = webview(rows, { scrollHeight: 2000 });
  view.message({ cursor: 4, reveal: true });
  assert.equal(view.scrollY(), 500 - (VIEW_TOP + 8));
});

test('re-navigating to the same row does not scroll again', () => {
  const rows = [shortRow(0, 0), shortRow(2, 500)];
  const view = webview(rows, { scrollHeight: 2000 });
  view.message({ cursor: 2, reveal: true });
  assert.equal(view.scrollCalls.length, 1);
  const after = view.scrollY();
  // The reader scrolls away by hand -- navigation must not fight that while
  // the target is unchanged.
  view.message({ cursor: 2, reveal: true });
  assert.equal(view.scrollCalls.length, 1, 'the same row must not re-reveal');
  assert.equal(view.scrollY(), after);
});

test('navigating to a different row after re-navigating the same one still centres', () => {
  const rows = [shortRow(0, 0), shortRow(2, 500), shortRow(5, 1500)];
  const view = webview(rows, { scrollHeight: 2000 });
  view.message({ cursor: 2, reveal: true });
  view.message({ cursor: 2, reveal: true }); // no-op, same row
  view.message({ cursor: 5, reveal: true }); // a different row
  assert.equal(view.scrollCalls.length, 2);
  assert.equal(view.scrollY(), 1510 - (VIEW_TOP + (VIEW_BOTTOM - VIEW_TOP) / 2));
});

test('the on-load revealLine also centres and respects the same-row guard', () => {
  const rows = [shortRow(0, 0), shortRow(2, 500)];
  const view = webview(rows, { revealLine: 2, scrollHeight: 2000 });
  assert.equal(view.scrollCalls.length, 1);
  assert.equal(view.scrollY(), 510 - (VIEW_TOP + (VIEW_BOTTOM - VIEW_TOP) / 2));
  // The evaluation that triggered this load also happens to target the same
  // row via a follow-up cursor message -- must not double-reveal.
  view.message({ cursor: 2, reveal: true });
  assert.equal(view.scrollCalls.length, 1);
});

test('navigation clamps to the end of a short document rather than '
  + 'over-scrolling to fake a centre', () => {
  // A short document: only 40px of scroll room past the last row's own
  // bottom (620), even though centring the last row would ask for more.
  const rows = [shortRow(0, 0), shortRow(2, 500), shortRow(5, 600)];
  const view = webview(rows, { scrollHeight: 660 }); // maxScroll = 660 - 300 = 360
  view.message({ cursor: 5, reveal: true });
  assert.equal(view.scrollY(), 360, 'clamped to the furthest the page can scroll');
});

test('a cursor message matches a compound row by containing line', () => {
  const rows = [shortRow(0, 0), { line: 3, start: 1, end: 3, top: 500, bottom: 520 }];
  const view = webview(rows);
  view.rows[0].classes.add('latest-result');
  view.message({ cursor: 2, reveal: true });
  assert.ok(view.rows[1]!.classes.has('cursor'));
  assert.equal(view.rows[1]!.attributes.get('aria-current'), 'true');
  view.message({ cursor: 4, reveal: true });
  assert.ok(view.rows.every((row) => !row.classes.has('cursor')));
  assert.ok(view.rows[0].classes.has('latest-result'),
    'a cursor message cannot erase the independently marked completed result');
});

test('a cursor message with no reveal flag marks the row but never scrolls', () => {
  const rows = [shortRow(0, 0), shortRow(2, 500)];
  const view = webview(rows, { scrollHeight: 2000 });
  view.message({ cursor: 2, reveal: false });
  assert.ok(view.rows[1]!.classes.has('cursor'));
  assert.equal(view.scrollCalls.length, 0);
});

test('keyboard navigation keeps the pre-existing minimal nearest-edge '
  + 'scroll, never the centring rule', () => {
  const rows = [shortRow(0, 0, 20), shortRow(1, 5000, 20)];
  // Give the fake control/rows small on-screen rects so the target sits
  // just off the bottom edge (nearest-edge scroll), the way the old test
  // modelled it: rects are viewport-relative, so make row 1 sit right at
  // the bottom edge of the 300px view.
  const view = webview(rows);
  view.rows[0]!.tabIndex = 0;
  // Force row 1's on-screen rect to be just below the view, so revealEdge
  // has exactly one edge to close.
  (view.rows[1] as unknown as { getBoundingClientRect(): { top: number; bottom: number } })
    .getBoundingClientRect = () => ({ top: 310, bottom: 330 });
  view.rows[0]!.fire('keydown', 'ArrowDown');
  assert.equal(view.focused(), view.rows[1]);
  // revealEdge scrolls only by the nearest edge: the row's bottom (330)
  // overflows the view's bottom (300) by 30, so that is the whole delta --
  // nothing centres it.
  assert.equal(view.scrollCalls.length, 1);
  assert.equal(view.scrollY(), 30);
  assert.deepEqual(view.posted, [{ goto: 1, revision: 7, explicit: false }]);
});

test('a click never scrolls the panel', () => {
  const rows = [shortRow(0, 0), shortRow(1, 5000)];
  const view = webview(rows, { scrollHeight: 6000 });
  view.rows[1]!.fire('click');
  assert.equal(view.scrollCalls.length, 0);
  assert.deepEqual(view.posted, [{ goto: 1, revision: 7, explicit: true }]);
});

test('independent browsing still permits explicit Enter, Space and click '
  + 'activation, and evaluation reveal is independent of followCursor', () => {
  const rows = [shortRow(0, 0), shortRow(1, 40), shortRow(2, 500)];
  const view = webview(rows, { followCursor: false, scrollHeight: 2000 });
  view.rows[0]!.fire('keydown', 'ArrowDown');
  assert.equal(view.posted.length, 0);
  assert.equal(view.focused(), view.rows[1]);
  view.message({ cursor: 2, reveal: false });
  assert.equal(view.scrollCalls.length, 0);
  view.rows[1]!.fire('keydown', 'Enter');
  view.rows[1]!.fire('keydown', ' ');
  view.rows[2]!.fire('click');
  assert.deepEqual(view.posted, [
    { goto: 1, revision: 7, explicit: true },
    { goto: 1, revision: 7, explicit: true },
    { goto: 2, revision: 7, explicit: true },
  ]);
});

test('setting changes apply without rebuilding; evaluation reveal is '
  + 'independent', () => {
  const rows = [shortRow(0, 0), shortRow(1, 40), shortRow(2, 500)];
  const view = webview(rows, { followCursor: false, revealLine: 2, scrollHeight: 2000 });
  assert.equal(view.scrollCalls.length, 1);
  view.message({ followCursor: true });
  assert.equal(view.control.checked, true);
  view.rows[0]!.fire('keydown', 'ArrowDown');
  assert.equal(view.posted.length, 1);
  view.control.checked = false;
  view.change();
  assert.deepEqual(view.posted[1], { followCursor: false, revision: 7 });
  view.rows[1]!.fire('keydown', 'ArrowDown');
  assert.equal(view.posted.length, 2);
});
