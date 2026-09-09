import {
  LoopExplorerWire, LoopInvocation, LoopIteration, LoopOffsets, LoopSite,
} from '../kernel/protocol';

type Entry = LoopInvocation | LoopIteration;
export const LOOP_ENTRY_LIMIT = 2000;
export const LOOP_VISIBLE_LIMIT = 120;
export const LOOP_PAGE_SIZE = 20;
export const LOOP_TEXT_CHUNK = 2000;
const RETAINED_LIMIT = 65536;
const SMALL_RUN = 24;

export interface LoopViewState {
  readonly identity: number;
  readonly expanded: Map<number, boolean>;
  readonly pages: Map<number, number>;
  readonly textPages: Map<string, number>;
  readonly expandedGaps: Set<string>;
  selected?: number;
}
export function newLoopViewState(identity = 0): LoopViewState {
  return { identity, expanded: new Map(), pages: new Map(), textPages: new Map(),
    expandedGaps: new Set() };
}

/** Bounded maps plus a single conversion of each retained stream. Python
 * offsets are code points; JS slicing directly would split emoji/surrogates. */
export interface LoopExplorer {
  readonly wire: LoopExplorerWire;
  readonly entries: ReadonlyMap<number, Entry>;
  readonly sites: ReadonlyMap<number, LoopSite>;
  readonly children: ReadonlyMap<number, readonly Entry[]>;
  readonly roots: readonly LoopInvocation[];
  readonly streams: readonly [string, string];
  readonly offsets: readonly [readonly number[], readonly number[]];
}
function natural(n: unknown): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
}
function pair(value: unknown): value is LoopOffsets {
  return Array.isArray(value) && value.length === 2 && value.every(natural);
}
function contained(child: Entry, parent: Entry): boolean {
  return child.start.every((n, i) => n >= parent.start[i]!
    && child.end[i]! <= parent.end[i]!);
}
function unitOffsets(text: string, count: number): number[] | undefined {
  const result = [0];
  let offset = 0;
  for (let i = 0; i < count; i++) {
    if (offset >= text.length) return undefined;
    const point = text.codePointAt(offset)!;
    offset += point > 0xffff ? 2 : 1;
    result.push(offset);
  }
  return result;
}

/** Fail closed on missing/corrupt/incomplete metadata, preserving the flat
 * original output. No inference can repair a missing parent relationship. */
export function prepareLoopExplorer(
  wire: LoopExplorerWire | undefined, stdout = '', stderr = ''
): LoopExplorer | undefined {
  if (!wire || wire.version !== 1 || !natural(wire.statement_line) || !Array.isArray(wire.sites)
    || wire.sites.length < 1 || wire.sites.length > 64
    || !Array.isArray(wire.entries) || wire.entries.length > LOOP_ENTRY_LIMIT
    || !pair(wire.retained) || !pair(wire.totals)
    || wire.retained.some((n, i) => n > RETAINED_LIMIT || n > wire.totals[i]!)
    || ![wire.iterations, wire.invocations, wire.omitted_iterations,
      wire.omitted_invocations].every(natural)
    || !Array.isArray(wire.final_values) || wire.final_values.length > 100) return;
  const sites = new Map<number, LoopSite>();
  for (const site of wire.sites) {
    if (!site || !natural(site.id) || sites.has(site.id) || !natural(site.line)
      || typeof site.target !== 'string' || site.target.length > 500
      || typeof site.source !== 'string' || site.source.length > 1000
      || (site.parent !== null && !sites.has(site.parent))) return;
    if (site.body_names !== undefined && (!Array.isArray(site.body_names)
      || site.body_names.length > 3 || new Set(site.body_names).size !== site.body_names.length
      || site.body_names.some((name: unknown) => typeof name !== 'string' || !name
        || name.length > 240 || Array.from(name).length > 120))) return;
    if (site.omitted_body_names !== undefined && !natural(site.omitted_body_names)) return;
    sites.set(site.id, site);
  }
  const entries = new Map<number, Entry>();
  const children = new Map<number, Entry[]>();
  const roots: LoopInvocation[] = [];
  let lastId = 0;
  let retainedIterations = 0;
  let retainedInvocations = 0;
  for (const entry of wire.entries as readonly Entry[]) {
    if (!entry || !natural(entry.id) || entry.id <= lastId
      || !pair(entry.start) || !pair(entry.end)
      || entry.start.some((n, i) => n > entry.end[i]! || entry.end[i]! > wire.totals[i]!)) return;
    lastId = entry.id;
    let parentId: number | null;
    if (entry.kind === 'invocation') {
      if (!sites.has(entry.site) || !natural(entry.count)) return;
      parentId = entry.parent ?? entry.parent_invocation;
      if (parentId === null) roots.push(entry);
      else if (entries.get(parentId)?.kind !== (entry.parent === null
        ? 'invocation' : 'iteration')) return;
      if (entry.parent_invocation !== null
        && entries.get(entry.parent_invocation)?.kind !== 'invocation') return;
      retainedInvocations++;
    } else if (entry.kind === 'iteration') {
      if (!natural(entry.ordinal) || entry.ordinal === 0
        || typeof entry.value !== 'string' || entry.value.length > 1000
        || entries.get(entry.invocation)?.kind !== 'invocation') return;
      parentId = entry.invocation;
      const invocation = entries.get(parentId) as LoopInvocation;
      if (entry.ordinal > invocation.count) return;
      if (entry.body !== undefined) {
        const names = sites.get(invocation.site)!.body_names;
        const body = entry.body;
        if (!body || !names?.length
          || !['captured', 'not-reached', 'unavailable'].includes(body.status)
          || !Array.isArray(body.values) || body.values.length > names.length
          || (body.status !== 'captured' && body.values.length !== 0)) return;
        const seen = new Set<string>();
        for (const value of body.values) {
          if (!value || typeof value.name !== 'string' || !names.includes(value.name)
            || seen.has(value.name) || typeof value.value !== 'string'
            || value.value.length > 2000 || Array.from(value.value).length > 1000) return;
          seen.add(value.name);
        }
      }
      retainedIterations++;
    } else return;
    if (parentId !== null) {
      const parent = entries.get(parentId);
      if (!parent || !contained(entry, parent)) return;
      const siblings = children.get(parentId) ?? [];
      const previous = siblings[siblings.length - 1];
      if (previous && entry.start.some((n, i) => n < previous.end[i]!)) return;
      if (entry.kind === 'iteration' && entry.ordinal !== siblings.filter(
        (s) => s.kind === 'iteration').length + 1) return;
      siblings.push(entry);
      children.set(parentId, siblings);
    }
    entries.set(entry.id, entry);
  }
  if (!roots.length || retainedIterations + wire.omitted_iterations !== wire.iterations
    || retainedInvocations + wire.omitted_invocations !== wire.invocations) return;
  const outOffsets = unitOffsets(stdout, wire.retained[0]);
  const errOffsets = unitOffsets(stderr, wire.retained[1]);
  if (!outOffsets || !errOffsets) return;
  if (wire.final_values.some((v) => !v || typeof v.name !== 'string'
    || typeof v.value !== 'string' || v.name.length > 1000 || v.value.length > 1000)) return;
  return { wire, entries, sites, children, roots,
    streams: [stdout, stderr], offsets: [outOffsets, errOffsets] };
}

export function loopSlice(
  model: LoopExplorer, start: LoopOffsets, end: LoopOffsets, stream: 0 | 1
): string {
  const retained = model.wire.retained[stream];
  return model.streams[stream].slice(
    model.offsets[stream][Math.min(start[stream], retained)],
    model.offsets[stream][Math.min(end[stream], retained)]);
}
function e(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function count(n: number, noun: string): string {
  return `${n.toLocaleString('en-US')} ${noun}${n === 1 ? '' : 's'}`;
}
function lines(text: string): number {
  if (!text) return 0;
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') n++;
  return n + (text.endsWith('\n') ? 0 : 1);
}
function canFold(model: LoopExplorer, entry: LoopIteration): boolean {
  // A few short printed lines still form one readable table row in a simple
  // loop. Nested groups keep their established, denser disclosure threshold.
  const singleLevel = model.sites.size === 1;
  const spans = entry.end.map((n, i) => n - entry.start[i]!);
  if ((model.children.get(entry.id)?.length ?? 0) > 0
    || (singleLevel ? spans[0]! + spans[1]! > 160 : spans.some((n) => n > 160))) return true;
  const outputLines = [0, 1].map((stream) =>
    lines(loopSlice(model, entry.start, entry.end, stream as 0 | 1)));
  return singleLevel ? outputLines[0]! + outputLines[1]! > 3
    : outputLines.some((n) => n > 1);
}
export function loopExpanded(
  model: LoopExplorer, entry: LoopIteration, state?: LoopViewState
): boolean {
  return state?.expanded.get(entry.id) ?? (model.wire.iterations <= SMALL_RUN
    && (model.children.get(entry.id)?.length ?? 0) > 0);
}
export function invocationExpanded(
  model: LoopExplorer, entry: LoopInvocation, state?: LoopViewState
): boolean {
  return state?.expanded.get(entry.id) ?? model.wire.iterations <= SMALL_RUN;
}

/** A hard DOM budget applies even when every retained node has been opened.
 * Pagination replaces old entries/chunks; hidden text is never in the DOM. */
export function loopExplorerHtml(
  model: LoopExplorer, line: number, state?: LoopViewState, outputLines = 20,
  recordingState = ''
): string {
  let remaining = LOOP_VISIBLE_LIMIT;
  let exhausted = false;
  const tree = model.sites.size > 1;
  const timingFor = (site: LoopSite): string => `${site.target} at iteration start`
    + (site.body_names?.length ? `; ${site.body_names.join(', ')} at iteration end` : '');
  const recordingDetails = (): string =>
    '<details class="loop-recording-details" data-local-disclosure>'
    + '<summary>About these values</summary><div class="loop-explanation">'
    + '<p>These values were saved when you evaluated the code. They are not live values. '
    + 'The variable after <code>for</code> shows its value at the start of each iteration. '
    + 'Other variables show their values when the body reaches its end.</p>'
    + '<p>Printed output shows what the program printed at that moment. '
    + 'If it prints <code>u</code> while <code>u = 4</code>, then sets '
    + '<code>u = 99</code>, the row shows <code>u = 99</code> beside printed '
    + '<code>4</code>. A value can carry over from an earlier iteration when '
    + 'the code does not assign it again.</p>'
    + '<p><strong>Not recorded</strong> means there is no saved reading; it does not '
    + 'mean the variable was empty or the assignment did not run. Use <strong>Why?</strong> '
    + 'beside a missing value for its explanation. Evalens saves up to three body '
    + 'variable names per loop; the loop heading reports names left out.</p>'
    + '<p>Folding and paging browse saved results without running the code again. '
    + 'A loop reports when later iteration details or output were not saved. '
    + 'Those missing details cannot be expanded. An old result can also depend on '
    + 'changes Evalens could not detect; no warning is not a guarantee that it is current.</p>'
    + '</div></details>';
  const number = (n: number): string => n.toLocaleString('en-US');
  const sourceContext = (invocation: LoopInvocation): string => {
    const site = model.sites.get(invocation.site)!;
    const parent = invocation.parent === null ? undefined : model.entries.get(invocation.parent);
    let context = `${site.source} · line ${line + site.line - model.wire.statement_line + 1}`;
    if (parent?.kind === 'iteration') {
      const owner = model.entries.get(parent.invocation) as LoopInvocation;
      const target = model.sites.get(owner.site)!.target;
      context += ` · within Iteration ${number(parent.ordinal)}, ${target} = ${parent.value}`;
    }
    return context;
  };
  const button = (label: string, action: string, id: number, value = 0,
    extra = '', control = label.startsWith('Previous') ? 'previous' : 'next'): string => `<button type="button" class="loop-action" `
    + `data-loop-action="${action}" data-loop-line="${line}" `
    + `data-loop-token="${state?.identity ?? 0}" `
    + `data-loop-control="${control}" `
    + `data-loop-id="${id}" data-loop-value="${value}" ${extra}>${label}</button>`;
  const output = (start: LoopOffsets, end: LoopOffsets, key: number,
    gap: number, empty = false): string => {
    const pieces: string[] = [];
    for (const stream of [0, 1] as const) {
      const text = loopSlice(model, start, end, stream);
      const clipped = end[stream] > start[stream]
        && end[stream] > model.wire.retained[stream];
      if (!text && !clipped) continue;
      const textKey = `${key}:${gap}:${stream}`;
      const page = Math.max(0, state?.textPages.get(textKey) ?? 0);
      // A page is capped by BOTH character count and logical lines. Chunk
      // boundaries are stable, so moving through output never skips text.
      const chunks = textChunks(text, outputLines);
      const selected = Math.min(page, chunks.length - 1);
      const raw = chunks[Math.max(0, selected)] ?? '';
      const shown = raw.replace(/\r?\n$/, '') || (text ? '(blank line)' : '');
      const label = stream ? '<span class="loop-stream-label" '
        + 'title="stderr is a separate output stream, often used for warnings. '
        + 'Output here does not by itself mean the code failed.">stderr: </span>'
        : '<span class="loop-stream-label loop-stack-label">Printed output: </span>';
      const paging = chunks.length > 1
        ? `<div class="loop-note">Output part ${selected + 1} of ${chunks.length} · `
          + (selected > 0 ? button('Previous output', `text:${gap}:${stream}`, key, selected - 1) + ' · ' : '')
          + (selected < chunks.length - 1 ? button('More output', `text:${gap}:${stream}`, key, selected + 1) + ' · ' : '')
          + button(stream ? 'Open statement stderr output' : 'Open statement printed output', 'open', key, stream,
            'title="Opens the whole statement’s available stream in a read-only editor, not only this iteration. Use native Find and copy."') + '</div>' : '';
      pieces.push(`<div class="loop-stream">${label}<span class="loop-output">${e(shown)}</span>${paging}`
        + (clipped ? '<div class="loop-note">Further output was not retained.</div>' : '') + '</div>');
    }
    if (!pieces.length) return empty ? '<span class="loop-note">No output</span>' : '';
    return pieces.join('');
  };
  const outputCount = (entry: LoopIteration): string => {
    const parts: string[] = [];
    for (const stream of [0, 1] as const) {
      const label = stream ? 'stderr' : 'printed';
      if (entry.end[stream] > entry.start[stream]
        && entry.end[stream] > model.wire.retained[stream]) {
        parts.push(`${label} output not fully retained`);
      } else {
        const text = loopSlice(model, entry.start, entry.end, stream);
        if (text) parts.push(`${label} ${count(lines(text), 'line')}`);
      }
    }
    return parts.length ? parts.join(' · ') : 'No output';
  };
  const gapHtml = (start: LoopOffsets, end: LoopOffsets, id: number,
    gap: number, incomplete = false): string => {
    // A gap after capture metadata fills has no trustworthy iteration owner.
    // Give its retained text its own fold instead of leaking it below folded
    // iterations or assigning it to the last retained iteration. Text that
    // was never captured stays an omission notice, not an expandable promise.
    if (incomplete && start.some((n, stream) => end[stream]! > n)) {
      const entry = model.entries.get(id);
      const invocation = entry?.kind === 'iteration'
        ? model.entries.get(entry.invocation) as LoopInvocation : entry;
      const scope = invocation ? sourceContext(invocation)
        + (entry?.kind === 'iteration' ? ` · Iteration ${number(entry.ordinal)}` : '')
        : `Evaluated statement · line ${line + 1}`;
      const hasOutput = start.some((n, stream) =>
        Math.min(end[stream]!, model.wire.retained[stream]!) > n);
      const stdout = end[0] > start[0];
      const stderr = end[1] > start[1];
      const label = stdout ? 'Remaining printed output' + (stderr ? ' and stderr' : '')
        : 'Remaining stderr output';
      const expanded = state?.expandedGaps.has(`${id}:${gap}`) ?? false;
      const heading = hasOutput
        ? button(`<span class="loop-disclosure" aria-hidden="true">${expanded ? '▾' : '▸'}</span> `
          + label, `gap:${gap}`, id, 0,
          `aria-expanded="${expanded}" aria-label="${e(`${label}; ${scope}`)}"`)
        : label;
      return `<section class="loop-overflow" data-loop-overflow="${id}">`
        + `<div class="loop-overflow-heading">${heading}</div>`
        + `<div class="loop-note loop-overflow-scope">${e(scope)}</div>`
        + '<div class="loop-note">' + (hasOutput
          ? 'Saved output without individual iteration details. It belongs to this loop, not to the last displayed iteration.'
          : 'Output from this loop was not saved. There is no additional text to expand.') + '</div>'
        + (expanded || !hasOutput ? output(start, end, id, gap) : '') + '</section>';
    }
    const content = output(start, end, id, gap);
    return content ? `<div class="loop-data loop-direct"><span></span><div>${content}</div></div>` : '';
  };
  const sourceHeader = (invocation: LoopInvocation, source: string, root: boolean): string => {
    const site = model.sites.get(invocation.site)!;
    return `<div class="loop-source${root ? ' loop-root-source' : ''}">${source}`
      + ` <span class="loop-note">· ${count(invocation.count, 'iteration')}`
      + (root ? '' : ` · line ${line + site.line - model.wire.statement_line + 1}`)
      + (site.omitted_body_names ? ` · ${count(site.omitted_body_names, 'other body variable')} not recorded` : '')
      + '</span></div>';
  };
  const invocationHtml = (invocation: LoopInvocation, depth: number,
    root = false, singleChild = false): string => {
    if (remaining-- <= 0) { exhausted = true; return ''; }
    const site = model.sites.get(invocation.site)!;
    const children = model.children.get(invocation.id) ?? [];
    const iterationCount = children.filter((c) => c.kind === 'iteration').length;
    const page = Math.max(0, Math.min(state?.pages.get(invocation.id) ?? 0,
      Math.floor(Math.max(0, children.length - 1) / LOOP_PAGE_SIZE)));
    const from = page * LOOP_PAGE_SIZE;
    const selected = children.slice(from, from + LOOP_PAGE_SIZE);
    // The parent iteration is already a fold for its only inner loop. Keep
    // independent invocation folds when there are real sibling choices, so
    // later invocations remain reachable under the shared display budget.
    const foldable = !root && !singleChild && invocation.count > 0
      && model.wire.iterations > SMALL_RUN;
    const expanded = !foldable || invocationExpanded(model, invocation, state);
    const source = foldable
      ? button(`<span class="loop-disclosure" aria-hidden="true">${expanded ? '▾' : '▸'}</span>`
        + `<span class="loop-source-label">${e(site.source)}</span>`, 'toggle-invocation', invocation.id, 0,
        `aria-expanded="${expanded}"`) : e(site.source);
    const missing = iterationCount < invocation.count;
    const saved = missing ? `<div class="loop-note loop-capture-limit">`
      + `${count(invocation.count, 'iteration')} ran; details saved for `
      + (iterationCount ? `the first ${number(iterationCount)}` : '0')
      + '. Later iteration details were not saved.</div>'
      : invocation.incomplete ? '<div class="loop-note loop-capture-limit">'
        + 'Some nested loop detail was not saved.</div>' : '';
    // One shared heading owns the columns and help. Inner sources remain in
    // the normal flow; a short context cue is supplied only after scrolling
    // hides the group that owns the visible rows.
    const firstRoot = root && invocation.id === model.roots[0]?.id;
    const context = (firstRoot ? '' : sourceHeader(invocation, source, root)) + saved;
    const section = `<section class="loop-invocation" data-loop-invocation="${invocation.id}" `
      + `data-loop-depth="${depth}">`;
    if (!expanded) return section
      + context + '</section>';
    let body = '';
    const shown: Entry[] = [];
    let cursor = from === 0 ? invocation.start : children[from - 1]!.end;
    selected.forEach((iteration, index) => {
      if (remaining <= 0) { exhausted = true; return; }
      body += gapHtml(cursor, iteration.start, invocation.id, from + index);
      body += iteration.kind === 'iteration' ? iterationHtml(iteration, site, depth)
        : invocationHtml(iteration, depth + 1);
      shown.push(iteration);
      cursor = iteration.end;
    });
    const end = Math.min(from + LOOP_PAGE_SIZE, children.length);
    let tail = '';
    if (end === children.length && !exhausted) {
      tail = gapHtml(cursor, invocation.end, invocation.id, children.length,
        invocation.incomplete);
    }
    if (invocation.count === 0) body += '<div class="loop-note">No iterations</div>';
    const mixed = iterationCount !== children.length;
    const shownIterations = shown.filter((entry): entry is LoopIteration => entry.kind === 'iteration');
    const span = shownIterations.length
      ? `${number(shownIterations[0]!.ordinal)}–${number(shownIterations.at(-1)!.ordinal)}` : '0';
    const limited = shown.length < selected.length;
    const navigation = invocation.count > LOOP_PAGE_SIZE || children.length > LOOP_PAGE_SIZE || missing || limited;
    const paging = navigation ? `<div class="loop-navigation" data-loop-navigation="${invocation.id}">`
      + `<div class="loop-note loop-page-scope">${e(sourceContext(invocation))}</div>`
      + '<div class="loop-paging loop-note">'
      + (mixed ? `Rows ${shown.length ? `${number(from + 1)}–${number(from + shown.length)}` : '0'} of ${number(children.length)} · ` : '')
      + (shownIterations.length ? `Iterations ${span} of ${number(invocation.count)}`
        : `No iteration rows on this page · ${count(invocation.count, 'iteration')} total`) + ' · '
      + button(mixed ? 'Previous rows' : 'Previous iterations', 'page', invocation.id, Math.max(0, page - 1),
        from === 0 ? 'disabled title="Already at the first page"' : '') + ' · '
      + button(mixed ? 'More rows' : 'More iterations', 'page', invocation.id, page + 1,
        end < children.length ? '' : `disabled title="${missing
          ? 'Later iteration details were not saved' : 'Already at the last page'}"`)
      + '</div>'
      + (mixed ? '<div class="loop-note">Rows also include nested loops outside the iterations.</div>' : '')
      + (limited ? '<div class="loop-note">Collapse an expanded group to show the remaining rows on this page.</div>' : '')
      + '</div>' : '';
    return section
      + context + `<div class="loop-entries">${body}</div>` + paging + tail + '</section>';
  };
  const iterationHtml = (entry: LoopIteration, site: LoopSite, depth: number): string => {
    if (remaining-- <= 0) { exhausted = true; return ''; }
    const children = model.children.get(entry.id) ?? [];
    const foldable = canFold(model, entry);
    const expanded = loopExpanded(model, entry, state);
    const separateBody = expanded && children.length > 0 && remaining > 0 && Boolean(site.body_names?.length);
    const selected = state?.selected === entry.id ? ' loop-selected' : '';
    const missingReason = entry.body?.status === 'not-reached'
      ? 'The normal end-of-body recording point was not reached. This does not tell us whether the assignment ran or the variable had a value.'
      : entry.body?.status === 'unavailable'
        ? 'Body values could not be recorded because this interpreter does not provide a frame.'
        : entry.body?.status === 'captured'
          ? 'The end-of-body recording point was reached, but this name had no eligible reading. It may have been unbound or not proven to belong to this loop; this recording cannot distinguish those cases.'
          : 'This recording does not contain a body reading for this iteration.';
    const bodyValues = new Map(entry.body?.values.map((value) => [value.name, value.value]));
    const missingNames = (site.body_names ?? []).filter((name) => !bodyValues.has(name));
    const why = missingNames.length ? '<details class="loop-missing-why" data-local-disclosure>'
      + `<summary aria-label="${e(`Why ${missingNames.join(', ')} was not recorded in Iteration ${entry.ordinal}`)}">Why?</summary>`
      + `<div class="loop-explanation">${e(missingReason)} `
      + 'Not recorded is a missing reading, not a Python value such as None or zero.</div></details>' : '';
    const labels = [`${site.target} = ${entry.value}`];
    const valueParts = [e(labels[0]!)];
    for (const name of site.body_names ?? []) {
      const value = bodyValues.get(name);
      const text = value === undefined ? `${name}: not recorded` : `${name} = ${value}`;
      labels.push(text);
      valueParts.push(value === undefined
        ? `<span class="loop-body-missing loop-note">${e(text)}</span>` : e(text));
    }
    const label = (separateBody ? labels.slice(0, 1) : labels).join(', ');
    const timing = separateBody ? `${site.target} at iteration start` : timingFor(site);
    const selection = button((separateBody ? valueParts.slice(0, 1) : valueParts).join(', '), 'select', entry.id, 0,
      `aria-label="${e(`Iteration ${entry.ordinal}, ${label}; ${timing}; reveal loop header`)}"`);
    if (!foldable) return `<div class="loop-data loop-iteration${selected}" data-loop-entry="${entry.id}">`
      + `<div class="loop-target"><span class="loop-stack-label">Variables</span>${selection}${why}</div>`
      + `<div>${output(entry.start, entry.end, entry.id, 0, true)}</div></div>`;
    const toggle = button(`<span class="loop-disclosure" aria-hidden="true">${expanded ? '▾' : '▸'}</span>`
      + `${tree ? '' : ' '}Iteration ${entry.ordinal}`, 'toggle', entry.id, 0,
      `aria-expanded="${expanded}" aria-label="${e(`Iteration ${entry.ordinal}, ${label}`)}"`);
    const bodyReading = (printed = ''): string => {
      const reading = button(valueParts.slice(1).join(', '), 'select', entry.id, 0,
        `aria-label="${e(`Iteration ${entry.ordinal}, ${labels.slice(1).join(', ')}; at iteration end; reveal loop header`)}"`, 'body');
      return '<div class="loop-data loop-parent-reading">'
        + '<div class="loop-target"><span class="loop-stack-label">Variables</span>'
        + reading + why + `</div><div>${printed}</div></div>`;
    };
    let body = '';
    if (expanded) {
      const page = Math.max(0, Math.min(state?.pages.get(entry.id) ?? 0,
        Math.floor(Math.max(0, children.length - 1) / LOOP_PAGE_SIZE)));
      const from = page * LOOP_PAGE_SIZE;
      const end = Math.min(from + LOOP_PAGE_SIZE, children.length);
      let cursor = from === 0 ? entry.start : children[from - 1]!.end;
      // These remain end-of-iteration snapshots. Showing them before the
      // child loop is a layout choice, never a new observation at that point.
      // Only the first page pairs them with original pre-child output.
      if (separateBody && from > 0) body += bodyReading();
      children.slice(from, end).forEach((child, index) => {
        if (remaining <= 0) { exhausted = true; return; }
        body += separateBody && from === 0 && index === 0
          ? bodyReading(output(cursor, child.start, entry.id, 0))
          : gapHtml(cursor, child.start, entry.id, from + index);
        body += invocationHtml(child as LoopInvocation, depth + 1, false, children.length === 1);
        cursor = child.end;
      });
      if (!exhausted && end === children.length) body += gapHtml(cursor, entry.end, entry.id,
        children.length, entry.incomplete);
      if (children.length > LOOP_PAGE_SIZE) body += `<div class="loop-paging loop-note">`
        + `Nested loops ${from + 1}–${end} of ${children.length} retained · `
        + (from > 0 ? button('Previous nested loops', 'page', entry.id, page - 1) + ' · ' : '')
        + (end < children.length ? button('More nested loops', 'page', entry.id, page + 1) : '') + '</div>';
    }
    return `<section class="loop-iteration loop-group${selected}" data-loop-entry="${entry.id}">`
      + `<div class="loop-iteration-header">${toggle} <span class="loop-note">·</span> ${selection} `
      + `<span class="loop-note">· ${e(outputCount(entry))}</span>${separateBody ? '' : why}</div>`
      + (expanded ? `<div class="loop-body">${body}</div>` : '') + '</section>';
  };
  let cursor: LoopOffsets = [0, 0];
  const body = model.roots.map((root, index) => {
    const prefix = gapHtml(cursor, root.start, 0, index);
    cursor = root.end;
    return prefix + invocationHtml(root, 0, true);
  }).join('') + gapHtml(cursor, model.wire.totals, 0, model.roots.length,
    model.wire.omitted_invocations > 0);
  const final = model.wire.final_values.length
    ? '<div class="loop-final">Final values after this loop: '
      + model.wire.final_values.map((v) => `${e(v.name)} = ${e(v.value)}`).join(', ') + '</div>' : '';
  const clipped = model.wire.totals.some((n, i) => n > model.wire.retained[i]!);
  const root = model.roots[0]!;
  const heading = '<div class="loop-context">'
    + (recordingState ? `<div class="loop-note loop-recording-state">${e(recordingState)}</div>` : '')
    + '<div class="loop-overview"><div class="loop-title">'
    + sourceHeader(root, e(model.sites.get(root.site)!.source), true)
    + '<div class="loop-scroll-owner" hidden></div></div>' + recordingDetails() + '</div>'
    + '<div class="loop-columns"><span>Variables</span>'
    + '<span title="Python writes ordinary printed output to stdout.">Printed output</span></div></div>';
  return `<div class="loop-explorer${tree ? ' loop-tree' : ''}" data-loop-root="${line}">`
    + (tree ? '<svg class="loop-guides" aria-hidden="true"></svg>' : '')
    + heading + body + (exhausted ? '<div class="loop-notice">Visible detail limit reached. Collapse a group to explore another.</div>' : '')
    + (clipped ? '<div class="loop-notice">Output capture is incomplete; unretained text cannot be expanded.</div>' : '')
    + final + `<div class="loop-export">${button('Open statement printed output', 'open', 0, 0,
      'title="Opens the available printed output for this whole statement. Use native Find and copy."')}`
    + (model.streams[1] ? ` · ${button('Open statement stderr output', 'open', 0, 1,
      'title="Opens the available stderr output for this whole statement. Use native Find and copy."')}` : '') + '</div></div>';
}

/** At most 65,536 retained code points enter this function. Never split an
 * arbitrarily large original output, and never put unshown chunks in HTML. */
function textChunks(text: string, requestedLines: number): string[] {
  const chunks: string[] = [];
  const lineLimit = Math.max(1, Math.min(20, requestedLines));
  let start = 0;
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') count++;
    const code = text.charCodeAt(i);
    const surrogate = code >= 0xd800 && code <= 0xdbff;
    if ((count >= lineLimit || i - start + 1 >= LOOP_TEXT_CHUNK) && !surrogate) {
      chunks.push(text.slice(start, i + 1)); start = i + 1; count = 0;
    }
  }
  if (start < text.length) chunks.push(text.slice(start));
  return chunks;
}
export const LOOP_EXPLORER_STYLE = `
.loop-explorer { font-style: normal; font-weight: normal; color: var(--vscode-editor-foreground); white-space: normal; min-width: 0; container-type: inline-size; }
.loop-explorer button { font-family: inherit; font-size: inherit; font-style: normal; background: none; border: 0; padding: 0; cursor: pointer; color: inherit; text-align: left; max-width: 100%; overflow-wrap: anywhere; }
.loop-explorer button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
.loop-columns, .loop-data { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.3fr); column-gap: 1.2em; }
.loop-columns > *, .loop-data > * { min-width: 0; }
.loop-stack-label { display: none; }
.loop-columns { color: var(--vscode-descriptionForeground); border-bottom: 1px solid var(--vscode-panel-border); padding: 0 .35em .45em; margin: .15em 0 .6em; }
.loop-context { position: sticky; top: var(--loop-context-top, 0px); z-index: 2; background: var(--vscode-panel-background, #1e1e1e); padding-top: .15em; }
.loop-context-unpinned { position: static; }
.loop-context-covered { visibility: hidden; }
.loop-overview { display: flex; flex-wrap: wrap; align-items: baseline; column-gap: 1em; }
.loop-title { position: relative; min-width: 0; flex: 1 1 24ch; }
.loop-scroll-owner { position: absolute; inset: .15em 0 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.loop-context-has-owner .loop-root-source { visibility: hidden; }
.loop-recording-details, .loop-missing-why { color: var(--vscode-descriptionForeground); }
.loop-recording-details { font-size: .86em; }
.loop-recording-details[open] { flex-basis: 100%; }
.loop-missing-why { display: inline-block; vertical-align: top; margin-left: .6em; font-size: .86em; }
.loop-missing-why[open] { display: block; margin: .35em 0; }
.loop-recording-details > summary, .loop-missing-why > summary { cursor: pointer; color: var(--vscode-textLink-foreground); width: fit-content; list-style-position: inside; }
.loop-recording-details > summary:focus-visible, .loop-missing-why > summary:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
.loop-explanation { max-width: 75ch; white-space: normal; overflow-wrap: anywhere; padding: .4em 0; }
.loop-explanation p { margin: .4em 0; }
.loop-capture-limit { margin: .2em 0; }
.loop-recording-state { font-weight: 600; margin-bottom: .25em; }
.loop-source { font-size: .88em; margin: .4em 0 .3em; overflow-wrap: anywhere; }
.loop-root-source { font-size: 1em; margin: .15em 0 .6em; }
.loop-group { margin: .6em 0 .8em; }
.loop-iteration-header { color: var(--vscode-evalens-resultForeground); overflow-wrap: anywhere; }
.loop-disclosure { color: var(--vscode-evalens-outputLabelForeground); }
.loop-data { padding: .12em .35em; }
.loop-body { margin-top: .25em; }
.loop-invocation > .loop-source { margin-left: min(2.4em, calc(var(--loop-depth, 0) * .6em)); }
.loop-target { overflow-wrap: anywhere; }
.loop-output { white-space: pre-wrap; overflow-wrap: anywhere; }
.loop-note, .loop-final, .loop-export, .loop-notice { color: var(--vscode-descriptionForeground); font-size: .86em; }
.loop-stream-label { color: var(--vscode-evalens-outputLabelForeground); }
.loop-selected > .loop-iteration-header, .loop-data.loop-selected { background: var(--vscode-editor-rangeHighlightBackground); outline: 1px solid var(--vscode-focusBorder); }
.loop-notice, .loop-paging { margin: .5em 0; }
.loop-navigation, .loop-overflow { margin: .8em 0; padding-top: .5em; border-top: 1px solid var(--vscode-panel-border); }
.loop-page-scope, .loop-overflow-scope { overflow-wrap: anywhere; }
.loop-overflow-heading { font-size: .9em; }
.loop-overflow-scope { margin: .3em 0 .5em; }
.loop-note .loop-action, .loop-export .loop-action { color: var(--vscode-textLink-foreground); }
.loop-explorer button:disabled { color: var(--vscode-disabledForeground); cursor: default; }
.loop-final { margin-top: 1em; }
.loop-export { margin-top: .5em; }
body.vscode-high-contrast .loop-selected, body.vscode-high-contrast-light .loop-selected { outline: 1px solid var(--vscode-contrastActiveBorder); }
/* All tree offsets use the table's font size, including smaller source
   labels. An em on .loop-source would resolve at 88% and break alignment. */
.loop-tree { position: relative; --loop-unit: var(--vscode-editor-font-size, 13px); --loop-common-indent: calc(var(--loop-unit) * 1.05); --loop-reading-indent: calc(var(--loop-unit) * .95); --loop-branch-indent: calc(var(--loop-unit) * 2.1); }
.loop-tree-result .result-detail > .result-surface { padding-left: calc(8px + 3.25em); }
.loop-tree-result:not(.result-collapsed) .result-disclosure { left: calc(3px + 1.2em); }
.loop-tree .loop-columns, .loop-tree .loop-data { padding-left: 0; padding-right: 0; }
.loop-tree .loop-columns > :first-child { padding-left: var(--loop-common-indent); }
.loop-tree .loop-data > :first-child { padding-left: calc(var(--loop-common-indent) + max(0, var(--loop-depth, 0) - 1) * var(--loop-branch-indent) + min(1, var(--loop-depth, 0)) * var(--loop-reading-indent)); }
.loop-tree .loop-parent-reading > :first-child { padding-left: calc(var(--loop-common-indent) + var(--loop-depth, 0) * var(--loop-branch-indent)); }
.loop-tree .loop-iteration-header { padding-left: calc(var(--loop-common-indent) + var(--loop-depth, 0) * var(--loop-branch-indent)); }
.loop-tree .loop-invocation > .loop-source { margin-left: calc(var(--loop-common-indent) + max(0, var(--loop-depth, 0) - 1) * var(--loop-branch-indent)); }
.loop-tree .loop-iteration-header > [data-loop-action="toggle"], .loop-tree .loop-source > [data-loop-action="toggle-invocation"] { position: relative; }
.loop-tree .loop-iteration-header .loop-disclosure, .loop-tree .loop-source .loop-disclosure { position: absolute; left: calc(var(--loop-unit) * -1.4); top: 0; width: var(--loop-unit); text-align: center; }
.loop-guides { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; pointer-events: none; }
.loop-guides path { fill: none; stroke: var(--vscode-tree-indentGuidesStroke, #899399); stroke-width: 1.5; stroke-linejoin: miter; stroke-linecap: butt; }
body.vscode-high-contrast .loop-guides path, body.vscode-high-contrast-light .loop-guides path { stroke: var(--vscode-contrastActiveBorder, currentColor); }
/* Stack each variable/output pair when its actual result area cannot fit
   two legible columns. Local stream labels keep output distinct from the
   variables above it; stderr keeps its own existing label. */
@container (max-width: 28ch) {
  .loop-columns { display: none; }
  .loop-data { grid-template-columns: minmax(0, 1fr); row-gap: .2em; padding: .35em 0 .6em; }
  .loop-direct > :first-child { display: none; }
  .loop-stack-label {
    display: block;
    font-size: .86em;
  }
  .loop-target > .loop-stack-label {
    color: var(--vscode-descriptionForeground);
  }
}
`;
