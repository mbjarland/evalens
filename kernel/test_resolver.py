"""Tests for form resolution.

One case per row of the statement/display table in `resolver.display_expr`,
plus the positional edge cases that made the table necessary.
"""

import ast
import os
import unittest

from resolver import form_at, form_of

#: The manual test fixture, located relative to this file rather than to the
#: working directory: the suite is discovered with `-t kernel`, so a relative
#: path would depend on where the runner happened to be started.
TOUR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "examples", "tour.py")


def resolve(src: str, line: int):
    """Resolve at a 0-based line of `src`, which is written without indent."""
    return form_at(ast.parse(src), line)


class DisplayMapping(unittest.TestCase):
    def test_assign_shows_the_target(self):
        f = resolve("lst = [1, 2, 3]\n", 0)
        self.assertEqual(f.kind, "Assign")
        self.assertEqual(f.display, "lst")

    def test_chained_assign_shows_the_leftmost_target(self):
        self.assertEqual(resolve("a = b = 1\n", 0).display, "a")

    def test_tuple_assign_shows_the_whole_target(self):
        self.assertEqual(resolve("a, b = 1, 2\n", 0).display, "(a, b)")

    def test_subscript_and_attribute_targets_survive(self):
        self.assertEqual(resolve("d['k'] = 1\n", 0).display, "d['k']")
        self.assertEqual(resolve("obj.x = 1\n", 0).display, "obj.x")

    def test_annotated_assign_shows_the_target(self):
        self.assertEqual(resolve("n: int = 5\n", 0).display, "n")

    def test_augmented_assign_shows_the_target(self):
        self.assertEqual(resolve("n += 1\n", 0).display, "n")

    def test_bare_expression_shows_itself(self):
        f = resolve("lst\n", 0)
        self.assertEqual(f.kind, "Expr")
        self.assertEqual(f.display, "lst")

    def test_def_and_class_show_the_bound_name(self):
        self.assertEqual(resolve("def f():\n    pass\n", 0).display, "f")
        self.assertEqual(resolve("class C:\n    pass\n", 0).display, "C")
        self.assertEqual(resolve("async def g():\n    pass\n", 0).display, "g")

    def test_import_shows_the_name_it_binds(self):
        self.assertEqual(resolve("import numpy as np\n", 0).display, "np")
        # `import os.path` binds `os`, not `os.path`.
        self.assertEqual(resolve("import os.path\n", 0).display, "os")
        self.assertEqual(resolve("from x import y\n", 0).display, "y")
        self.assertEqual(resolve("from x import y as z\n", 0).display, "z")

    def test_for_shows_the_loop_target(self):
        self.assertEqual(resolve("for i in range(3):\n    pass\n", 0).display, "i")

    def test_with_shows_optional_vars_when_present(self):
        self.assertEqual(
            resolve("with open('f') as fh:\n    pass\n", 0).display, "fh")
        self.assertIsNone(
            resolve("with lock:\n    pass\n", 0).display)

    def test_statements_with_nothing_to_show_resolve_with_no_display(self):
        for src in ("del x\n", "if x:\n    pass\n", "while x:\n    pass\n",
                    "try:\n    pass\nexcept Exception:\n    pass\n"):
            with self.subTest(src=src):
                f = resolve(src, 0)
                self.assertIsNotNone(f, "the statement should still resolve")
                self.assertIsNone(f.display)


class Positions(unittest.TestCase):
    def test_a_cursor_inside_a_function_resolves_to_the_whole_def(self):
        src = "def f():\n    x = 1\n    return x\n"
        f = resolve(src, 1)
        self.assertEqual(f.kind, "FunctionDef")
        self.assertEqual(f.display, "f")
        self.assertEqual((f.start_line, f.end_line), (0, 2))

    def test_a_cursor_on_a_decorator_resolves_to_the_function(self):
        # FunctionDef.lineno points at `def`, so without widening the start to
        # the first decorator this resolves to nothing at all.
        src = "@deco\ndef f():\n    pass\n"
        f = resolve(src, 0)
        self.assertIsNotNone(f, "a decorator line must resolve to its function")
        self.assertEqual(f.kind, "FunctionDef")
        self.assertEqual(f.start_line, 0)

    def test_a_multiline_statement_resolves_from_any_of_its_lines(self):
        src = "total = sum([\n    1,\n    2,\n])\n"
        for line in (0, 1, 2, 3):
            with self.subTest(line=line):
                f = resolve(src, line)
                self.assertEqual(f.display, "total")
                self.assertEqual((f.start_line, f.end_line), (0, 3))

    def test_a_blank_line_resolves_to_nothing(self):
        self.assertIsNone(resolve("a = 1\n\nb = 2\n", 1))

    def test_past_the_last_statement_resolves_to_nothing(self):
        self.assertIsNone(resolve("a = 1\n", 5))

    def test_an_empty_module_resolves_to_nothing(self):
        self.assertIsNone(resolve("", 0))

    def test_the_prototype_answers_reproduce(self):
        # The two answers IDEA.md cites from prototype/form_at_cursor.py.
        src = "\n" * 8 + "tup = (1, 2, 3)\n"
        self.assertEqual(resolve(src, 8).display, "tup")
        src = "evens = [x for x in range(20) if x % 2 == 0]\n"
        f = resolve(src, 0)
        self.assertEqual(f.display, "evens")
        self.assertEqual(f.kind, "Assign")


class TheTourFile(unittest.TestCase):
    """`examples/tour.py` is checked by hand; this keeps it honest.

    The file is the manual fixture for everything that needs eyes, and the
    script the demo is recorded from. Neither of those roles notices when it
    stops parsing, stops covering a statement kind, or starts tripping the
    resolver -- a fixture nobody runs is a fixture that rots into a page of
    stale comments. These are the assertions a human reading annotations
    would never make and would never miss.
    """

    @classmethod
    def setUpClass(cls):
        with open(TOUR, encoding="utf-8") as handle:
            cls.source = handle.read()
        cls.tree = ast.parse(cls.source, filename=TOUR)

    def test_every_line_of_the_tour_resolves_without_raising(self):
        # Blank lines, comment lines, continuation lines and the lines past
        # the end included: `form_at` answering None is a result, and raising
        # is not.
        for line in range(len(self.source.splitlines()) + 5):
            with self.subTest(line=line + 1):
                form_at(self.tree, line)

    def test_every_statement_in_the_tour_describes_itself(self):
        # `form_of` runs `display_expr`, so this walks the whole table over
        # real source rather than over one-line snippets.
        for node in self.tree.body:
            with self.subTest(line=node.lineno):
                form = form_of(node)
                self.assertEqual(form.kind, type(node).__name__)
                self.assertLessEqual(form.start_line, form.end_line)

    def test_every_statement_resolves_from_its_own_first_line(self):
        for node in self.tree.body:
            with self.subTest(line=node.lineno):
                self.assertIsNotNone(form_at(self.tree, node.lineno - 1))

    def test_the_tour_still_covers_every_statement_kind_it_claims_to(self):
        # The anti-rot assertion. Dropping a case while tidying the tour is
        # easy and invisible; losing the only `async def`, or the only `with`,
        # is not something a reader notices.
        kinds = {type(node).__name__ for node in self.tree.body}
        for kind in ("Assign", "AnnAssign", "AugAssign", "Expr", "FunctionDef",
                     "AsyncFunctionDef", "ClassDef", "Import", "ImportFrom",
                     "For", "With", "If", "While", "Delete", "Pass", "Assert",
                     "Try"):
            with self.subTest(kind=kind):
                self.assertIn(kind, kinds)

    def test_the_tour_keeps_its_main_guard(self):
        # The guard is the visible proof that loading a file does not run its
        # `__main__` block, and it is the one case that cannot be read off an
        # annotation: what it proves is the absence of one.
        guards = [node for node in self.tree.body
                  if isinstance(node, ast.If)
                  and "__name__" in ast.dump(node.test)
                  and node.body]
        self.assertTrue(guards, "the tour must keep an `if __name__` block")


if __name__ == "__main__":
    unittest.main()
