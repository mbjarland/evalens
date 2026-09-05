"""Tests for the loop rewrite.

In-process, unlike `test_kernel`, and deliberately so: the property that
matters most here is that the rewrite is *additive*, and the only way to state
that is to run the same loop twice -- once instrumented, once not -- and
compare the namespaces the two runs leave behind. That is a comparison of two
executions, which needs both of them in the same interpreter.
"""

import ast
import asyncio
import unittest

import loops


def compiled(node, filename="<test>"):
    return compile(ast.Module(body=[node], type_ignores=[]), filename, "exec")


def fresh_namespace():
    return {"__name__": "__evalens__", "__builtins__": __builtins__}


def visible(namespace):
    """The namespace as a user would see it, by value rather than identity."""
    return {name: repr(value) for name, value in namespace.items()
            if name not in ("__name__", "__builtins__")}


def run(source, instrument=True, namespace=None):
    """Execute `source`, instrumenting every statement, and report both sides.

    Returns the namespace and the recorders of the *last* statement, which is
    the loop in every test below.
    """
    namespace = fresh_namespace() if namespace is None else namespace
    recorders = []
    for statement in ast.parse(source).body:
        if instrument:
            statement, count = loops.instrument(statement)
            recorders = loops.traces(count, repr)
        with loops.installed(namespace, recorders):
            exec(compiled(statement), namespace)
    return namespace, recorders


def trace_of(source):
    """The recorded sequence for the loop in `source`."""
    return run(source)[1][0]


async def stream(values):
    for value in values:
        yield value


class Additive(unittest.TestCase):
    """The rewrite inserts statements and changes nothing else.

    This is the claim that makes instrumenting the user's code acceptable at
    all. It is not self-evident: an injected call evaluates the target, which
    can invoke `__getattr__`, and it lands where `continue` and `break` change
    the flow around it.
    """

    LOOPS = (
        "total = 0\nfor p in [1, 2, 3, 4]:\n    total += p\n",
        "seen = []\nfor p in range(5):\n    if p == 2:\n        continue\n"
        "    seen.append(p)\n",
        "found = None\nfor p in [1, 2, 3]:\n    found = p\n"
        "    if p == 2:\n        break\n",
        "pairs = []\nfor k, v in {'a': 1, 'b': 2}.items():\n"
        "    pairs.append(k)\n",
        "hit = False\nfor p in []:\n    hit = True\nelse:\n    done = True\n",
        "grid = []\nfor row in [[1, 2], [3, 4]]:\n    for cell in row:\n"
        "        grid.append(cell)\n",
        "rows = [[], []]\nfor r in rows:\n    r.append(len(r))\n",
        "acc = []\nfor p in (n for n in range(3)):\n    acc.append(p * 2)\n",
    )

    def test_the_namespace_is_identical_instrumented_or_not(self):
        for source in self.LOOPS:
            with self.subTest(source=source):
                instrumented, _ = run(source, instrument=True)
                plain, _ = run(source, instrument=False)
                self.assertEqual(visible(instrumented), visible(plain))

    def test_the_recorder_name_does_not_survive_the_run(self):
        # Otherwise the comparison above is false by one binding, and the
        # user's `dir()` grows a name they did not write.
        namespace, _ = run("for p in [1, 2]:\n    pass\n")
        self.assertNotIn(loops.RECORDERS, namespace)

    def test_a_users_own_binding_of_the_recorder_name_is_put_back(self):
        # Unlikely. Silently destroying a variable is not a good way to find
        # out how unlikely.
        namespace = fresh_namespace()
        namespace[loops.RECORDERS] = "mine"
        run("for p in [1, 2]:\n    pass\n", namespace=namespace)
        self.assertEqual(namespace[loops.RECORDERS], "mine")

    def test_the_original_tree_is_left_alone(self):
        # The caller still holds the user's parsed tree and reads positions
        # off it; a transformer that mutates its input also turns "evaluate
        # this twice" into "instrument it twice".
        original = ast.parse("for p in [1, 2]:\n    pass\n").body[0]
        before = ast.dump(original)
        loops.instrument(original)
        self.assertEqual(ast.dump(original), before)


class WhatIsRecorded(unittest.TestCase):
    def test_every_iteration_is_recorded_in_order(self):
        trace = trace_of("for p in [1, 2, 3, 4]:\n    pass\n")
        self.assertEqual(trace.head, ["1", "2", "3", "4"])
        self.assertEqual(trace.count, 4)
        self.assertIsNone(trace.last)
        self.assertEqual(trace.latest, "4")

    def test_repr_is_taken_as_the_iteration_begins(self):
        # The same list three times, mutated by the body. Deferring the
        # repr() to the end would report [0, 1, 2] three times -- worse than
        # showing one value, because it reads as three observations of
        # nothing changing.
        trace = trace_of(
            "row = []\nfor r in [row, row, row]:\n    r.append(len(r))\n")
        self.assertEqual(trace.head, ["[]", "[0]", "[0, 1]"])

    def test_break_records_the_value_it_broke_on(self):
        # The value the loop stopped at is the reason it stopped, and so the
        # one the reader is looking for. Recording at the bottom of the body
        # would drop exactly it.
        trace = trace_of(
            "for p in [1, 2, 3, 4]:\n    if p == 3:\n        break\n")
        self.assertEqual(trace.head, ["1", "2", "3"])

    def test_continue_still_records_its_iteration(self):
        trace = trace_of(
            "for p in [1, 2, 3]:\n    if p == 2:\n        continue\n")
        self.assertEqual(trace.head, ["1", "2", "3"])

    def test_a_tuple_target_records_the_tuple(self):
        trace = trace_of(
            "for k, v in {'a': 1, 'b': 2}.items():\n    pass\n")
        self.assertEqual(trace.head, ["('a', 1)", "('b', 2)"])

    def test_a_starred_target_records_the_list_the_star_binds(self):
        # `(a, *b)` as an *expression* unpacks b, so reusing the target node
        # would report (1, 2, 3) for a loop that bound a=1, b=[2, 3].
        trace = trace_of("for a, *b in [[1, 2, 3]]:\n    pass\n")
        self.assertEqual(trace.head, ["(1, [2, 3])"])

    def test_an_attribute_target_is_recorded(self):
        trace = trace_of(
            "class Box:\n    pass\n"
            "box = Box()\n"
            "for box.item in [1, 2]:\n    pass\n")
        self.assertEqual(trace.head, ["1", "2"])

    def test_a_subscript_target_is_recorded(self):
        trace = trace_of("slot = [None]\nfor slot[0] in [7, 8]:\n    pass\n")
        self.assertEqual(trace.head, ["7", "8"])

    def test_a_target_indexed_by_something_that_moves_is_left_alone(self):
        # `for d[next(it)] in xs:` would otherwise advance the iterator once
        # to assign and once to read the value back.
        for source in ("for d[next(it)] in [1]:\n    pass\n",
                       "for d[i + 1] in [1]:\n    pass\n"):
            with self.subTest(source=source):
                _, count = loops.instrument(ast.parse(source).body[0])
                self.assertEqual(count, 0)

    def test_a_target_that_cannot_be_read_back_is_left_alone(self):
        # `for f()[0] in xs:` is legal, and re-evaluating `f()` to display the
        # value would call it a second time. Not instrumenting is the safe
        # answer: the loop annotates its final value as it did before.
        node = ast.parse("for f()[0] in [1, 2]:\n    pass\n").body[0]
        _, count = loops.instrument(node)
        self.assertEqual(count, 0)

    def test_a_loop_that_never_runs_records_nothing(self):
        trace = trace_of("for p in []:\n    pass\n")
        self.assertEqual(trace.count, 0)
        self.assertIsNone(trace.latest)
        self.assertEqual(trace.wire(), {"values": [], "last": None,
                                        "count": 0})


class Bounded(unittest.TestCase):
    def test_a_long_loop_keeps_the_head_the_last_and_a_count(self):
        trace = trace_of("for p in range(10000):\n    pass\n")
        self.assertEqual(trace.head, ["0", "1", "2", "3", "4"])
        self.assertEqual(trace.last, "9999")
        self.assertEqual(trace.count, 10000)

    def test_nothing_accumulates(self):
        # A loop over a million rows must not build a million strings. The
        # recorder holds the head plus one, whatever the loop does.
        trace = loops.LoopTrace(repr)
        for value in range(1000000):
            trace.record(value)
        self.assertEqual(len(trace.head), loops.HEAD_LIMIT)
        self.assertEqual(trace.last, "999999")
        self.assertEqual(trace.count, 1000000)

    def test_the_wire_shape_is_what_the_extension_renders_from(self):
        trace = trace_of("for p in range(10):\n    pass\n")
        self.assertEqual(
            trace.wire(),
            {"values": ["0", "1", "2", "3", "4"], "last": "9", "count": 10})


class Scope(unittest.TestCase):
    def test_nested_loops_get_separate_recorders(self):
        namespace, recorders = run(
            "for row in [[1, 2], [3, 4]]:\n"
            "    for cell in row:\n        pass\n")
        self.assertEqual(len(recorders), 2)
        self.assertEqual(recorders[0].head, ["[1, 2]", "[3, 4]"])
        self.assertEqual(recorders[1].head, ["1", "2", "3", "4"])

    def test_the_outer_loop_is_recorder_zero_however_deep_the_nesting(self):
        # The statement the user pointed at is the one reported, so its
        # recorder is allocated before the rewrite descends into the body.
        _, recorders = run(
            "for a in [[[1]]]:\n    for b in a:\n        for c in b:\n"
            "            pass\n")
        self.assertEqual(recorders[0].head, ["[[1]]"])

    def test_an_inner_loop_reusing_the_name_leaves_the_outer_intact(self):
        # Recorders are keyed by loop, not by target name. Keying by name is
        # the obvious implementation and interleaves these two into one
        # nonsensical sequence.
        _, recorders = run(
            "for p in [[1, 2], [3, 4]]:\n    for p in p:\n        pass\n")
        self.assertEqual(recorders[0].head, ["[1, 2]", "[3, 4]"])
        self.assertEqual(recorders[1].head, ["1", "2", "3", "4"])

    def test_a_loop_inside_a_nested_def_is_left_alone(self):
        # It runs when the function is called, which may be long after this
        # evaluation finished and the recorders were uninstalled -- so
        # instrumenting it would plant a NameError in the user's function.
        namespace, recorders = run(
            "made = []\n"
            "for i in [1, 2]:\n"
            "    def make(n=i):\n"
            "        out = []\n"
            "        for j in range(n):\n"
            "            out.append(j)\n"
            "        return out\n"
            "    made.append(make)\n")
        self.assertEqual(len(recorders), 1, "the inner loop is not ours")
        # Called after the recorders are gone, which is the point.
        self.assertEqual([f() for f in namespace["made"]], [[0], [0, 1]])

    def test_a_comprehension_is_not_a_for_statement(self):
        # Comprehensions are expressions and out of scope; nothing in the
        # rewrite should mistake one for a loop.
        node = ast.parse("squares = [n * n for n in range(4)]\n").body[0]
        _, count = loops.instrument(node)
        self.assertEqual(count, 0)

    def test_an_async_for_is_instrumented_the_same_way(self):
        # Unreachable from the cursor today -- `async for` at module level is
        # a syntax error, so the kernel never resolves one as a top-level
        # statement -- and handled anyway, because the rewrite is about the
        # node and not about where it was found.
        tree = ast.parse(
            "async def collect(source):\n"
            "    async for item in source:\n"
            "        pass\n")
        instrumented, count = loops.instrument(tree.body[0].body[0])
        self.assertEqual(count, 1)

        tree.body[0].body[0] = instrumented
        ast.fix_missing_locations(tree)
        recorders = loops.traces(count, repr)
        namespace = fresh_namespace()
        with loops.installed(namespace, recorders):
            exec(compiled(tree.body[0]), namespace)
            asyncio.run(namespace["collect"](stream([1, 2, 3])))
        self.assertEqual(recorders[0].head, ["1", "2", "3"])


class Positions(unittest.TestCase):
    def test_every_synthesised_node_carries_a_position(self):
        # A node without one is a hard compile error, and one carrying a
        # plausible but wrong line puts a line the user never wrote into the
        # middle of their traceback.
        instrumented, _ = loops.instrument(
            ast.parse("for p in [1, 2]:\n    pass\n").body[0])
        for node in ast.walk(instrumented):
            if isinstance(node, (ast.stmt, ast.expr)):
                self.assertIsInstance(getattr(node, "lineno", None), int,
                                      ast.dump(node))

    def test_the_injected_call_reports_the_loops_own_line(self):
        source = "x = 0\nfor p in [1, 2]:\n    x += p\n"
        loop = ast.parse(source).body[1]
        instrumented, _ = loops.instrument(loop)
        self.assertEqual(instrumented.body[0].lineno, loop.lineno)

    def test_the_body_keeps_its_own_lines(self):
        # The injected statement must not renumber what follows it, or a
        # traceback from inside the body quotes the wrong source.
        source = "for p in [1, 2]:\n    raise ValueError(p)\n"
        instrumented, _ = loops.instrument(ast.parse(source).body[0])
        self.assertEqual(instrumented.body[1].lineno, 2)


if __name__ == "__main__":
    unittest.main()
