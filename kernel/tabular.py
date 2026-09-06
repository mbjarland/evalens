"""Bounded, duck-typed descriptions of tabular values, for #24.

A DataFrame's ``repr()`` is a grid, and squashing a grid onto one line
destroys the only thing that made it readable -- ``[3 rows x 12 columns]``
looks like an answer and is not one. The same is true of the shapes a course
reaches long before it reaches pandas: a list of dicts with consistent keys,
a list of same-length lists, a sequence of ``namedtuple``s. This module
answers one question about a value already in hand -- *does it look like a
table, and if so, what does a bounded slice of it look like* -- and never
answers anything else.

Scope, decided rather than assumed
-----------------------------------
The first user of Evalens is a first-year student who may never install
pandas. A view that only worked for ``pandas.DataFrame`` would be dead code
for that audience, so the shape this builds around is "a sequence of records
with consistent keys" -- which covers the stdlib shapes *and* a DataFrame,
because a DataFrame is exactly that with pandas' own vocabulary for it.
Four kinds are recognised, checked in this order:

``dataframe``
    A ``pandas.DataFrame``, detected without importing pandas -- see
    ``_is_dataframe``.
``records``
    A ``list`` or ``tuple`` of ``dict``, all sharing the same set of keys.
``namedtuples``
    A ``list`` or ``tuple`` of ``namedtuple`` instances sharing the same
    ``_fields``.
``rows``
    A ``list`` or ``tuple`` of same-length ``list``/``tuple``, columns
    labelled positionally (``"0"``, ``"1"``, ...), matching this project's
    own 0-based convention.

A plain iterator, generator or other single-pass object is never a candidate,
whatever it yields. Tabulating one would have to consume it, which destroys
the very value the annotation exists to describe -- the same reasoning that
keeps an expression statement from being evaluated twice elsewhere in this
kernel. Only concrete, already-materialised sequences are considered, and
this module never calls ``iter()`` or ``next()`` on anything it has not
first confirmed is a ``list`` or ``tuple``.

Dispatch is by type identity, never by a type's short name -- the same rule
``describe()`` and ``_BoundedRepr._method`` use in ``evalens_kernel``. For a
type already in hand (``list``, ``tuple``, ``dict``) that means the actual
type object, and a subclass only qualifies while it still uses the base
type's own ``__repr__``: a hand-written ``__repr__`` is a deliberate
statement about how the object reads, and second-guessing it here would be
exactly the mistake ``describe()`` already refuses to make. For pandas,
whose type this kernel must never import, "identity" is the nearest safe
substitute -- the *exact* ``(module, qualname)`` pair, checked as a tuple
rather than trusting ``__name__`` alone, which any unrelated class could
share by accident.

Bounded, always
---------------
A million-row frame -- or a million-element list -- must not be walked.
``HEAD_ROWS`` and ``TAIL_ROWS`` bound both what is *inspected* to decide the
shape and what is *shown*: the two are the same sample, so a shape check
never costs a second pass. ``row_count`` is still exact and still cheap --
``len()`` on a list or tuple and ``DataFrame.shape`` are both O(1), so the
total is always known even when only a slice of it is shown. ``MAX_COLUMNS``
bounds the same way sideways, for a dict with more keys than a screen has
room for.

Only visible record keys/fields are compared, along with total column
counts. A key outside the bounded sample is never searched for: a wide
record whose visible keys cannot be aligned is left as its ordinary repr.
Container storage is read with native operations, never subclass hooks.

What is not checked, and why that is the honest answer rather than an
oversight: consistency (matching keys, matching length) is only ever verified
across the bounded sample this looks at. A ten-million-row list whose keys
drift somewhere in the untouched middle reads as consistent here, exactly as
a loop's recorded trace only ever speaks for the iterations it kept. Walking
the rest to rule that out is the walk this module exists not to take.
"""

from __future__ import annotations

from typing import Any, Callable, Dict, List, Optional, Tuple
from itertools import islice
import passive

#: A value's own bounded repr, injected rather than imported -- this module
#: must not import `evalens_kernel` (which imports this one) or pandas
#: (which nothing in this kernel imports, ever). The caller hands in
#: whatever it already uses to build the wire's other text, so a table cell
#: gets the identical cycle-safe, budget-aware treatment as everything else
#: on the wire, including a `describe()` substitution for a function or an
#: instance found sitting in a cell.
CellRepr = Callable[[Any], str]

#: Rows kept from the start and from the end of a value too large to show
#: whole. Matches the shape `_BoundedRepr` already uses for a collection's
#: elision -- keep both ends, because the end is what says which range built
#: the thing -- applied here to rows instead of characters.
HEAD_ROWS = 10
TAIL_ROWS = 5

#: Columns kept before the rest are counted rather than shown. A dict from a
#: wide JSON response or a frame with a hundred columns is exactly the case
#: this exists for; a first-year student's list of dicts rarely has more than
#: a handful of keys and never notices this number.
MAX_COLUMNS = 12

#: How long a column header may run before it is cut. Headers are read once
#: per column, never per cell, so this can stay generous without costing the
#: table anything a wide frame would notice.
HEADER_LIMIT = 60


def _cap(text: str, limit: int) -> str:
    return text if len(text) <= limit else f"{text[:limit]}…"


def _header(value: Any) -> str:
    """A column label, as text -- a dict key or a namedtuple field may be
    anything hashable, and a header is read, never computed with."""
    text = value if type(value) is str else passive.text(value, HEADER_LIMIT)
    return _cap(text, HEADER_LIMIT)


def _plain(value: Any, base: type) -> bool:
    """Is `value` exactly `base`, or a subclass that kept `base`'s own
    `__repr__`?

    The same dispatch `evalens_kernel.describe` and `_BoundedRepr._method`
    use: type identity, and whether `__repr__` is inherited, never a type's
    name. A `class Row(dict)` that wrote its own `__repr__` made a deliberate
    statement about how it should read, and flattening it into a table row
    anyway would be the extension overruling that statement -- exactly what
    `describe()` already declines to do for any other type.
    """
    return (passive.base_type(value) is base
            and passive.member(type(value), "__repr__")
            is passive.member(base, "__repr__"))


def _is_dataframe(value: Any) -> bool:
    """A `pandas.DataFrame`, identified without importing pandas.

    `type(value).__module__` and `__qualname__` are attributes of the type
    object this process already holds -- reading them cannot import
    anything, and pandas is never imported by this kernel, present or
    absent. The pair is checked together rather than trusting `__qualname__`
    alone, because a class named `DataFrame` is not a coincidence this
    module gets to assume away; matching the module too is the whole reason
    this reads as identity rather than as a name-string guess. `.split('.')`
    covers both the historical `pandas.core.frame.DataFrame` and a future
    pandas that sets `__module__` to the shorter `"pandas"` some releases
    already use for a cleaner `repr()` -- both start with the same first
    segment, and nothing else legitimately will.
    """
    kind = type(value)
    module = passive.member(kind, "__module__")
    qualname = type.__dict__["__qualname__"].__get__(kind)
    if type(module) is not str or type(qualname) is not str:
        return False
    return module.split(".", 1)[0] == "pandas" and qualname == "DataFrame"


def _table(
    kind: str, columns: List[str], rows: List[List[str]], row_count: int,
    more_rows: int, col_count: int, more_cols: int
) -> Dict[str, Any]:
    result: Dict[str, Any] = {
        "kind": kind,
        "columns": columns,
        "rows": rows,
        "row_count": row_count,
        "shown_rows": len(rows),
        "col_count": col_count,
        "shown_cols": len(columns),
    }
    if more_rows > 0:
        result["more_rows"] = more_rows
    if more_cols > 0:
        result["more_cols"] = more_cols
    return result


def _describe_dataframe(
    value: Any, cell_repr: CellRepr
) -> Optional[Dict[str, Any]]:
    if not _is_dataframe(value):
        return None
    # `.shape` is metadata; `.columns` is sampled before formatting. Calling
    # them is introspection on the value already in hand, on the same terms
    # `len()`, `repr()` and `reversed()` already are elsewhere in this kernel;
    # it is not re-running the statement that produced the frame.
    try:
        n_rows, n_cols = value.shape
    except BaseException:  # noqa: BLE001 - .shape is a property; trust none of it
        return None
    if (type(n_rows) is not int or type(n_cols) is not int
            or n_rows <= 0 or n_cols <= 0):
        return None
    try:
        columns = [_header(c) for c in islice(value.columns, MAX_COLUMNS)]
    except BaseException:  # noqa: BLE001
        return None
    if len(columns) != min(n_cols, MAX_COLUMNS):
        return None
    more_cols = n_cols - len(columns)
    keep = len(columns)
    head_n = min(HEAD_ROWS, n_rows)
    tail_n = min(TAIL_ROWS, max(0, n_rows - head_n))
    try:
        rows: List[List[str]] = []
        head = value.iloc[:head_n, :keep]
        for record in islice(head.itertuples(index=False, name=None), head_n):
            rows.append([cell_repr(cell) for cell in islice(record, keep)])
        if tail_n:
            tail = value.iloc[n_rows - tail_n:, :keep]
            for record in islice(tail.itertuples(index=False, name=None), tail_n):
                rows.append([cell_repr(cell) for cell in islice(record, keep)])
    except BaseException:  # noqa: BLE001 - any of the above is pandas' code
        return None
    if len(rows) != head_n + tail_n or any(len(row) != keep for row in rows):
        return None
    more_rows = n_rows - len(rows)
    return _table("dataframe", columns, rows, n_rows, more_rows, n_cols,
                  more_cols)


def _sample(value: Any) -> Tuple[list, int]:
    """The bounded head-and-tail slice a sequence is judged and shown by.

    Slicing a `list` or `tuple` is O(k) in the slice's own length, not in the
    sequence's -- which is what makes this affordable on a value with
    millions of elements. The same slice answers both questions this module
    asks: whether the shape is consistent, and what to show, so nothing here
    is walked twice.
    """
    base = passive.base_type(value)
    n = base.__len__(value)
    head_n = min(HEAD_ROWS, n)
    tail_n = min(TAIL_ROWS, max(0, n - head_n))
    sample = list(base.__getitem__(value, slice(None, head_n)))
    if tail_n:
        sample += list(base.__getitem__(value, slice(n - tail_n, None)))
    return sample, n


def _same_key(left: Any, right: Any) -> bool:
    if left is right:
        return True
    return (type(left) is type(right)
            and any(type(left) is kind for kind in
                    (str, bytes, int, float, complex, bool, type(None)))
            and left == right)


def _record_values(item: dict, keys: list) -> Optional[list]:
    # Match only the bounded visible sample, without custom hashing/equality.
    # Different insertion orders are fine within that sample. If a visible
    # key moved beyond it, decline the table instead of walking a wide dict.
    entries = list(islice(dict.items(item), MAX_COLUMNS))
    values = []
    for key in keys:
        for candidate, value in entries:
            if _same_key(key, candidate):
                values.append(value)
                break
        else:
            return None
    return values


def _fields(item: Any) -> Optional[tuple]:
    if passive.base_type(item) is tuple:
        fields = passive.member(type(item), "_fields")
        if type(fields) is tuple:
            return fields
    return None


def _sample_shape(sample: list) -> Optional[Tuple[str, list, int]]:
    """`(kind, bounded raw_columns, total_columns)` or None.

    `raw_columns` are the columns' own keys/fields/positions, unconverted --
    what a row is later indexed by -- never the header text, which is a
    display decision made once afterwards in `_describe_sequence`.
    """
    first = sample[0]
    if _plain(first, dict):
        keys = list(islice(dict.keys(first), MAX_COLUMNS))
        if not keys:
            return None
        count = dict.__len__(first)
        for item in sample[1:]:
            if (not _plain(item, dict) or dict.__len__(item) != count
                    or _record_values(item, keys) is None):
                return None
        return "records", keys, count
    fields = _fields(first)
    if fields is not None:
        if not fields:
            return None
        visible = list(fields[:MAX_COLUMNS])
        if any(type(field) is not str for field in visible):
            return None
        for item in sample:
            other = _fields(item)
            if (other is None or len(other) != len(fields)
                    or tuple.__len__(item) != len(fields)
                    or not all(_same_key(a, b) for a, b in
                               zip(visible, other[:MAX_COLUMNS]))):
                return None
        return "namedtuples", visible, len(fields)
    if _plain(first, list) or _plain(first, tuple):
        length = passive.base_type(first).__len__(first)
        if length == 0:
            return None
        for item in sample[1:]:
            if not ((_plain(item, list) or _plain(item, tuple))
                    and passive.base_type(item).__len__(item) == length):
                return None
        return "rows", list(range(min(length, MAX_COLUMNS))), length
    return None


def _row_cells(
    item: Any, kind: str, raw_columns: list, cell_repr: CellRepr
) -> Optional[List[str]]:
    if kind == "records":
        values = _record_values(item, raw_columns)
        return None if values is None else [cell_repr(v) for v in values]
    # "namedtuples" and "rows" are both already positional tuples/lists in
    # field/index order, so iterating `item` itself is the row.
    base = passive.base_type(item)
    return [cell_repr(cell) for cell in
            islice(base.__iter__(item), len(raw_columns))]


def _describe_sequence(
    value: Any, cell_repr: CellRepr
) -> Optional[Dict[str, Any]]:
    # Only a materialised `list` or `tuple` -- never a bare `Iterable`. A
    # generator, a `map` object or a `csv.DictReader` is single-pass: reading
    # it to decide whether it looks like a table would consume it, and the
    # code below it that meant to iterate it for real would find it empty.
    # That is the one shape this module refuses on principle rather than on
    # a failed check.
    if not (_plain(value, list) or _plain(value, tuple)):
        return None
    if passive.base_type(value).__len__(value) == 0:
        return None
    sample, n = _sample(value)
    shape = _sample_shape(sample)
    if shape is None:
        return None
    kind, raw_columns, col_count = shape
    try:
        rows = [_row_cells(item, kind, raw_columns, cell_repr)
                for item in sample]
    except BaseException:  # noqa: BLE001 - a dict subclass's __getitem__, etc.
        return None
    if any(row is None for row in rows):
        return None
    columns = [_header(c) for c in raw_columns]
    more_cols = col_count - len(columns)
    more_rows = n - len(sample)
    return _table(kind, columns, rows, n, more_rows, col_count,
                  more_cols)


def describe(value: Any, cell_repr: CellRepr) -> Optional[Dict[str, Any]]:
    """A bounded table description for `value`, or None.

    None means exactly what it means everywhere else in this kernel:
    render the value the way it already is rendered. This is additive --
    the annotation and the ordinary `repr()` are unchanged either way, and
    the table is only ever an elaboration reached by asking for one, never
    a replacement for the trace on the line.

    Never raises. Every path a caller cannot control -- a `.shape` that is
    actually a property with a body, a `__getitem__` a dict subclass wrote
    by hand, a metaclass that intercepts attribute access -- is caught here
    or in the callee it happened in, on the same terms `describe()` and
    `safe_repr()` already catch them in `evalens_kernel`. A value that
    cannot be safely inspected this way is simply not tabular today.
    """
    try:
        table = _describe_dataframe(value, cell_repr)
        if table is not None:
            return table
        return _describe_sequence(value, cell_repr)
    except BaseException:  # noqa: BLE001 - introspection runs user code too
        return None
