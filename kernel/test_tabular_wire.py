"""Tests that `table` reaches the wire correctly, against a real kernel.

`test_tabular.py` proves `tabular.describe` in isolation; this proves the
three things that can only be shown by actually running the kernel as a
subprocess, the way the extension does:

* the `table` field arrives on a real `eval` response, computed from the
  value the statement produced -- not a second evaluation of anything;
* a value large enough to matter is never walked whole, measured against a
  real process rather than assumed from reading the bounding code; and
* the field is silent -- costs nothing on the wire -- for the ordinary
  values that are the overwhelming majority of what a first-year course
  evaluates, which is what "pandas absent" and "not everything is a table"
  both come down to in practice.

Reuses `KernelProcess` from `test_kernel` rather than re-implementing a
second subprocess harness for the same protocol.
"""

import time
import unittest

from test_kernel import KernelProcess


class TableOnTheWire(unittest.TestCase):
    def setUp(self):
        self.kernel = KernelProcess(control=False)

    def tearDown(self):
        self.kernel.close()

    def test_a_list_of_dicts_carries_a_table_field(self):
        response = self.kernel.evaluate(
            "rows = [{'name': 'Ada', 'age': 36}, {'name': 'Alan', 'age': 41}]\n",
            0)
        self.assertTrue(response["ok"])
        table = response["table"]
        self.assertEqual(table["kind"], "records")
        self.assertEqual(table["columns"], ["name", "age"])
        self.assertEqual(table["row_count"], 2)

    def test_an_ordinary_int_carries_no_table_field(self):
        response = self.kernel.evaluate("answer = 42\n", 0)
        self.assertTrue(response["ok"])
        self.assertNotIn("table", response)

    def test_an_ordinary_string_carries_no_table_field(self):
        response = self.kernel.evaluate("greeting = 'hello'\n", 0)
        self.assertNotIn("table", response)

    def test_pandas_absent_changes_nothing_about_an_ordinary_value(self):
        # The default case this feature must not regress: most machines
        # running Evalens, and every one a first-year student starts on,
        # has no pandas installed. Proven here by using this same
        # interpreter -- whatever it is -- and asserting the response is
        # unaffected by the table machinery existing in the kernel at all.
        response = self.kernel.evaluate("lst = [1, 2, 3]\n", 0)
        self.assertEqual(response["value"], "[1, 2, 3]")
        self.assertNotIn("table", response)

    def test_a_named_value_on_the_line_carries_its_own_table_too(self):
        source = "rows = [{'a': 1}, {'a': 2}]\nprint(rows)\n"
        self.kernel.evaluate(source, 0)
        response = self.kernel.evaluate(source, 1)
        self.assertTrue(response["ok"])
        names = {pair["name"]: pair for pair in response["names"]}
        self.assertIn("table", names["rows"])
        self.assertEqual(names["rows"]["table"]["kind"], "records")

    def test_a_million_element_list_answers_promptly_and_reports_its_size(self):
        source = "big = [{'n': i} for i in range(1_000_000)]\n"
        started = time.monotonic()
        response = self.kernel.evaluate(source, 0)
        elapsed = time.monotonic() - started
        self.assertTrue(response["ok"])
        table = response["table"]
        self.assertEqual(table["row_count"], 1_000_000)
        self.assertLess(table["shown_rows"], 20)
        self.assertGreater(table["more_rows"], 999_000)
        # Generous on purpose -- this is a real subprocess on a shared CI
        # runner, and the property under test is "did not walk a million
        # rows", not "is fast in some absolute sense". A regression to a
        # full walk costs whole seconds building the list of reprs, not
        # milliseconds, and this margin still catches that.
        self.assertLess(elapsed, 5.0)

    def test_the_kernel_never_imports_pandas(self):
        # A duck-typed check that reads only `__module__`/`__qualname__`
        # must never import the module it is checking for the name of --
        # that is the whole promise, and it is checked here rather than only
        # argued for: if `tabular.py` or `evalens_kernel.py` ever gained a
        # stray `import pandas`, this fails on any machine without it
        # installed, which includes the one running this suite.
        response = self.kernel.evaluate_lines(
            "import sys\nhas_pandas = 'pandas' in sys.modules\n", 0, 1)
        self.assertTrue(response["ok"])
        self.assertEqual(response["value"], "False")

    def test_a_generator_is_never_consumed_to_look_for_a_table(self):
        source = (
            "def gen():\n"
            "    yield {'a': 1}\n"
            "    yield {'a': 2}\n"
            "g = gen()\n"
            "seen = list(g)\n"
        )
        self.kernel.evaluate(source, 0)
        self.kernel.evaluate(source, 1)
        self.kernel.evaluate(source, 2)
        self.kernel.evaluate(source, 3)
        response = self.kernel.evaluate(source, 4)
        self.assertTrue(response["ok"])
        # If evaluating `g` for a table had consumed it, `list(g)` here
        # would be empty rather than both dicts.
        self.assertEqual(response["value"], "[{'a': 1}, {'a': 2}]")


if __name__ == "__main__":
    unittest.main()
