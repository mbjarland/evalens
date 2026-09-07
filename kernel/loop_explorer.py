"""Bounded nesting evidence, recorded during an explicitly requested loop.

Offsets are Python Unicode character offsets into the statement's original
stdout/stderr, including unretained characters. Identity never comes from an
offset: a silent iteration has the same bounds as its neighbour. Invocation
and parent-iteration IDs instead come from the execution stack. The first
ENTRY_LIMIT invocations/iterations share one budget across the statement.
"""

ENTRY_LIMIT = 2000


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
        frame[2] = entry

    def end_iteration(self, site):
        entry = self.stack[-1][2]
        if entry is not None:
            entry['end'] = self._offset()
        self.stack[-1][2] = None

    def finish(self, site):
        _, entry, _, _ = self.stack.pop()
        if entry is not None:
            entry['end'] = self._offset()

    def wire(self, final_values):
        sites = [{key: value for key, value in site.items() if key != 'names'}
                 for site in self.sites]
        return dict(version=1, sites=sites, entries=self.entries,
                    statement_line=self.statement_line,
                    iterations=self.iterations, invocations=self.invocations,
                    omitted_iterations=self.omitted_iterations,
                    omitted_invocations=self.omitted_invocations,
                    retained=[self.out.retained(), self.err.retained()],
                    totals=self._offset(), final_values=final_values)
