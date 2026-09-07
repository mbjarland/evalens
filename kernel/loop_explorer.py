"""Bounded nesting evidence, recorded during an explicitly requested loop.

Offsets are Python Unicode character offsets into the statement's original
stdout/stderr, including unretained characters. Identity never comes from an
offset: a silent iteration has the same bounds as its neighbour. Invocation
and parent-iteration IDs instead come from the execution stack. The first
ENTRY_LIMIT invocations/iterations share one budget across the statement.
"""

ENTRY_LIMIT = 2000
HISTORY_HEAD_LIMIT = 50
BODY_VALUE_LIMIT = 1000


class LoopExplorer:
    def __init__(self, sites, out, err, limit=ENTRY_LIMIT, statement_line=0):
        self.sites = sites
        self.out, self.err = out, err
        self.limit = limit
        self.statement_line = statement_line
        self.entries = []
        self.stack = []
        self.next_id = 0
        self.iterations = 0
        self.invocations = 0
        # Per-site counters survive the detail budget. No iteration entries or
        # extra repr calls are needed to describe all executions of a header.
        self.site_invocations = [0] * len(sites)
        self.omitted_iterations = 0
        self.omitted_invocations = 0

    def _offset(self):
        return [self.out.offset(), self.err.offset()]

    def _entry(self, kind, **fields):
        self.next_id += 1
        if len(self.entries) >= self.limit:
            # Mark every retained ancestor once, even if no further output
            # distinguishes this point from its neighbours. Closing those
            # ancestors remains possible after the allocation budget is full.
            if self.next_id == self.limit + 1:
                for _, invocation, iteration, _ in self.stack:
                    for ancestor in (invocation, iteration):
                        if ancestor is not None:
                            ancestor['incomplete'] = True
            return None
        entry = dict(id=self.next_id, kind=kind, start=self._offset(),
                     end=None, **fields)
        self.entries.append(entry)
        return entry

    def begin(self, site):
        self.invocations += 1
        self.site_invocations[site] += 1
        parent = self.stack[-1][2] if self.stack else None
        parent_invocation = self.stack[-1][1] if self.stack else None
        entry = self._entry('invocation', site=site,
                            parent=None if parent is None else parent['id'],
                            parent_invocation=(None if parent_invocation is None
                                               else parent_invocation['id']),
                            count=0)
        if entry is None:
            self.omitted_invocations += 1
        # The stack is bounded by the source's lexical nesting, never by
        # iteration count; unretained parents cannot acquire retained children.
        self.stack.append([site, entry, None, 0])

    def iteration(self, site, text):
        frame = self.stack[-1]
        frame[3] += 1
        self.iterations += 1
        invocation = frame[1]
        if invocation is not None:
            invocation['count'] = frame[3]
        entry = self._entry('iteration', invocation=(
            None if invocation is None else invocation['id']),
            ordinal=frame[3], value=text)
        if entry is None:
            self.omitted_iterations += 1
        elif self.sites[site].get('body_names'):
            # Only normal end-of-body capture replaces this status. In
            # particular, continue/break must not inherit the previous pass.
            entry['body'] = dict(status='not-reached', values=[])
        frame[2] = entry

    def begin_body(self, site, available):
        """Attach existing body repr strings only to this retained iteration.

        No frame or namespace read happens here. LoopTrace.bind fills values
        as its established capture runs; missing names stay visibly missing.
        Once the entry budget is exhausted, no new body list is allocated.
        """
        entry = self.stack[-1][2]
        body = entry.get('body') if entry is not None else None
        if body is not None:
            body['status'] = 'captured' if available else 'unavailable'
        return body

    def body_value(self, site, body, name, text):
        if name not in self.sites[site]['body_names']:
            return
        # safe_repr's truncation/failure suffix can exceed its ITEM_LIMIT.
        # Bound the additive wire string, never ask the object to describe
        # itself again. The original bounded history remains unchanged.
        if len(text) > BODY_VALUE_LIMIT:
            text = text[:BODY_VALUE_LIMIT - 1] + '…'
        body['values'].append(dict(name=name, value=text))

    def end_iteration(self, site):
        entry = self.stack[-1][2]
        if entry is not None:
            entry['end'] = self._offset()
        self.stack[-1][2] = None

    def finish(self, site):
        _, entry, _, _ = self.stack.pop()
        if entry is not None:
            entry['end'] = self._offset()

    def wire(self, final_values, recorders=None):
        sites = [{key: value for key, value in site.items() if key != 'names'}
                 for site in self.sites]
        result = dict(version=1, sites=sites, entries=self.entries,
                    statement_line=self.statement_line,
                    iterations=self.iterations, invocations=self.invocations,
                    omitted_iterations=self.omitted_iterations,
                    omitted_invocations=self.omitted_invocations,
                    retained=[self.out.retained(), self.err.retained()],
                    totals=self._offset(), final_values=final_values)
        if recorders is not None:
            # All sites (at most 64) travel, including unvisited/empty ones.
            # The requested head length is normally <= 50; defend the wire
            # even when a hand-written request asks the recorder for more.
            result['histories'] = [dict(
                site=site['id'], invocations=self.site_invocations[site['id']],
                values=trace.head[:HISTORY_HEAD_LIMIT], count=trace.count,
                last=(trace.latest if trace.count > min(
                    len(trace.head), HISTORY_HEAD_LIMIT) else None))
                for site, trace in zip(self.sites, recorders)]
        return result
