"""Tests for form resolution.

One case per row of the statement/display table in `resolver.display_expr`,
plus the positional edge cases that made the table necessary.
"""

import ast
import os
import unittest

from resolver import form_at, form_of, forms_in

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


class Docstrings(unittest.TestCase):
    """A docstring is the one string constant nobody asked to see.

    The rule is positional rather than "skip string constants", because a bare
    string somewhere else in a file is someone evaluating a literal to look at
    it.
    """

    def test_a_module_docstring_shows_nothing(self):
        f = resolve('"""The module."""\nx = 1\n', 0)
        self.assertEqual(f.kind, "Expr")
        self.assertIsNone(f.display)

    def test_a_bare_string_further_down_still_shows_itself(self):
        self.assertEqual(resolve('x = 1\n"hello"\n', 1).display, "'hello'")

    def test_a_function_or_class_docstring_is_one_too(self):
        # Unreachable today -- a cursor inside either resolves to the whole
        # definition -- so the rule is pinned against `form_of` directly,
        # where sub-statement resolution would meet it.
        for src in ('def f():\n    """Doc."""\n    x = 1\n',
                    'class C:\n    """Doc."""\n    x = 1\n'):
            with self.subTest(src=src):
                body = ast.parse(src).body[0].body
                self.assertIsNone(form_of(body[0], first_in_body=True).display)
                self.assertIsNotNone(
                    form_of(body[1], first_in_body=False).display)

    def test_the_first_statement_of_a_module_is_only_special_if_it_is_a_string(self):
        self.assertEqual(resolve("x = 1\n", 0).display, "x")
        self.assertEqual(resolve("42\n", 0).display, "42")
        self.assertEqual(resolve("f'{x}'\n", 0).display, "f'{x}'")

    def test_a_docstring_still_resolves_and_still_runs(self):
        # Nothing to paint is not nothing to do: the region highlight is what
        # says the statement was evaluated.
        f = resolve('"""The module."""\n', 0)
        self.assertIsNotNone(f)
        self.assertEqual((f.start_line, f.end_line), (0, 0))


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


class AnnotatedNames(unittest.TestCase):
    """Which names a line offers up, and in which order.

    Only which names -- what they hold is the namespace's business. This side
    can say that `print("y:", y)` refers to `y`; it cannot say that `y` is
    worth showing, and does not try.
    """

    def names(self, src, line=0):
        return resolve(src, line).names

    def test_a_statement_offers_what_it_binds_then_what_it_reads(self):
        self.assertEqual(self.names("total = a + b\n"), ("a", "b"))

    def test_the_display_is_not_offered_a_second_time(self):
        # `x = 1` would otherwise read `x: 1   x: 1`.
        self.assertEqual(self.names("x = 1\n"), ())
        self.assertEqual(self.names("y = x\n"), ("x",))
        self.assertEqual(self.names("low, high = 1, 100\n"), ())
        self.assertEqual(self.names("shelf['jam'] = 99\n"), ())

    def test_an_expression_offers_the_names_inside_it(self):
        # The case the whole ticket turns on: the statement produced None and
        # `y` is the answer.
        self.assertEqual(self.names("y.append(4)\n"), ("y",))
        self.assertEqual(self.names('print("y:", y)\n'), ("print", "y"))

    def test_a_bare_name_expression_offers_nothing_extra(self):
        # The display already says `lst`, so a pair would repeat it.
        self.assertEqual(self.names("lst\n"), ())

    def test_a_statement_with_no_display_offers_everything_it_touched(self):
        # An `if` and a `while` have nothing to point at, which is why they
        # used to annotate nothing at all.
        self.assertEqual(self.names("if budget > 100:\n    tier = 'l'\n"),
                         ("tier", "budget"))
        self.assertEqual(self.names("while countdown:\n    countdown -= 1\n"),
                         ("countdown",))

    def test_a_name_both_bound_and_read_is_offered_once(self):
        self.assertEqual(self.names("n = m + 1\nn += 1\n", 1), ())
        self.assertEqual(self.names("a = a + b\n"), ("b",))

    def test_a_definition_offers_its_name_and_not_its_body(self):
        # Its body runs when it is called, which may be long after this
        # evaluation; the names in it do not exist yet, or belong to a scope
        # nothing here can see.
        self.assertEqual(self.names("def f():\n    return secret\n"), ())
        self.assertEqual(self.names("class C:\n    x = hidden\n"), ())
        self.assertEqual(self.names("fn = lambda: hidden\n"), ())

    def test_a_loop_offers_what_it_iterates_and_what_its_body_bound(self):
        self.assertEqual(
            self.names("for p in squares:\n    seen = p\n"),
            ("seen", "squares"))

    def test_a_deleted_name_is_offered_neither_way(self):
        # It is gone; reading it back would raise where the statement worked.
        self.assertEqual(self.names("del scratch\n"), ())

    def test_an_import_offers_the_names_it_bound(self):
        self.assertEqual(self.names("import os, sys\n"), ("sys",))

    def test_a_docstring_offers_nothing(self):
        self.assertEqual(self.names('"""The module."""\n'), ())


class HeaderAnchors(unittest.TestCase):
    """Where the value is written, as distinct from how much code ran.

    A compound statement annotated its last body line, so `greet: <function
    greet>` sat beside `return f"hello {name}"` and `p: 16` beside `print(p)`
    -- both of which read as claims about the wrong line, and the second of
    which names the one call in the file that returns None.
    """

    def test_a_def_is_annotated_on_the_def_line(self):
        f = resolve("def greet(name):\n    return name\n", 0)
        self.assertEqual(f.end_line, 1, "the region still covers the body")
        self.assertEqual(f.anchor_line, 0)

    def test_a_loop_is_annotated_on_its_header(self):
        f = resolve("for p in squares:\n    print(p)\n", 0)
        self.assertEqual((f.anchor_line, f.end_line), (0, 1))

    def test_every_compound_statement_anchors_on_its_header(self):
        for src in ("def f():\n    pass\n    pass\n",
                    "async def f():\n    pass\n    pass\n",
                    "class C:\n    pass\n    pass\n",
                    "for i in x:\n    pass\n    pass\n",
                    "while x:\n    pass\n    pass\n",
                    "with x as y:\n    pass\n    pass\n",
                    "if x:\n    pass\n    pass\n",
                    "try:\n    pass\nexcept Exception:\n    pass\n"):
            with self.subTest(src=src):
                f = resolve(src, 0)
                self.assertEqual(f.anchor_line, 0)
                self.assertGreater(f.end_line, 0, "the region still covers it")

    def test_everything_else_still_anchors_where_it_ends(self):
        # A multi-line expression genuinely finishes where its value appears;
        # the header line alone would be a puzzling place for the answer.
        f = resolve("total = sum([\n    10,\n    20,\n])\n", 0)
        self.assertEqual(f.anchor_line, 3)
        self.assertEqual(f.anchor_line, f.end_line)
        self.assertEqual(resolve("x = 1\n", 0).anchor_line, 0)

    def test_a_decorated_definition_anchors_on_the_def_not_the_decorator(self):
        # The decorator line is not where the name appears.
        f = resolve("@deco\n@more\ndef f():\n    pass\n", 0)
        self.assertEqual(f.start_line, 0, "the region still covers both")
        self.assertEqual(f.anchor_line, 2)

    def test_a_wrapped_signature_anchors_on_the_line_that_closes_it(self):
        # The header runs from `def` to the `):` that ends the clause, and the
        # value belongs at the end of it rather than in the middle.
        f = resolve("def f(\n    a,\n    b,\n):\n    return a\n", 0)
        self.assertEqual(f.anchor_line, 3)

    def test_a_header_and_body_on_one_line_anchor_together(self):
        # `if x: pass` has no line above the body to fall onto.
        self.assertEqual(resolve("if x: pass\n", 0).anchor_line, 0)

    def test_a_decorated_first_body_statement_does_not_pull_the_anchor_down(self):
        # A method's decorator sits above its `def`, so measuring the body
        # from `lineno` alone would anchor the class on the decorator line.
        f = resolve("class C:\n    @property\n    def m(self):\n        pass\n", 0)
        self.assertEqual(f.anchor_line, 0)


class FormsInARange(unittest.TestCase):
    """Which statements a selection runs, and how far outward it snaps.

    The rule under test is that a statement runs whole or not at all. Running
    a selection as written is the alternative, and it is the one that quietly
    executes something other than what the reader highlighted -- a `def` cut
    off after its signature, a loop cut off before its body.
    """

    #: 0: a = 1  1: b = 2  2-4: def f  5: c = 3
    SOURCE = ("a = 1\n"
              "b = 2\n"
              "def f(x):\n"
              "    y = x + 1\n"
              "    return y\n"
              "c = 3\n")

    def shown(self, lines, source=None):
        tree = ast.parse(self.SOURCE if source is None else source)
        return [form.display for form in forms_in(tree, lines)]

    def test_no_range_at_all_is_the_whole_body(self):
        self.assertEqual(self.shown(None), ["a", "b", "f", "c"])

    def test_a_range_runs_the_statements_it_covers_and_no_others(self):
        self.assertEqual(self.shown((0, 1)), ["a", "b"])

    def test_a_range_starting_inside_a_statement_takes_it_whole(self):
        # Line 3 is inside the body of the `def`. Running lines 3-5 as written
        # would bind nothing and raise on the `return`.
        self.assertEqual(self.shown((3, 5)), ["f", "c"])

    def test_a_range_ending_inside_a_statement_takes_it_whole(self):
        self.assertEqual(self.shown((1, 3)), ["b", "f"])

    def test_the_span_reported_is_the_statements_own(self):
        # What makes the widening visible: the `def` starts two lines above
        # where the range did, and the extension says so on the strength of
        # these numbers.
        first = forms_in(ast.parse(self.SOURCE), (3, 5))[0]
        self.assertEqual((first.start_line, first.end_line), (2, 4))

    def test_a_range_over_no_statement_at_all_runs_nothing(self):
        # Not an error, and emphatically not the nearest statement instead.
        self.assertEqual(
            self.shown((1, 3), "a = 1\n\n# a comment\n\nb = 2\n"), [])

    def test_a_backwards_range_runs_nothing(self):
        # How a malformed narrowing request reaches here. Nothing is the safe
        # reading of it; the whole file is not.
        self.assertEqual(self.shown((0, -1)), [])

    def test_a_decorated_def_is_reached_from_its_decorator_line(self):
        self.assertEqual(
            self.shown((0, 0), "@deco\ndef f():\n    pass\n"), ["f"])

    DOCUMENTED = '"""doc"""\nx = 1\n"hello"\n'

    def test_the_module_docstring_stays_silent_when_selected_alone(self):
        self.assertEqual(self.shown((0, 0), self.DOCUMENTED), [None])

    def test_a_string_further_down_is_not_made_into_a_docstring(self):
        # `first_in_body` is decided against the module, not against the
        # selection. Deciding it against the selection would swallow the value
        # of any string a range happens to start on.
        self.assertEqual(self.shown((2, 2), self.DOCUMENTED), ["'hello'"])


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

    def test_every_anchor_in_the_tour_lands_inside_its_own_statement(self):
        # An anchor outside the range would paint a value beside code the
        # statement never covered, which is the one thing worse than painting
        # it in an awkward place.
        for node in self.tree.body:
            with self.subTest(line=node.lineno):
                form = form_of(node)
                self.assertGreaterEqual(form.anchor_line, form.start_line)
                self.assertLessEqual(form.anchor_line, form.end_line)

    def test_every_single_line_range_snaps_to_whole_statements(self):
        # A one-line selection is the narrowest thing a user can hand this,
        # and every line of the tour is one: comments, blank lines, the
        # middles of wrapped calls, decorator lines. Whatever comes back must
        # cover the line it was asked about and start no later than it.
        for line in range(len(self.source.splitlines())):
            with self.subTest(line=line + 1):
                for form in forms_in(self.tree, (line, line)):
                    self.assertLessEqual(form.start_line, line)
                    self.assertGreaterEqual(form.end_line, line)

    def test_a_range_over_the_whole_tour_is_the_whole_tour(self):
        last = len(self.source.splitlines())
        self.assertEqual(len(forms_in(self.tree, (0, last))),
                         len(self.tree.body))

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
