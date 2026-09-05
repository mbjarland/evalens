"""Tests for form resolution.

One case per row of the statement/display table in `resolver.display_expr`,
plus the positional edge cases that made the table necessary.
"""

import ast
import os
import unittest

from resolver import cut_points, form_at, form_of, forms_in, parse_prefix

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

    def test_an_unpacking_assign_leaves_the_display_slot_empty(self):
        # It has several things to show rather than none, and the slot holds
        # one. `(a, b)` is not an identifier, so it is not labelled with and
        # falls through to `=>` -- where it echoes the right-hand side that is
        # already on the line. The names carry it instead; see AnnotatedNames.
        self.assertIsNone(resolve("a, b = 1, 2\n", 0).display)
        self.assertIsNone(resolve("head, *rest = [1, 2, 3, 4]\n", 0).display)
        self.assertIsNone(resolve("[p, q] = [1, 2]\n", 0).display)

    def test_a_loop_target_is_still_shown_whole(self):
        # The same shape, a different question. A `for` target labels the
        # sequence the kernel recorded, and the sequence is what gets painted.
        self.assertEqual(
            resolve("for k, v in d.items():\n    pass\n", 0).display, "(k, v)")

    def test_subscript_and_attribute_targets_survive(self):
        self.assertEqual(resolve("d['k'] = 1\n", 0).display, "d['k']")
        self.assertEqual(resolve("obj.x = 1\n", 0).display, "obj.x")

    def test_annotated_assign_shows_the_target(self):
        self.assertEqual(resolve("n: int = 5\n", 0).display, "n")

    def test_a_bare_annotation_shows_nothing(self):
        # `count: int` records an annotation and binds nothing at all, so
        # there is nothing to read back -- and reading it back raised
        # NameError, painting the extension's own failure in red beside a
        # line that had run perfectly.
        self.assertIsNone(resolve("count: int\n", 0).display)

    def test_augmented_assign_shows_the_target(self):
        self.assertEqual(resolve("n += 1\n", 0).display, "n")

    def test_an_augmented_assign_to_a_place_shows_nothing(self):
        # `counter.n += 1` has already called the getter once, legitimately.
        # Reading the target back to display it calls it a second time, and
        # unlike a plain assignment there is no value to hand over instead:
        # the sum exists only inside the object it was stored into.
        self.assertIsNone(resolve("counter.n += 1\n", 0).display)
        self.assertIsNone(resolve("totals['a'] += 1\n", 0).display)

    def test_an_annotated_assign_to_a_place_shows_nothing(self):
        self.assertIsNone(resolve("obj.x: int = 5\n", 0).display)

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

    def test_a_star_import_shows_nothing(self):
        # There is no one name to show: what `*` binds is decided at runtime
        # by the exporting module. The alias's name is the literal `"*"`, and
        # handing that over as the expression to display had the kernel
        # compile it -- `=> SyntaxError: invalid syntax (<unknown>, line 1)`,
        # in red, beside an import that had worked.
        form = resolve("from os.path import *\n", 0)
        self.assertEqual(form.kind, "ImportFrom")
        self.assertIsNone(form.display)
        self.assertFalse(form.readable)
        self.assertFalse(form.captured)

    def test_a_star_import_offers_no_names_either(self):
        # The other reader of `_first_bound_name`, which would otherwise
        # report a name called `*` and have the kernel look it up.
        form = resolve("from os.path import *\n", 0)
        self.assertEqual(form.names, ())
        self.assertEqual(form.binds, ())

    def test_for_shows_the_loop_target(self):
        self.assertEqual(resolve("for i in range(3):\n    pass\n", 0).display, "i")

    def test_with_shows_optional_vars_when_present(self):
        self.assertEqual(
            resolve("with open('f') as fh:\n    pass\n", 0).display, "fh")
        self.assertIsNone(
            resolve("with lock:\n    pass\n", 0).display)

    def test_a_with_target_that_is_not_a_name_shows_nothing(self):
        # `with open(p) as obj.fh:` is legal and rare, and reading `obj.fh`
        # back to display it goes through whatever descriptor put it there.
        self.assertIsNone(
            resolve("with open('f') as obj.fh:\n    pass\n", 0).display)
        self.assertIsNone(
            resolve("with open('f') as slots[0]:\n    pass\n", 0).display)

    def test_statements_with_nothing_to_show_resolve_with_no_display(self):
        for src in ("del x\n", "if x:\n    pass\n", "while x:\n    pass\n",
                    "try:\n    pass\nexcept Exception:\n    pass\n"):
            with self.subTest(src=src):
                f = resolve(src, 0)
                self.assertIsNotNone(f, "the statement should still resolve")
                self.assertIsNone(f.display)


class WhereTheValueComesFrom(unittest.TestCase):
    """Writing a target beside a line and evaluating it are different acts.

    Treating them as one is what made `acct.balance = 100` call the user's
    property getter a second time, under the annotation, with nothing on
    screen to say so. `readable` and `captured` are how the resolver keeps
    them apart, and the invariant at the foot of this class is the one that
    cannot be satisfied by remembering: whatever the kernel is allowed to
    evaluate has to be a namespace lookup.
    """

    def test_a_name_is_read_back_out_of_the_namespace(self):
        form = resolve("x = 1\n", 0)
        self.assertTrue(form.readable)
        self.assertFalse(form.captured)

    def test_an_attribute_target_is_captured_rather_than_read(self):
        form = resolve("acct.balance = 100\n", 0)
        # Still labelled with the target, because that is where the value
        # went; the value beside it is the one the statement stored.
        self.assertEqual(form.display, "acct.balance")
        self.assertFalse(form.readable)
        self.assertTrue(form.captured)

    def test_a_subscript_target_is_captured_too(self):
        form = resolve("led['a'] = 1\n", 0)
        self.assertEqual(form.display, "led['a']")
        self.assertFalse(form.readable)
        self.assertTrue(form.captured)

    def test_a_chained_assignment_through_a_place_is_captured(self):
        form = resolve("obj.x = obj.y = compute()\n", 0)
        self.assertFalse(form.readable)
        self.assertTrue(form.captured)

    def test_an_expression_statement_is_never_evaluated_a_second_time(self):
        # The first bug this project found: `y.append(4)` exec'd and then
        # re-evaluated for display appended twice. The kernel evaluates an
        # expression statement once and reports that; nothing may read the
        # display back.
        form = resolve("y.append(4)\n", 0)
        self.assertEqual(form.display, "y.append(4)")
        self.assertFalse(form.readable)
        self.assertFalse(form.captured)

    def test_a_loop_target_is_never_read_back(self):
        # The sequence comes from the recorders in `loops`, which is the only
        # source that is true of every iteration rather than the last.
        for src in ("for i in range(3):\n    pass\n",
                    "for k, v in d.items():\n    pass\n",
                    "for box.item in [1, 2]:\n    pass\n",
                    "for d[next(it)] in [1]:\n    pass\n"):
            with self.subTest(src=src):
                form = resolve(src, 0)
                self.assertFalse(form.readable)
                self.assertFalse(form.captured)

    def test_a_tuple_of_names_is_a_lookup_and_survives(self):
        form = resolve("with cm() as (a, b):\n    pass\n", 0)
        self.assertEqual(form.display, "(a, b)")
        self.assertTrue(form.readable)

    def test_a_starred_pattern_is_not_read_back(self):
        # `(head, *rest)` as an expression iterates `rest` rather than showing
        # it: user code again, and the wrong answer as well.
        self.assertFalse(
            resolve("with cm() as (head, *rest):\n    pass\n", 0).readable)

    def test_a_docstring_is_neither(self):
        form = resolve('"""Module."""\n', 0)
        self.assertIsNone(form.display)
        self.assertFalse(form.readable)
        self.assertFalse(form.captured)

    def test_nothing_readable_is_also_captured(self):
        for src in SHAPES:
            with self.subTest(src=src):
                form = resolve(src, 0)
                self.assertFalse(form.readable and form.captured)

    def test_everything_readable_is_a_namespace_lookup(self):
        # The invariant, over every statement shape the table answers for: a
        # display the kernel may evaluate has to be a bare name or a tuple of
        # them. Anything else -- an attribute, a subscript, a call -- runs the
        # user's code, and an annotation runs nothing the statement did not.
        for src in SHAPES:
            form = resolve(src, 0)
            if not form.readable:
                continue
            with self.subTest(src=src):
                self.assertIsNotNone(form.display)
                self.assertTrue(
                    _only_names_in(form.display),
                    f"{form.display!r} is not a namespace lookup")


#: One of every statement shape the display table has an answer for, plus the
#: shapes that made the safety rule necessary. Written out rather than
#: generated: the point is that a reader can see what is covered.
SHAPES = (
    "x = 1\n",
    "a = b = 1\n",
    "a, b = 1, 2\n",
    "head, *rest = [1, 2, 3, 4]\n",
    "acct.balance = 100\n",
    "led['a'] = 1\n",
    "matrix[i][j] = 0\n",
    "obj.x = obj.y = compute()\n",
    "n: int = 5\n",
    "count: int\n",
    "obj.x: int = 5\n",
    "n += 1\n",
    "counter.n += 1\n",
    "totals['a'] += 1\n",
    "lst\n",
    "y.append(4)\n",
    "(step := 3)\n",
    '"""Module."""\n',
    "def f():\n    pass\n",
    "async def g():\n    pass\n",
    "class C:\n    pass\n",
    "import os.path\n",
    "from x import y as z\n",
    "from x import *\n",
    "for i in range(3):\n    pass\n",
    "for k, v in d.items():\n    pass\n",
    "for box.item in [1, 2]:\n    pass\n",
    "for d[next(it)] in [1]:\n    pass\n",
    "with open('f') as fh:\n    pass\n",
    "with cm() as (a, b):\n    pass\n",
    "with open('f') as obj.fh:\n    pass\n",
    "with lock:\n    pass\n",
    "del x\n",
    "if x:\n    pass\n",
    "while x:\n    pass\n",
    "pass\n",
)


def _only_names_in(display: str) -> bool:
    """Is this display source a bare name, or a tuple or list of them?"""
    node = ast.parse(display, mode="eval").body
    if isinstance(node, ast.Name):
        return True
    if isinstance(node, (ast.Tuple, ast.List)):
        return all(isinstance(element, ast.Name) for element in node.elts)
    return False


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
        self.assertEqual(self.names("shelf['jam'] = 99\n"), ())

    def test_an_unpacking_assign_offers_every_name_it_bound(self):
        # The display slot is empty for these, so nothing is repeated and the
        # bindings are the whole annotation: `d1: {'a': 1}   d2: {'b': 2}`
        # rather than the right-hand side echoed back.
        self.assertEqual(self.names("low, high = 1, 100\n"), ("low", "high"))
        self.assertEqual(self.names("d1, d2 = {'a': 1}, {'b': 2}\n"),
                         ("d1", "d2"))

    def test_a_starred_target_offers_the_name_the_star_bound(self):
        # `rest` holds the list the star collected. Unparsing the target and
        # reading it back gave `(1, 2, 3, 4)` instead, because a starred
        # element in a tuple display re-splats.
        self.assertEqual(self.names("head, *rest = [1, 2, 3, 4]\n"),
                         ("head", "rest"))

    def test_a_nested_pattern_offers_every_leaf_name(self):
        self.assertEqual(self.names("a, (b, c) = 1, (2, 3)\n"),
                         ("a", "b", "c"))
        self.assertEqual(self.names("(a, b), c = (1, 2), 3\n"),
                         ("a", "b", "c"))

    def test_an_unpacking_assign_into_places_offers_only_real_names(self):
        # `obj.a` and `d['k']` bind into something that already exists; `obj`
        # and `d` are reads, and reporting them is what the reader wants.
        self.assertEqual(self.names("obj.a, n = 1, 2\n"), ("n", "obj"))

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

    def test_a_comprehension_target_is_bound_not_read(self):
        # The defect this class of test exists for. `x` here is scoped to the
        # comprehension and never leaves it, so offering it makes the caller
        # read an unrelated module-level `x` and paint it as part of the line.
        self.assertEqual(self.names("squares = [x**2 for x in range(10)]\n"),
                         ("range",))
        self.assertEqual(
            self.names("pairs = [(x, y) for x in range(3) for y in range(2)]\n"),
            ("range",))

    def test_every_comprehension_form_scopes_its_target(self):
        # Four node types, one rule. A set or dict comprehension leaks no more
        # than a list one does, and a generator expression leaks least of all.
        self.assertEqual(self.names("s = {c for c in word}\n"), ("word",))
        self.assertEqual(self.names("m = {k: v for k, v in d.items()}\n"),
                         ("d",))
        self.assertEqual(self.names("g = (n for n in nums)\n"), ("nums",))

    def test_a_comprehension_still_offers_what_it_reads_from_outside(self):
        # Only the loop targets are scoped away. `factor` and `data` are read
        # from the enclosing scope and are the context the line needs.
        self.assertEqual(self.names("out = [x * factor for x in data]\n"),
                         ("factor", "data"))

    def test_nested_comprehensions_shadow_independently(self):
        self.assertEqual(self.names("grid = [[y for y in row] for row in m]\n"),
                         ("m",))

    def test_a_tuple_comprehension_target_binds_every_name_in_it(self):
        self.assertEqual(self.names("keys = [k for k, v in d.items()]\n"),
                         ("d",))
        self.assertEqual(self.names("firsts = [a for a, *b in rows]\n"),
                         ("rows",))

    def test_a_name_read_outside_a_comprehension_survives_the_same_line(self):
        # The scope ends where the comprehension does. A stack rather than one
        # set of excluded names is what keeps the second `x` here reportable.
        self.assertEqual(self.names("t = sum(x for x in xs) + x\n"),
                         ("sum", "xs", "x"))

    def test_a_walrus_in_a_comprehension_really_does_bind_outside_it(self):
        # The exception that proves the body is walked rather than skipped the
        # way a `def` body is: `:=` inside a comprehension binds in the
        # enclosing scope, so `y` exists afterwards and is worth reporting.
        self.assertEqual(self.names("r = [(y := f(a)) for a in items]\n"),
                         ("y", "f", "items"))

    def test_a_deleted_name_is_offered_neither_way(self):
        # It is gone; reading it back would raise where the statement worked.
        self.assertEqual(self.names("del scratch\n"), ())

    def test_an_import_offers_the_names_it_bound(self):
        self.assertEqual(self.names("import os, sys\n"), ("sys",))

    def test_a_docstring_offers_nothing(self):
        self.assertEqual(self.names('"""The module."""\n'), ())


class DefsAndUses(unittest.TestCase):
    """Which names a statement wrote, and which it consulted.

    The same walk as `AnnotatedNames` above, asked the other question. That one
    decides what to *show* beside a line; this one decides which *other*
    annotations an evaluation has just put out of date. Nothing here is ever
    looked up, and nothing here is ever re-run.
    """

    def defs(self, src, line=0):
        return resolve(src, line).binds

    def uses(self, src, line=0):
        return resolve(src, line).reads

    def test_the_two_line_example(self):
        # Evaluate both, edit and re-evaluate the first, and the second is
        # describing a world that no longer exists. This pair is what makes
        # that decidable.
        self.assertEqual(self.defs("x = 1\ny = x + 1\n"), ("x",))
        self.assertEqual(self.uses("x = 1\ny = x + 1\n"), ())
        self.assertEqual(self.defs("x = 1\ny = x + 1\n", 1), ("y",))
        self.assertEqual(self.uses("x = 1\ny = x + 1\n", 1), ("x",))

    def test_a_name_both_bound_and_read_appears_in_both(self):
        # Where the display wants one entry -- `n += 1` has one thing to say
        # about `n` -- this wants both halves: a statement that reads `n` goes
        # out of date when `n` is rebound, whether or not it rebinds it too.
        self.assertEqual(self.defs("x = x + 1\n"), ("x",))
        self.assertEqual(self.uses("x = x + 1\n"), ("x",))
        self.assertEqual(self.defs("n += 1\n"), ("n",))
        self.assertEqual(self.uses("n += 1\n"), ("n",))

    def test_a_definition_binds_its_name_and_reads_nothing_from_its_body(self):
        # The body runs when the function is called, which is a moment this
        # evaluation knows nothing about. `f` is still the same object after
        # `secret` is rebound, so nothing about `f` went out of date.
        self.assertEqual(self.defs("def f():\n    return secret\n"), ("f",))
        self.assertEqual(self.uses("def f():\n    return secret\n"), ())

    def test_a_definition_reads_its_decorators_and_defaults(self):
        # These are evaluated where the `def` is written, so re-running the
        # decorator really does leave the decorated function out of date.
        self.assertEqual(self.uses("@shout\ndef g():\n    return 'ok'\n"),
                         ("shout",))
        self.assertEqual(self.uses("def g(n=limit):\n    return n\n"),
                         ("limit",))
        self.assertEqual(self.uses("def g(n: Size) -> Size:\n    return n\n"),
                         ("Size",))
        self.assertEqual(self.defs("def g(n=limit):\n    return n\n"), ("g",))

    def test_a_class_reads_its_bases_and_not_its_body(self):
        self.assertEqual(self.uses("class C(Base):\n    x = hidden\n"),
                         ("Base",))
        self.assertEqual(self.defs("class C(Base):\n    x = hidden\n"), ("C",))

    def test_a_loop_body_runs_now_and_counts(self):
        # `p` lands in both: the statement introduces it and the body reads it
        # back. That is an over-mark -- re-running something above that also
        # binds `p` will mark this loop, which rebinds `p` itself and did not
        # need marking. Deliberately left in. Telling it apart from `x = x + 1`,
        # where the read genuinely happens before the binding, needs scope and
        # ordering analysis, and the cost of getting this wrong is one extra
        # marker where the cost of the opposite error is the whole feature.
        self.assertEqual(self.defs("for p in xs:\n    total += p\n"),
                         ("p", "total"))
        self.assertEqual(self.uses("for p in xs:\n    total += p\n"),
                         ("xs", "total", "p"))

    def test_an_import_binds_the_name_it_actually_binds(self):
        self.assertEqual(self.defs("import os.path\n"), ("os",))
        self.assertEqual(self.defs("import json as encoder\n"), ("encoder",))
        self.assertEqual(self.defs("from decimal import Decimal\n"),
                         ("Decimal",))

    def test_an_expression_reads_and_binds_nothing(self):
        self.assertEqual(self.defs("print('hi', y)\n"), ())
        self.assertEqual(self.uses("print('hi', y)\n"), ("print", "y"))

    def test_mutation_through_an_alias_is_a_known_miss(self):
        # `y = lst` then `lst.append(4)`: `y` shows something different
        # afterwards and no statement bound `y`, so nothing here can see it.
        #
        # Left as a miss ON PURPOSE. Catching it needs runtime lineage
        # tracking -- nbsafety measured its tracer at a 1.44x median slowdown
        # -- and the output here is only a marker, so a missed mark costs what
        # the tool cost before any of this existed. Do not "fix" this by adding
        # a tracer without a decision ticket: the same limit is why every
        # reactive notebook gets this case wrong, and marimo's own
        # documentation says tracking mutations reliably is impossible in
        # Python.
        self.assertEqual(self.defs("lst.append(4)\n"), ())
        self.assertEqual(self.uses("lst.append(4)\n"), ("lst",))

    def test_a_call_that_rebinds_a_global_is_a_known_miss(self):
        # `bump()`, where `bump` declares `global tally` and increments it.
        # The call site binds nothing as far as a parser can see. Same trade
        # as above, and the same instruction: leave it missed.
        self.assertEqual(self.defs("bump()\n"), ())

    def test_the_display_walk_is_unchanged_by_all_of_this(self):
        # The two questions share a walk, and the display's answers are the
        # ones a user actually sees. Pinned here as well as in AnnotatedNames
        # so a change made for the dependency side cannot quietly move them.
        self.assertEqual(resolve("x = x + 1\n", 0).names, ())
        self.assertEqual(resolve("@shout\ndef g():\n    pass\n", 0).names, ())
        self.assertEqual(resolve("a = a + b\n", 0).names, ("b",))


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


#: A line that does not parse, to put at the bottom of a fixture.
#:
#: An unterminated string rather than a stray bracket, because it is what a
#: half-typed line actually looks like and because it is the one the complaint
#: was filed about.
BROKEN = 's = "half-typed\n'


class CutPoints(unittest.TestCase):
    """Where the file may be cut without splitting a statement in half."""

    def points(self, src: str):
        return cut_points(src.split("\n"))

    def test_a_flush_left_statement_is_a_cut_point(self):
        self.assertEqual(self.points("a = 1\nb = 2\n"), [0, 1])

    def test_an_indented_line_is_not(self):
        # Cutting into a body leaves a `for` or a `def` running fewer
        # statements than the one on the screen, which parses and is not what
        # the user pointed at.
        self.assertEqual(self.points("def f():\n    a = 1\n    b = 2\n"), [0])

    def test_a_clause_continuation_is_not(self):
        # `else:` starts flush left and is the middle of a statement. Cutting
        # there leaves an `if` that parses perfectly and silently drops the
        # branch the reader can see two lines below the cursor.
        for keyword in ("else:", "elif y:", "except E:", "finally:"):
            with self.subTest(keyword=keyword):
                self.assertEqual(
                    self.points(f"if x:\n    a = 1\n{keyword}\n    a = 2\n"),
                    [0])

    def test_a_name_that_merely_starts_with_one_is(self):
        # `\b` rather than `startswith`: `elsewhere = 1` is a statement.
        self.assertIn(1, self.points("a = 1\nelsewhere = 2\n"))

    def test_blank_lines_and_comments_are_not_cut_points(self):
        # Nothing is lost by skipping them: cutting above a comment and
        # cutting below it produce the same tree.
        self.assertEqual(self.points("a = 1\n\n# note\nb = 2\n"), [0, 3])


class ParsePrefix(unittest.TestCase):
    """Answering from as much of the buffer as parses, and saying so."""

    def test_a_file_that_parses_is_not_truncated(self):
        parsed = parse_prefix("a = 1\nb = 2\n")
        self.assertIsNone(parsed.truncated_at)
        self.assertIsNone(parsed.error)
        self.assertEqual(len(parsed.tree.body), 2)

    def test_a_broken_last_line_leaves_the_rest_usable(self):
        parsed = parse_prefix("a = 1\nb = 2\n" + BROKEN)
        self.assertEqual(parsed.truncated_at, 2)
        self.assertEqual(len(parsed.tree.body), 2)

    def test_the_error_that_stopped_it_travels_with_the_tree(self):
        # Reporting the reduced context without the reason for it is the same
        # unhelpfulness one layer up: the user is told something is missing and
        # not what.
        parsed = parse_prefix("a = 1\n" + BROKEN)
        self.assertIsInstance(parsed.error, SyntaxError)
        self.assertEqual(parsed.error.lineno, 2)

    def test_line_numbers_survive_the_truncation(self):
        # The tree is parsed from a prefix and its positions are used against
        # the whole buffer, so a statement must still know where it really is.
        parsed = parse_prefix("a = 1\n\n\nb = 2\n" + BROKEN)
        self.assertEqual(form_at(parsed.tree, 3).start_line, 3)

    def test_nothing_above_the_break_raises_the_original_error(self):
        # There is no reduced context to answer from -- only the error, which
        # is what the user needs to see.
        with self.assertRaises(SyntaxError):
            parse_prefix("def (\na = 1\n")

    def test_a_body_is_never_cut_short(self):
        # The `if` would parse with one statement in it rather than two. That
        # is the failure mode this refuses: an answer to a question nobody
        # asked is worse than no answer.
        parsed = parse_prefix("x = 1\nif True:\n    a = 1\n    b = 2 +\n")
        self.assertEqual(parsed.truncated_at, 1)
        self.assertIsNone(form_at(parsed.tree, 1))

    def test_an_else_branch_is_never_dropped(self):
        # `if True: a = 1` and `if True: a = 1 else: a = 2` are both valid and
        # mean different things. Cutting at the `else:` would answer with the
        # second while the user is looking at the first.
        parsed = parse_prefix(
            "x = 1\nif True:\n    a = 1\nelse:\n    a = 2 +\n")
        self.assertEqual(parsed.truncated_at, 1)
        self.assertIsNone(form_at(parsed.tree, 1))

    def test_a_fragment_of_a_bracketed_chain_is_never_evaluated(self):
        # The negative the whole design turns on. `out = (df.groupby('a')` is
        # not valid on its own, but a fallback that kept shrinking towards the
        # cursor would eventually find something that is -- and would answer
        # with it. Truncating from the end cannot: the cursor is below the cut,
        # so there is nothing to resolve and the caller reports the error.
        source = ("keep = 1\n"
                  "out = (df.groupby('a')\n"
                  "       .agg(sum\n"
                  "       .reset_index())\n")
        parsed = parse_prefix(source)
        self.assertEqual(parsed.truncated_at, 1)
        for line in (1, 2, 3):
            with self.subTest(line=line + 1):
                self.assertIsNone(form_at(parsed.tree, line))


class ANarrowedPrefix(unittest.TestCase):
    """A selection resolved against a file that does not parse whole.

    Two features that never met. The order they compose in is forced rather
    than chosen: `forms_in` snaps a range outward to whole statements, whole
    statements are boundaries in a tree, and for a broken file `parse_prefix`
    is the only thing that produces a tree. So the parse comes first and the
    range is applied inside its result.

    What that buys, and what it costs, are both pinned here. It buys a
    selection that still snaps outward correctly in a broken file. It costs a
    selection below the break its answer -- and that cost is the feature: the
    parsed prefix is sitting right there, plainly runnable, and running it
    would execute lines the user did not select.
    """

    #: 0: docstring  1: a  2-4: def f  5: c  6: "hello"  7: d
    #: 8: the half-typed line, 9-10: below it, and perfectly runnable-looking.
    SOURCE = ('"""doc"""\n'
              "a = 1\n"
              "def f(x):\n"
              "    y = x + 1\n"
              "    return y\n"
              "c = f(1)\n"
              '"hello"\n'
              "d = 2\n"
              + BROKEN
              + "t = 3\n"
                "u = 4\n")

    def setUp(self):
        self.parsed = parse_prefix(self.SOURCE)

    def shown(self, lines):
        return [form.display for form in forms_in(self.parsed.tree, lines)]

    def test_the_prefix_stops_at_the_half_typed_line(self):
        self.assertEqual(self.parsed.truncated_at, 8)

    def test_a_range_above_the_break_resolves_normally(self):
        self.assertEqual(self.shown((1, 1)), ["a"])

    def test_a_range_below_the_break_resolves_to_nothing(self):
        # Not to the prefix, which is the whole point. Eight statements parsed
        # and none of them is what lines 10-11 said.
        self.assertEqual(self.shown((9, 10)), [])

    def test_a_range_starting_exactly_at_the_break_resolves_to_nothing(self):
        # The boundary case, spelled out because off-by-one here means running
        # a statement the selection stopped short of.
        self.assertEqual(self.shown((8, 8)), [])

    def test_a_range_spanning_the_break_takes_what_is_above_it(self):
        self.assertEqual(self.shown((7, 8)), ["d"])

    def test_the_snap_outward_survives_the_truncation(self):
        # Lines 3-4 are inside the body of `f`. The boundaries the snap needs
        # are still there because the range is applied to a tree, not to text.
        self.assertEqual(self.shown((3, 4)), ["f"])
        first = forms_in(self.parsed.tree, (3, 4))[0]
        self.assertEqual((first.start_line, first.end_line), (2, 4))

    def test_first_in_body_is_still_the_modules_own(self):
        # The prefix is still a module, and its body still opens with the real
        # docstring -- so the string on line 6 keeps its value and the one on
        # line 0 stays silent. Deciding this against the selection instead
        # would swallow whichever string a range happened to start on.
        self.assertEqual(self.shown((6, 6)), ["\'hello\'"])
        self.assertEqual(self.shown((0, 0)), [None])

    def test_a_backwards_range_still_resolves_to_nothing(self):
        # A half-stated request in a broken file: two reasons to run nothing,
        # and still no reason to run everything that parsed.
        self.assertEqual(self.shown((0, -1)), [])


class TheJupyterMatrix(unittest.TestCase):
    """The constructs that defeat any evaluation unit blunter than a parse.

    Enumerated in microsoft/vscode-jupyter#1471 by people who shipped a fix
    for the line-based version of this problem, and answered there the same
    way: stop guessing, use the parser. Evalens gets all five right for free
    because `form_at` works on a complete parse -- and this suite exists
    because the syntax-error fallback is a *retreat* from a complete parse, so
    each one is checked again with the file broken underneath it.
    """

    def resolve(self, body: str, line: int):
        parsed = parse_prefix(body + BROKEN)
        self.assertIsNotNone(parsed.truncated_at)
        return form_at(parsed.tree, line)

    def test_a_compound_header_still_resolves_to_the_whole_statement(self):
        for header, body in (("def f(x):", "    return x * 2"),
                             ("class C:", "    x = 1"),
                             ("with open('f') as h:", "    data = h"),
                             ("for i in [1]:", "    j = i"),
                             ("while False:", "    pass"),
                             ("if True:", "    a = 1"),
                             ("try:", "    a = 1\nexcept Exception:\n    a = 2")):
            with self.subTest(header=header):
                form = self.resolve(f"{header}\n{body}\n", 0)
                self.assertIsNotNone(form)
                self.assertEqual(form.start_line, 0)
                self.assertGreater(form.end_line, 0)

    def test_a_backslash_continuation_resolves_from_either_line(self):
        for line in (0, 1):
            with self.subTest(line=line + 1):
                form = self.resolve("x = 1 + \\\n    2\n", line)
                self.assertEqual((form.start_line, form.end_line), (0, 1))

    def test_a_bracketed_chain_resolves_from_any_line_of_it(self):
        source = ("out = (Chain()\n"
                  "       .agg(sum)\n"
                  "       .reset_index())\n")
        for line in (0, 1, 2):
            with self.subTest(line=line + 1):
                form = self.resolve(source, line)
                self.assertEqual((form.start_line, form.end_line), (0, 2))

    def test_a_multi_line_call_resolves_whole(self):
        form = self.resolve("print('hello ' +\n      'world')\n", 1)
        self.assertEqual((form.start_line, form.end_line), (0, 1))

    def test_a_multi_line_dict_literal_resolves_whole(self):
        source = "dtypes = {\n    'a': int,\n    'b': str,\n}\n"
        for line in range(4):
            with self.subTest(line=line + 1):
                form = self.resolve(source, line)
                self.assertEqual(form.display, "dtypes")
                self.assertEqual((form.start_line, form.end_line), (0, 3))


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

    def test_nothing_in_the_tour_is_read_back_but_a_lookup(self):
        # The safety invariant over real source. Every statement the tour has
        # gets asked where its value comes from, and the only displays the
        # kernel is allowed to evaluate are the ones that cannot run
        # anything: a bare name, or a tuple of them.
        for node in self.tree.body:
            form = form_of(node)
            if not form.readable:
                continue
            with self.subTest(line=node.lineno):
                self.assertTrue(
                    _only_names_in(form.display),
                    f"line {node.lineno}: {form.display!r} would be evaluated")

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
