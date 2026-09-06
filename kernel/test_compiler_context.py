"""Compiler directives must belong to the source being evaluated."""
import unittest

from test_kernel import KernelProcess


class CompilerContext(unittest.TestCase):
    def setUp(self):
        self.k = KernelProcess(control=False)
        self.addCleanup(self.k.close)

    def test_file_honors_explicit_annotations_future(self):
        result = self.k.send(op="eval_file", source=(
            '"""module docstring"""\n'
            'from __future__ import annotations\n'
            'def f(x: int): pass\n'
            'f.__annotations__["x"]\n'))
        self.assertEqual(result["results"][-1]["value"], "'int'")

    def test_cursor_uses_file_directives_without_running_other_statements(self):
        source = ('from __future__ import annotations\n'
                  'unrequested = 1 / 0\n'
                  'def f(x: NotDefined): pass\n')
        self.assertTrue(self.k.evaluate(source, 2)["ok"])
        self.assertEqual(
            self.k.evaluate('f.__annotations__["x"]', 0)["value"],
            "'NotDefined'")

    def test_selection_retains_unselected_future_context(self):
        result = self.k.send(op="eval_file", source=(
            'from __future__ import annotations\n'
            'def f(x: int): pass\n'
            'f.__annotations__["x"]\n'), start_line=1, end_line=2)
        self.assertEqual(result["results"][-1]["value"], "'int'")

    def test_above_and_watch_share_the_same_compiler_context(self):
        source = ('from __future__ import annotations\n'
                  'for i in [1]:\n'
                  '    def f(x: int): pass\n'
                  'f.__annotations__["x"]\n')
        result = self.k.send(op="eval_above", source=source, line=3)
        self.assertEqual(result["ran"], 2)
        self.assertEqual(self.k.evaluate(source, 3)["value"], "'int'")
        result = self.k.watch(source, 1, 'f.__annotations__["x"]')
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["bindings"][-1]["values"], ["'int'"])

    def test_future_flags_do_not_leak_to_another_document(self):
        self.k.send(op="eval_file", source=(
            'from __future__ import annotations\ndef f(x: int): pass\n'))
        self.k.send(op="eval_file", source='def g(x: int): pass\n')
        self.assertEqual(self.k.evaluate(
            'g.__annotations__["x"] is int', 0)["value"], "True")
