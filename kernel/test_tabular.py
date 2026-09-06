"""Tests for `tabular.describe`, in-process and against pure functions.

Unlike `test_kernel`, this does not need a subprocess: nothing here reads or
writes a pipe, and the property under test -- what `tabular.describe` decides
about a value already in hand -- is a pure function of that value. The
subprocess proof that this is wired onto the wire correctly, and that a real
kernel never walks more of a huge value than it should, lives in
`test_tabular_wire.py`.

`identity_repr` stands in for the kernel's own `safe_repr`: these tests are
about detection and bounding, not about how a cell's text is built, so a cell
repr that just calls `repr()` keeps every assertion about *which* values
ended up in `rows` legible without dragging `evalens_kernel` in as a second
module under test.
"""

import collections
import unittest

import tabular


def identity_repr(value):
    return repr(value)


class CountingRepr:
    """A `cell_repr` that counts its own calls, to prove boundedness."""

    def __init__(self):
        self.calls = 0

    def __call__(self, value):
        self.calls += 1
        return repr(value)


class DataFrameDuckType(unittest.TestCase):
    """A fake shaped exactly like `pandas.DataFrame`'s type, and nothing
    else -- proving the detection reads `__module__`/`__qualname__` and
    never needs pandas installed to be exercised."""

    @staticmethod
    def fake_dataframe(module="pandas.core.frame", qualname="DataFrame",
                        rows=None, columns=("a", "b"), broken_shape=False):
        rows = rows if rows is not None else [(1, 2), (3, 4)]

        class _Frame:
            def __init__(self):
                self.columns = list(columns)

            @property
            def shape(self):
                if broken_shape:
                    raise RuntimeError("boom")
                return (len(rows), len(columns))

            @property
            def iloc(self):
                frame = self

                class _Loc:
                    def __getitem__(self, key):
                        row_slice, col_slice = key
                        sliced = rows[row_slice]

                        class _Sliced:
                            def itertuples(self, index=False, name=None):
                                for row in sliced:
                                    yield tuple(row[col_slice])

                        return _Sliced()

                return _Loc()

        _Frame.__module__ = module
        _Frame.__qualname__ = qualname
        return _Frame()

    def test_module_and_qualname_together_are_what_is_matched(self):
        frame = self.fake_dataframe()
        table = tabular.describe(frame, identity_repr)
        self.assertIsNotNone(table)
        self.assertEqual(table["kind"], "dataframe")
        self.assertEqual(table["columns"], ["a", "b"])

    def test_a_short_module_root_still_matches(self):
        # Some pandas releases set `__module__` to the bare `"pandas"`
        # rather than `pandas.core.frame`; both must be recognised because
        # neither is a fact this module gets to assume stays fixed.
        frame = self.fake_dataframe(module="pandas")
        self.assertIsNotNone(tabular.describe(frame, identity_repr))

    def test_qualname_alone_is_not_enough(self):
        # A user's own class called DataFrame, in a module that is not
        # pandas's, must never be mistaken for one -- this is exactly the
        # false positive a name-only check would produce.
        frame = self.fake_dataframe(module="myapp.models")
        self.assertIsNone(tabular.describe(frame, identity_repr))

    def test_module_alone_is_not_enough(self):
        frame = self.fake_dataframe(module="pandas.core.frame",
                                     qualname="Series")
        self.assertIsNone(tabular.describe(frame, identity_repr))

    def test_row_count_and_column_count_are_the_real_totals(self):
        rows = [(i, i * i) for i in range(20)]
        frame = self.fake_dataframe(rows=rows)
        table = tabular.describe(frame, identity_repr)
        self.assertEqual(table["row_count"], 20)
        self.assertEqual(table["col_count"], 2)

    def test_head_and_tail_are_kept_and_the_middle_is_counted(self):
        rows = [(i,) for i in range(1000)]
        frame = self.fake_dataframe(rows=rows, columns=("n",))
        table = tabular.describe(frame, identity_repr)
        self.assertEqual(table["shown_rows"],
                          tabular.HEAD_ROWS + tabular.TAIL_ROWS)
        self.assertEqual(table["more_rows"],
                          1000 - (tabular.HEAD_ROWS + tabular.TAIL_ROWS))
        shown = [int(cell) for row in table["rows"] for cell in row]
        self.assertEqual(shown[:tabular.HEAD_ROWS], list(range(
            tabular.HEAD_ROWS)))
        self.assertEqual(shown[-tabular.TAIL_ROWS:],
                          list(range(1000 - tabular.TAIL_ROWS, 1000)))

    def test_an_empty_frame_is_not_tabular(self):
        frame = self.fake_dataframe(rows=[], columns=("a",))
        self.assertIsNone(tabular.describe(frame, identity_repr))

    def test_a_frame_with_no_columns_is_not_tabular(self):
        frame = self.fake_dataframe(rows=[(), ()], columns=())
        self.assertIsNone(tabular.describe(frame, identity_repr))

    def test_a_broken_shape_property_answers_none_rather_than_raise(self):
        frame = self.fake_dataframe(broken_shape=True)
        self.assertIsNone(tabular.describe(frame, identity_repr))


class Records(unittest.TestCase):
    def test_a_list_of_dicts_with_the_same_keys_is_records(self):
        rows = [{"a": 1, "b": 2}, {"a": 3, "b": 4}, {"a": 5, "b": 6}]
        table = tabular.describe(rows, identity_repr)
        self.assertEqual(table["kind"], "records")
        self.assertEqual(table["columns"], ["a", "b"])
        self.assertEqual(table["rows"], [["1", "2"], ["3", "4"], ["5", "6"]])
        self.assertEqual(table["row_count"], 3)
        self.assertEqual(table["col_count"], 2)

    def test_a_tuple_of_dicts_qualifies_too(self):
        rows = ({"a": 1}, {"a": 2})
        table = tabular.describe(rows, identity_repr)
        self.assertEqual(table["kind"], "records")

    def test_key_order_may_differ_between_rows(self):
        rows = [{"a": 1, "b": 2}, {"b": 4, "a": 3}]
        table = tabular.describe(rows, identity_repr)
        self.assertIsNotNone(table)
        # Looked up by name, not by position, so a row whose dict happened
        # to iterate in a different order still lands in the right column.
        self.assertEqual(table["rows"], [["1", "2"], ["3", "4"]])

    def test_mismatched_keys_is_not_tabular(self):
        rows = [{"a": 1}, {"b": 2}]
        self.assertIsNone(tabular.describe(rows, identity_repr))

    def test_a_dict_missing_from_the_set_bails_the_whole_value(self):
        # Design rule 1: never assert more than is known. A table that
        # silently dropped or blanked the odd one out would show a grid
        # that implies more regularity than the value has.
        rows = [{"a": 1, "b": 2}, {"a": 3, "b": 4}, "not a dict"]
        self.assertIsNone(tabular.describe(rows, identity_repr))

    def test_an_empty_list_is_not_tabular(self):
        self.assertIsNone(tabular.describe([], identity_repr))

    def test_a_list_of_empty_dicts_is_not_tabular(self):
        self.assertIsNone(tabular.describe([{}, {}], identity_repr))

    def test_a_dict_subclass_with_its_own_repr_is_left_alone(self):
        class Loud(dict):
            def __repr__(self):
                return "LOUD"

        rows = [Loud(a=1), Loud(a=2)]
        self.assertIsNone(tabular.describe(rows, identity_repr))

    def test_a_list_subclass_with_its_own_repr_is_left_alone(self):
        class Table(list):
            def __repr__(self):
                return "a deliberate repr"

        rows = Table([{"a": 1}, {"a": 2}])
        self.assertIsNone(tabular.describe(rows, identity_repr))

    def test_a_plain_dict_subclass_still_qualifies(self):
        # Inherits `dict.__repr__` untouched, so nobody wrote a deliberate
        # statement about how it should read -- same rule `describe()` uses
        # for a plain subclass elsewhere in the kernel.
        class Row(dict):
            pass

        rows = [Row(a=1, b=2), Row(a=3, b=4)]
        table = tabular.describe(rows, identity_repr)
        self.assertEqual(table["kind"], "records")

    def test_many_columns_are_bounded_and_counted(self):
        row = {f"c{i}": i for i in range(tabular.MAX_COLUMNS + 5)}
        rows = [row, dict(row)]
        table = tabular.describe(rows, identity_repr)
        self.assertEqual(table["shown_cols"], tabular.MAX_COLUMNS)
        self.assertEqual(table["more_cols"], 5)
        self.assertEqual(table["col_count"], tabular.MAX_COLUMNS + 5)
        for row_cells in table["rows"]:
            self.assertEqual(len(row_cells), tabular.MAX_COLUMNS)


class NamedTuples(unittest.TestCase):
    def test_a_list_of_namedtuples_uses_its_fields_as_columns(self):
        Point = collections.namedtuple("Point", "x y")
        pts = [Point(1, 2), Point(3, 4)]
        table = tabular.describe(pts, identity_repr)
        self.assertEqual(table["kind"], "namedtuples")
        self.assertEqual(table["columns"], ["x", "y"])
        self.assertEqual(table["rows"], [["1", "2"], ["3", "4"]])

    def test_mismatched_fields_is_not_tabular(self):
        Point = collections.namedtuple("Point", "x y")
        Pair = collections.namedtuple("Pair", "left right")
        self.assertIsNone(
            tabular.describe([Point(1, 2), Pair(3, 4)], identity_repr))

    def test_an_ordinary_tuple_among_namedtuples_bails(self):
        Point = collections.namedtuple("Point", "x y")
        self.assertIsNone(
            tabular.describe([Point(1, 2), (3, 4)], identity_repr))


class PositionalRows(unittest.TestCase):
    def test_a_list_of_equal_length_lists_is_rows(self):
        grid = [[1, 2, 3], [4, 5, 6]]
        table = tabular.describe(grid, identity_repr)
        self.assertEqual(table["kind"], "rows")
        self.assertEqual(table["columns"], ["0", "1", "2"])
        self.assertEqual(table["rows"], [["1", "2", "3"], ["4", "5", "6"]])

    def test_lists_and_tuples_may_mix_if_the_length_agrees(self):
        grid = [[1, 2], (3, 4)]
        table = tabular.describe(grid, identity_repr)
        self.assertEqual(table["kind"], "rows")

    def test_mismatched_length_is_not_tabular(self):
        self.assertIsNone(tabular.describe([[1, 2], [3, 4, 5]], identity_repr))

    def test_rows_of_zero_length_are_not_tabular(self):
        self.assertIsNone(tabular.describe([[], []], identity_repr))

    def test_a_single_row_still_counts(self):
        table = tabular.describe([[1, 2]], identity_repr)
        self.assertEqual(table["row_count"], 1)


class NeverConsumed(unittest.TestCase):
    """The shapes this module must refuse outright, because inspecting them
    the way a list is inspected would consume the very value being
    described."""

    def test_a_generator_is_not_tabular_and_is_not_touched(self):
        def gen():
            yield {"a": 1}
            yield {"a": 2}

        g = gen()
        self.assertIsNone(tabular.describe(g, identity_repr))
        # Untouched: everything it would have yielded is still there.
        self.assertEqual(list(g), [{"a": 1}, {"a": 2}])

    def test_a_plain_iterator_is_not_tabular(self):
        it = iter([{"a": 1}, {"a": 2}])
        self.assertIsNone(tabular.describe(it, identity_repr))
        self.assertEqual(list(it), [{"a": 1}, {"a": 2}])

    def test_a_map_object_is_not_tabular(self):
        m = map(lambda x: {"a": x}, [1, 2])
        self.assertIsNone(tabular.describe(m, identity_repr))
        self.assertEqual(list(m), [{"a": 1}, {"a": 2}])

    def test_a_set_is_not_tabular(self):
        # A `set` of dicts cannot exist -- dicts are unhashable -- but a set
        # of anything else is also not a sequence this module claims: it has
        # no stable order to label rows by, unlike a list or tuple.
        self.assertIsNone(tabular.describe({1, 2, 3}, identity_repr))

    def test_a_dict_itself_is_not_tabular(self):
        # A mapping's own keys are not rows; only a *sequence* of mappings
        # is. Reusing `dict` here would be a second, incompatible meaning
        # for `records`.
        self.assertIsNone(tabular.describe({"a": 1, "b": 2}, identity_repr))

    def test_a_plain_scalar_is_not_tabular(self):
        self.assertIsNone(tabular.describe(42, identity_repr))
        self.assertIsNone(tabular.describe("just a string", identity_repr))
        self.assertIsNone(tabular.describe(None, identity_repr))


class CellRepresentation(unittest.TestCase):
    def test_wide_rows_and_records_only_format_visible_cells(self):
        width = 10000
        for row in (list(range(width)), {str(i): i for i in range(width)}):
            counter = CountingRepr()
            table = tabular.describe([row, row], counter)
            self.assertEqual(counter.calls, 2 * tabular.MAX_COLUMNS)
            self.assertEqual(table["col_count"], width)
            self.assertEqual(table["more_cols"], width - tabular.MAX_COLUMNS)

    def test_wide_frame_only_reads_visible_headers(self):
        width = 10000
        frame = DataFrameDuckType.fake_dataframe(
            rows=[list(range(width))], columns=range(width))
        seen = []

        def labels():
            for i in range(width):
                seen.append(i)
                yield str(i)

        frame.columns = labels()
        counter = CountingRepr()
        table = tabular.describe(frame, counter)
        self.assertEqual(len(seen), tabular.MAX_COLUMNS)
        self.assertEqual(counter.calls, tabular.MAX_COLUMNS)
        self.assertEqual(table["col_count"], width)

    def test_custom_traversal_and_metaclass_hooks_are_not_dispatched(self):
        calls = []

        class Meta(type):
            def __getattribute__(self, name):
                calls.append(name)
                return super().__getattribute__(name)

        class Sequence(list, metaclass=Meta):
            def __getitem__(self, key):
                calls.append("getitem")
                return super().__getitem__(key)

        class Row(dict):
            def items(self):
                calls.append("items")
                return super().items()

        class Tuple(tuple):
            @property
            def _fields(self):
                calls.append("fields")
                return ("x",)

        for value in (Sequence([[1]]), [Sequence([1])], [Row(a=1)],
                      [Tuple((1,))]):
            tabular.describe(value, identity_repr)
        self.assertEqual(calls, [])

    def test_cell_repr_is_called_once_per_shown_cell_and_nothing_more(self):
        rows = [{"a": i, "b": i * i} for i in range(1000)]
        counter = CountingRepr()
        table = tabular.describe(rows, counter)
        shown = table["shown_rows"] * table["shown_cols"]
        self.assertEqual(counter.calls, shown)

    def test_cell_repr_receives_the_real_values_not_pre_stringified_ones(self):
        seen = []

        def capturing_repr(value):
            seen.append(value)
            return str(value)

        tabular.describe([{"a": 7}], capturing_repr)
        self.assertEqual(seen, [7])

    def test_a_raising_cell_repr_fails_the_whole_table_rather_than_lie(self):
        def raises(value):
            raise ValueError("boom")

        self.assertIsNone(
            tabular.describe([{"a": 1}, {"a": 2}], raises))


class Headers(unittest.TestCase):
    def test_non_string_dict_keys_become_text(self):
        rows = [{1: "a", 2: "b"}, {1: "c", 2: "d"}]
        table = tabular.describe(rows, identity_repr)
        self.assertEqual(table["columns"], ["1", "2"])

    def test_a_very_long_header_is_capped(self):
        key = "x" * 200
        rows = [{key: 1}, {key: 2}]
        table = tabular.describe(rows, identity_repr)
        self.assertLessEqual(len(table["columns"][0]), tabular.HEADER_LIMIT + 1)


if __name__ == "__main__":
    unittest.main()
