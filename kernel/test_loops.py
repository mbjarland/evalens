"""Tests for the loop rewrite.

In-process, unlike `test_kernel`, and deliberately so: the property that
matters most here is that the rewrite is *additive*, and the only way to state
that is to run the same loop twice -- once instrumented, once not -- and
compare the namespaces the two runs leave behind. That is a comparison of two
executions, which needs both of them in the same interpreter.
"""

import ast
import asyncio
import re
import unittest

import loops


def compiled(node, filename="<test>"):
    return compile(ast.Module(body=[node], type_ignores=[]), filename, "exec")


def fresh_namespace():
    return {"__name__": "__evalens__", "__builtins__": __builtins__}


def visible(namespace):
    """The namespace as a user would see it, by value rather than identity.

    Addresses are normalised out. The two runs being compared build two
    separate sets of objects, so a `repr()` that ends in `at 0x7f…` differs
    between them however faithful the rewrite is -- and a comparison that
    called that a failure could not include a loop binding a function or a
    file, which are exactly the bodies worth checking.
    """
    return {name: re.sub(r"0x[0-9a-fA-F]+", "0x…", repr(value))
            for name, value in namespace.items()
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
            statement, plan = loops.instrument(statement)
            recorders = loops.traces(plan, repr)
        with loops.installed(namespace, recorders):
            exec(compiled(statement), namespace)
    return namespace, recorders


def trace_of(source):
    """The recorded sequence for the loop in `source`."""
    return run(source)[1][0]


def bindings_of(source):
    """What the body of the loop in `source` bound, as it goes on the wire."""
    return trace_of(source).bindings_wire()


def watching(source, expr, loop=-1, watches=None):
    """Run every statement in `source`, nominating `expr` against the
    `loop`-th top-level statement -- #48.

    Mirrors `run`, but only the target statement is rewritten: the loops this
    ticket cares about are always the last (or only) statement in a small
    program, exactly as `trace_of` already assumes, and everything above it
    runs unwatched and uninstrumented so a test can set up an accumulator
    without that setup showing up as a second recorder.

    `watches` overrides the single-expression default when a test needs more
    than one nomination or a nomination that misses every loop on purpose.
    """
    tree = ast.parse(source)
    target = tree.body[loop]
    if watches is None:
        watches = {loops.loop_key(target): [(expr, ast.parse(
            expr, mode="eval").body)]}
    namespace = fresh_namespace()
    recorders = []
    for statement in tree.body:
        if statement is target:
            rewritten, plan, watch_plan = loops.instrument_watching(
                statement, watches)
            recorders = loops.watching_traces(plan, watch_plan, repr)
            statement = rewritten
        with loops.installed(namespace, recorders):
            exec(compiled(statement), namespace)
    return namespace, recorders


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
        # From here down the body *binds*, which is what the second recorder
        # watches. It runs last in the body, so it is the injection that sits
        # in the way of `continue`, `break` and a `raise` -- and the one that
        # reads names, which is where a NameError would come from.
        "for v in [1, 2, 3]:\n    u = 4 * v\n",
        "for v in [1, 2, 3]:\n    if v == 2:\n        continue\n"
        "    u = 4 * v\n",
        "for v in [1, 2, 3]:\n    u = v\n    if v == 2:\n        break\n",
        # `u` does not exist on the first pass, which is exactly the shape that
        # would raise if the recorder were handed the value as an argument.
        "for v in [1, 2, 3]:\n    if v > 1:\n        u = v\n",
        "for v in [1, 2]:\n    u = v\n    del u\n",
        "for v in [1, 2]:\n    with io.StringIO() as sink:\n"
        "        sink.write(str(v))\n",
        "out = []\nfor v in [1, 2]:\n    try:\n        u = 1 / (v - 1)\n"
        "    except ZeroDivisionError as exc:\n        u = None\n"
        "    out.append(u)\n",
        "for v in [1, 2]:\n    def scaled(n=v):\n        return n * 2\n",
        "for v in [1, 2]:\n    squares = [n * n for n in range(v)]\n",
    )

    #: One source above opens a StringIO, and both runs need the name.
    PREAMBLE = "import io\n"

    def test_the_namespace_is_identical_instrumented_or_not(self):
        for source in self.LOOPS:
            with self.subTest(source=source):
                whole = self.PREAMBLE + source
                instrumented, _ = run(whole, instrument=True)
                plain, _ = run(whole, instrument=False)
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
                _, plan = loops.instrument(ast.parse(source).body[0])
                self.assertEqual(plan, [])

    def test_a_target_that_cannot_be_read_back_is_left_alone(self):
        # `for f()[0] in xs:` is legal, and re-evaluating `f()` to display the
        # value would call it a second time. Not instrumenting is the safe
        # answer: the loop annotates its final value as it did before.
        node = ast.parse("for f()[0] in [1, 2]:\n    pass\n").body[0]
        _, plan = loops.instrument(node)
        self.assertEqual(plan, [])

    def test_a_loop_that_never_runs_records_nothing(self):
        trace = trace_of("for p in []:\n    pass\n")
        self.assertEqual(trace.count, 0)
        self.assertIsNone(trace.latest)
        self.assertEqual(trace.wire(), {"values": [], "last": None,
                                        "count": 0})


class WhatTheBodyBinds(unittest.TestCase):
    """The other half of a loop: what each iteration computed.

    The target is usually the input being iterated and the body binding is
    usually the result. Reporting the input's whole history beside the output's
    last value -- in the same style, side by side -- is exactly backwards, and
    is what the second recorder exists to fix.
    """

    def test_a_body_binding_is_recorded_once_per_iteration(self):
        # The ticket's example. stdout said 4, 8 and 12; the annotation said
        # 12, because `u` fell through to the read-the-namespace-once path.
        self.assertEqual(
            bindings_of("for v in [1, 2, 3]:\n    u = 4 * v\n"),
            [{"name": "u", "values": ["4", "8", "12"], "last": None,
              "count": 3}])

    def test_the_recorder_runs_after_the_iteration_computed(self):
        # Last in the body, not first. At the top of the first pass `u` does
        # not exist yet, so a recorder there would find nothing to record --
        # or, if the namespace held one from an earlier run, would report that.
        instrumented, _ = loops.instrument(
            ast.parse("for v in [1, 2]:\n    u = v\n").body[0])
        self.assertEqual(instrumented.body[0].value.func.attr, "record")
        self.assertEqual(instrumented.body[-1].value.func.attr, "bind")

    def test_an_iteration_that_continued_computed_nothing_to_record(self):
        # The sequences are not parallel, and this is the shape that proves
        # it: three iterations, two results. Inventing a third would be the
        # same lie as repeating a mutable object's final state.
        trace = trace_of("for v in [1, 2, 3]:\n    if v == 2:\n"
                         "        continue\n    u = 4 * v\n")
        self.assertEqual(trace.head, ["1", "2", "3"])
        self.assertEqual(trace.bindings_wire(),
                         [{"name": "u", "values": ["4", "12"], "last": None,
                           "count": 2}])

    def test_an_iteration_that_broke_out_leaves_the_same_way(self):
        # `break` is `continue` for this purpose: the iteration left the body
        # before the recorder. The target still records the value it broke on,
        # which is what the first recorder is positioned to catch.
        trace = trace_of("for v in [1, 2, 3]:\n    u = v * 10\n"
                         "    if v == 2:\n        break\n")
        self.assertEqual(trace.head, ["1", "2"])
        self.assertEqual(trace.bindings["u"].head, ["10"])

    def test_a_name_the_first_pass_does_not_bind_does_not_raise(self):
        # The reason the recorder reads the frame rather than being handed
        # values: `u` does not exist on the first iteration, and passing it as
        # an argument would turn an annotation into a NameError in the user's
        # loop.
        namespace, recorders = run(
            "for v in [1, 2, 3]:\n    if v > 1:\n        u = v\n")
        self.assertEqual(namespace["u"], 3)
        self.assertEqual(recorders[0].bindings["u"].head, ["2", "3"])

    def test_a_name_no_iteration_binds_is_left_off_the_wire(self):
        # The loop's own sequence already says what happened. A filter that
        # matched nothing would otherwise answer with a name saying nothing.
        self.assertEqual(
            bindings_of("for v in [1, 2]:\n    if v > 9:\n        u = v\n"),
            [])

    def test_a_value_the_loop_found_is_not_reported_as_its_work(self):
        # A session's namespace is long-lived, so the name may well hold
        # something -- and the scope cannot say who put it there. Reporting
        # `u = 99` from an earlier evaluation as this loop's per-iteration
        # result is exactly the invented observation the rewrite exists to
        # avoid.
        self.assertEqual(
            bindings_of("u = 99\nfor v in [1, 2, 3]:\n"
                        "    if v > 9:\n        u = v\n"),
            [])

    def test_a_name_the_loop_does_rebind_is_reported_from_then_on(self):
        # Once it differs from what the loop found, it is demonstrably this
        # loop's -- including the later iterations that rebind it to the same
        # value, which is what keeps `constant` honest.
        self.assertEqual(
            bindings_of("u = 99\nfor v in [1, 2, 3]:\n    u = 7\n"),
            [{"name": "u", "values": ["7"], "last": None, "count": 3,
              "constant": True}])

    def test_a_binding_that_never_changes_is_reported_once(self):
        # `c: 7, 7, 7, 7` is four observations of one fact, and it crowds out
        # the sequence beside it that is moving.
        self.assertEqual(
            bindings_of("for v in [1, 2, 3, 4]:\n    c = 7\n    d = v * v\n"),
            [{"name": "c", "values": ["7"], "last": None, "count": 4,
              "constant": True},
             {"name": "d", "values": ["1", "4", "9", "16"], "last": None,
              "count": 4}])

    def test_one_iteration_is_not_called_unchanged(self):
        # True but unhelpful: nothing had a chance to change, and a note
        # saying "unchanged" would imply something was watched for longer.
        self.assertEqual(
            bindings_of("for v in [1]:\n    u = v\n"),
            [{"name": "u", "values": ["1"], "last": None, "count": 1}])

    def test_a_binding_is_bounded_exactly_as_the_target_is(self):
        trace = trace_of("for v in range(10000):\n    u = v * 2\n")
        self.assertEqual(
            trace.bindings["u"].wire(),
            {"values": ["0", "2", "4", "6", "8"], "last": "19998",
             "count": 10000})

    def test_a_body_binding_takes_its_repr_at_capture_time(self):
        # The same list rebound every iteration, mutated as it goes. Deferring
        # the repr() would report the final state three times.
        self.assertEqual(
            bindings_of("row = []\nfor v in [1, 2, 3]:\n    row.append(v)\n"
                        "    seen = row\n"),
            [{"name": "seen", "values": ["[1]", "[1, 2]", "[1, 2, 3]"],
              "last": None, "count": 3}])

    def test_the_names_are_capped(self):
        # The same rule the kernel applies to names per line: the annotation
        # shares a line with the code, and the target's sequence is already
        # on it.
        _, plan = loops.instrument(ast.parse(
            "for v in [1]:\n    a = v\n    b = v\n    c = v\n    d = v\n"
            "    e = v\n").body[0])
        self.assertEqual(plan, [("a", "b", "c", "d")[:loops.BINDING_LIMIT]])

    def test_the_target_is_not_reported_a_second_time(self):
        # `for v in xs:` with `v = v * 2` in the body would otherwise put `v`
        # on the line twice, saying two different things.
        self.assertEqual(bindings_of("for v in [1, 2]:\n    v = v * 2\n"), [])

    def test_a_name_only_read_is_not_a_binding(self):
        # Out of scope deliberately: the loop did nothing to it, and a line of
        # every name a body mentions is where this stops being informative.
        self.assertEqual(
            bindings_of("factor = 3\nseen = []\n"
                        "for v in [1, 2]:\n    seen.append(v * factor)\n"),
            [])

    def test_a_nested_loops_bindings_belong_to_the_nested_loop(self):
        # They take a value per inner iteration, so reporting them beside the
        # outer sequence would put two clocks on one line. The outer body's
        # own binding is still reported.
        _, recorders = run(
            "for row in [[1, 2], [3, 4]]:\n    total = 0\n"
            "    for cell in row:\n        doubled = cell * 2\n"
            "        total += doubled\n")
        self.assertEqual(list(recorders[0].bindings), ["total"])
        self.assertEqual(recorders[0].bindings["total"].head, ["6", "14"])
        # `total` is rebound by the inner body too, so the inner recorder
        # watches it as well -- on the inner loop's clock, which is the whole
        # reason the two are not merged.
        self.assertEqual(list(recorders[1].bindings), ["doubled", "total"])
        self.assertEqual(recorders[1].bindings["total"].head,
                         ["2", "6", "6", "14"])

    def test_a_def_in_the_body_is_not_a_binding(self):
        # It binds machinery rather than data, and its repr() carries an
        # address that changes every iteration -- which reads as a value that
        # keeps changing when nothing has.
        self.assertEqual(
            bindings_of("for v in [1, 2]:\n"
                        "    def scaled(n=v):\n        return n * 2\n"),
            [])

    def test_a_comprehension_target_is_not_a_binding(self):
        # It has its own scope and never reaches the namespace, so watching
        # one would spend a capped slot to report nothing.
        self.assertEqual(
            [entry["name"] for entry in bindings_of(
                "for v in [1, 2]:\n"
                "    squares = [n * n for n in range(v)]\n")],
            ["squares"])

    def test_the_else_clause_is_not_a_per_iteration_binding(self):
        # It runs once, after the loop, so the names on the line cover it.
        self.assertEqual(
            bindings_of("for v in [1, 2]:\n    pass\n"
                        "else:\n    done = True\n"),
            [])

    def test_a_loop_with_nothing_to_watch_gets_no_second_injection(self):
        # An empty plan entry means no `bind` call at all, so a loop that
        # binds nothing costs exactly what it did before this existed.
        instrumented, plan = loops.instrument(
            ast.parse("for v in [1, 2]:\n    print(v)\n").body[0])
        self.assertEqual(plan, [()])
        self.assertEqual(len(instrumented.body), 2)


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
        _, plan = loops.instrument(node)
        self.assertEqual(plan, [])

    def test_an_async_for_is_instrumented_the_same_way(self):
        # Unreachable from the cursor today -- `async for` at module level is
        # a syntax error, so the kernel never resolves one as a top-level
        # statement -- and handled anyway, because the rewrite is about the
        # node and not about where it was found.
        tree = ast.parse(
            "async def collect(source):\n"
            "    async for item in source:\n"
            "        doubled = item * 2\n")
        instrumented, plan = loops.instrument(tree.body[0].body[0])
        self.assertEqual(plan, [("doubled",)])

        tree.body[0].body[0] = instrumented
        ast.fix_missing_locations(tree)
        recorders = loops.traces(plan, repr)
        namespace = fresh_namespace()
        with loops.installed(namespace, recorders):
            exec(compiled(tree.body[0]), namespace)
            asyncio.run(namespace["collect"](stream([1, 2, 3])))
        self.assertEqual(recorders[0].head, ["1", "2", "3"])
        # The body recorder reads the frame it was called from, so a loop in a
        # function scope reports its bindings as readily as a module-level one
        # -- there is no globals() lookup here to come up empty.
        self.assertEqual(recorders[0].bindings["doubled"].head,
                         ["2", "4", "6"])


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


def run_comprehension(source, instrument=True, namespace=None):
    """`run`'s counterpart for `instrument_comprehensions`.

    Executes every statement of `source`, and returns the namespace plus the
    `(label, LoopTrace)` pairs of the *last* one, which is the comprehension
    in every test below.
    """
    namespace = fresh_namespace() if namespace is None else namespace
    recorders = []
    for statement in ast.parse(source).body:
        if instrument:
            statement, labels = loops.instrument_comprehensions(statement)
            recorders = loops.comprehension_traces(labels, repr)
        with loops.installed(namespace, [trace for _, trace in recorders]):
            exec(compiled(statement), namespace)
    return namespace, recorders


class Comprehensions(unittest.TestCase):
    """The rewrite #75 makes for a comprehension's `for` clauses.

    A comprehension has no body statement to inject a recorder into -- it
    compiles to its own tiny function built entirely from expressions -- so
    what gets wrapped is each clause's *iterable* instead. See
    `loops.LoopTrace.trace` and `loops._ComprehensionInstrumenter`.
    """

    def test_a_list_comprehension_records_what_its_target_drew(self):
        namespace, recorders = run_comprehension(
            "squares = [x**2 for x in range(10)]\n")
        self.assertEqual(namespace["squares"], [x**2 for x in range(10)])
        self.assertEqual([label for label, _ in recorders], ["x"])
        self.assertEqual(
            recorders[0][1].wire(),
            {"values": ["0", "1", "2", "3", "4"], "last": "9", "count": 10})

    def test_a_filter_records_what_it_iterated_not_what_survived(self):
        # The gap between the two numbers is the filter explaining itself:
        # twenty iterations, ten survivors -- and #75 is explicit that
        # reporting the ten would be the wrong half of the lesson.
        namespace, recorders = run_comprehension(
            "evens = [x for x in range(20) if x % 2 == 0]\n")
        self.assertEqual(namespace["evens"], list(range(0, 20, 2)))
        self.assertEqual(recorders[0][1].count, 20)

    def test_each_for_clause_gets_its_own_recorder(self):
        # The inner clause legitimately repeats -- once per outer iteration --
        # which is itself the lesson about nesting, not a bug to average away.
        _, recorders = run_comprehension(
            "pairs = [(x, y) for x in range(3) for y in range(2)]\n")
        self.assertEqual([label for label, _ in recorders], ["x", "y"])
        self.assertEqual(recorders[0][1].head, ["0", "1", "2"])
        self.assertEqual(recorders[1][1].head, ["0", "1", "0", "1", "0"])
        self.assertEqual(recorders[1][1].count, 6)

    def test_a_tuple_target_records_the_tuple(self):
        # As `for k, v in d.items()` already does for a `for` statement --
        # here for free, because the raw item drawn from the iterable *is*
        # the tuple, before the clause ever unpacks it.
        _, recorders = run_comprehension(
            "ks = [k for k, v in [(1, 'a'), (2, 'b')]]\n")
        self.assertEqual([label for label, _ in recorders], ["(k, v)"])
        self.assertEqual(recorders[0][1].head, ["(1, 'a')", "(2, 'b')"])

    def test_a_nested_comprehension_records_both_targets(self):
        _, recorders = run_comprehension(
            "out = [[y for y in row] for row in [[1, 2], [3, 4]]]\n")
        self.assertEqual([label for label, _ in recorders], ["row", "y"])
        self.assertEqual(recorders[0][1].head, ["[1, 2]", "[3, 4]"])
        self.assertEqual(recorders[1][1].head, ["1", "2", "3", "4"])

    def test_a_dict_comprehension_is_instrumented(self):
        namespace, recorders = run_comprehension(
            "d = {k: v for k, v in [(1, 'a'), (2, 'b')]}\n")
        self.assertEqual(namespace["d"], {1: "a", 2: "b"})
        self.assertEqual([label for label, _ in recorders], ["(k, v)"])

    def test_a_set_comprehension_is_instrumented(self):
        namespace, recorders = run_comprehension("s = {x for x in range(5)}\n")
        self.assertEqual(namespace["s"], {0, 1, 2, 3, 4})
        self.assertEqual([label for label, _ in recorders], ["x"])

    def test_a_generator_expression_is_left_untouched(self):
        # #75 is explicit: forcing it to find out what it would draw is
        # exactly the consumption an annotation may never cause.
        _, plan = loops.instrument_comprehensions(
            ast.parse("g = (x for x in range(5))\n").body[0])
        self.assertEqual(plan, [])

    def test_a_generator_expression_is_not_consumed(self):
        namespace, recorders = run_comprehension(
            "g = (x for x in range(5))\n")
        self.assertEqual(recorders, [])
        self.assertEqual(next(namespace["g"]), 0, "still lazy, still whole")
        self.assertEqual(next(namespace["g"]), 1)

    def test_a_comprehension_nested_in_a_generator_is_also_left_alone(self):
        # Instrumenting what is inside a generator expression on the chance it
        # turns out to be consumed synchronously is the same hazard one level
        # removed -- left untouched, root to leaves.
        _, plan = loops.instrument_comprehensions(ast.parse(
            "g = (sum(y for y in row) for row in grid)\n").body[0])
        self.assertEqual(plan, [])

    def test_a_list_comprehension_beside_a_consumed_generator_is_still_found(self):
        # The generator expression `sum` consumes immediately is left alone on
        # the rule above; a list comprehension elsewhere on the same line is a
        # different construct and is instrumented regardless.
        _, recorders = run_comprehension(
            "total = sum(x for x in range(5)) + len([y for y in range(3)])\n")
        self.assertEqual([label for label, _ in recorders], ["y"])

    def test_a_comprehension_inside_a_nested_def_is_left_alone(self):
        # It runs when the function is called, which may be long after this
        # evaluation finished and the recorders were uninstalled.
        namespace, recorders = run_comprehension(
            "def f():\n    return [x * x for x in range(3)]\n")
        self.assertEqual(recorders, [])
        self.assertEqual(namespace["f"](), [0, 1, 4])

    def test_a_comprehension_inside_a_lambda_is_left_alone(self):
        namespace, recorders = run_comprehension(
            "f = lambda: [x * x for x in range(3)]\n")
        self.assertEqual(recorders, [])
        self.assertEqual(namespace["f"](), [0, 1, 4])

    def test_a_comprehension_in_a_default_argument_is_also_left_alone(self):
        # A default value genuinely runs now, where the `def` is written, and
        # is still missed: the class docstring above states the trade-off --
        # nothing else in this module opens one argument of a `def` while
        # leaving its body closed, and this rewrite does not start.
        _, recorders = run_comprehension(
            "def f(x=[n * n for n in range(3)]):\n    return x\n")
        self.assertEqual(recorders, [])

    def test_an_async_clause_is_left_untouched(self):
        # Unreachable from the cursor today -- an `async for` comprehension
        # clause only appears inside an `async def`, a scope this rewrite
        # already declines to enter -- and guarded anyway: wrapping one would
        # call `trace`'s ordinary `__iter__` machinery against an iterable
        # that only offers `__aiter__`, breaking the clause outright rather
        # than merely leaving it untraced.
        tree = ast.parse(
            "async def collect(source):\n"
            "    return [x async for x in source]\n")
        listcomp = tree.body[0].body[0].value
        _, plan = loops.instrument_comprehensions(listcomp)
        self.assertEqual(plan, [])

    def test_the_rewrite_is_transparent(self):
        # Mirrors `Additive`: the rewrite must change nothing about the
        # namespace a statement leaves behind.
        sources = (
            "squares = [x**2 for x in range(10)]\n",
            "evens = [x for x in range(20) if x % 2 == 0]\n",
            "pairs = [(x, y) for x in range(3) for y in range(2)]\n",
            "out = [[y for y in row] for row in [[1, 2], [3, 4]]]\n",
            "d = {k: v for k, v in [(1, 'a'), (2, 'b')]}\n",
            "s = {x for x in range(5)}\n",
            "ks = [k for k, v in [(1, 'a'), (2, 'b')]]\n",
        )
        for source in sources:
            with self.subTest(source=source):
                plain, _ = run_comprehension(source, instrument=False)
                traced, _ = run_comprehension(source, instrument=True)
                self.assertEqual(visible(plain), visible(traced))


class ComprehensionPositions(unittest.TestCase):
    def test_every_synthesised_node_carries_a_position(self):
        instrumented, _ = loops.instrument_comprehensions(
            ast.parse("squares = [x**2 for x in range(10)]\n").body[0])
        for node in ast.walk(instrumented):
            if isinstance(node, (ast.stmt, ast.expr)):
                self.assertIsInstance(getattr(node, "lineno", None), int,
                                      ast.dump(node))

    def test_the_iterables_own_position_is_not_overwritten(self):
        # `_trace_call` wraps the iterable rather than rebuilding it, so a
        # traceback through it has to keep quoting the clause's own line, not
        # the line of the statement that happens to contain it.
        source = "squares = [\n    x**2\n    for x in range(10)\n]\n"
        original = ast.parse(source).body[0]
        instrumented, _ = loops.instrument_comprehensions(original)
        original_iter = original.value.generators[0].iter
        wrapped_call = instrumented.value.generators[0].iter
        self.assertEqual(wrapped_call.args[0].lineno, original_iter.lineno)


class NominatedWatches(unittest.TestCase):
    """`instrument_watching`, `LoopTrace.watches` and `LoopTrace.fail` --
    #48's mechanism for a reader-chosen expression, captured the same way
    the target and the body's own bindings already are: once per iteration,
    as it happens, never re-read afterwards.
    """

    def test_a_watch_on_the_target_is_recorded_once_per_iteration(self):
        _, recorders = watching("for p in [0, 1, 4, 9, 16]:\n    pass\n",
                                "p+6")
        self.assertEqual(
            recorders[0].watches["p+6"].wire(),
            {"values": ["6", "7", "10", "15", "22"], "last": None,
             "count": 5})

    def test_a_watch_may_read_what_the_body_just_bound(self):
        # The accumulator #48 was filed over: `total` is only meaningful
        # after `total += x` has run, which is why `_watch_call` is appended
        # after `bind()` rather than before it.
        _, recorders = watching(
            "total = 0\nfor x in [1, 2, 3, 4]:\n    total += x\n",
            "total", loop=1)
        self.assertEqual(recorders[0].watches["total"].head,
                         ["1", "3", "6", "10"])

    def test_repr_is_taken_at_capture_time_like_every_other_trace(self):
        # Unlike the target -- recorded as the iteration *begins*, before
        # the body runs -- a watch fires last, after `r.append` has already
        # mutated `row` for this pass. `["[]", "[0]", "[0, 1]"]` is the
        # target's own sequence (see `WhatIsRecorded`); the watch's is one
        # append ahead of it at every step, which is the honest answer for
        # a value the body just changed.
        _, recorders = watching(
            "row = []\nfor r in [row, row, row]:\n    r.append(len(r))\n",
            "row", loop=1)
        self.assertEqual(recorders[0].watches["row"].head,
                         ["[0]", "[0, 1]", "[0, 1, 2]"])

    def test_a_raising_watch_is_recorded_once_and_the_loop_completes(self):
        namespace, recorders = watching(
            "for p in [1, 0, 2, 0, 3]:\n    pass\n", "1/p")
        trace = recorders[0].watches["1/p"]
        self.assertEqual(trace.head, ["1.0", "0.5", "0.3333333333333333"])
        self.assertEqual(trace.error,
                         {"type": "ZeroDivisionError",
                          "message": "division by zero"})
        # One more zero after the one that set `error`.
        self.assertEqual(trace.failed, 1)
        # The loop itself -- and its own target trace -- are untouched by a
        # watch that raised: this is #48's whole point.
        self.assertEqual(namespace["p"], 3)
        self.assertEqual(recorders[0].count, 5)

    def test_only_the_first_exception_is_kept(self):
        _, recorders = watching("for p in [0, 0, 0]:\n    pass\n", "1/p")
        trace = recorders[0].watches["1/p"]
        self.assertEqual(trace.count, 0)
        self.assertEqual(trace.head, [])
        self.assertEqual(trace.error["type"], "ZeroDivisionError")
        self.assertEqual(trace.failed, 2)

    def test_a_watch_that_always_raises_still_reports_on_the_wire(self):
        # Unlike a binding nobody bound: the user asked for this expression
        # by name, and a complete failure is itself the answer, not nothing.
        _, recorders = watching("for p in [0, 0]:\n    pass\n", "1/p")
        [wire] = recorders[0].watches_wire()
        self.assertEqual(wire["name"], "1/p")
        self.assertEqual(wire["values"], [])
        self.assertEqual(wire["count"], 0)
        self.assertEqual(wire["error"]["type"], "ZeroDivisionError")
        self.assertEqual(wire["failed"], 1)

    def test_a_watch_never_advances_the_loops_own_count(self):
        # `fail` must not make a raising watch look like it kept pace with
        # the loop: `count` on the watch's own trace is successes only, on
        # the same "not parallel" terms a `continue`d binding already gets.
        _, recorders = watching("for p in [1, 0, 2]:\n    pass\n", "1/p")
        self.assertEqual(recorders[0].watches["1/p"].count, 2)
        self.assertEqual(recorders[0].count, 3)

    def test_the_watch_exception_name_does_not_survive_the_run(self):
        namespace, _ = watching("for p in [1, 0]:\n    pass\n", "1/p")
        self.assertNotIn(loops.WATCH_EXC, namespace)

    def test_the_rewrite_stays_additive_with_a_watch_attached(self):
        source = "total = 0\nfor x in [1, 2, 3]:\n    total += x\n"
        plain, _ = run(source, instrument=False)
        watched, _ = watching(source, "total", loop=1)
        self.assertEqual(visible(plain), visible(watched))

    def test_a_watch_is_filed_under_its_own_loops_key_when_nested(self):
        # `evaluate_watch` resolves the *innermost* enclosing loop by
        # position before this rewrite ever runs, so the watch must land on
        # the inner loop's own trace, not the outer loop's.
        outer = ast.parse(
            "for i in range(2):\n    for j in range(3):\n        pass\n"
        ).body[0]
        inner = outer.body[0]
        expr = ast.parse("i * 10 + j", mode="eval").body
        rewritten, plan, watch_plan = loops.instrument_watching(
            outer, {loops.loop_key(inner): [("i * 10 + j", expr)]})
        recorders = loops.watching_traces(plan, watch_plan, repr)
        namespace = fresh_namespace()
        with loops.installed(namespace, recorders):
            exec(compiled(rewritten), namespace)
        self.assertEqual(len(recorders), 2)
        self.assertEqual(recorders[0].watches, {})
        self.assertIn("i * 10 + j", recorders[1].watches)
        self.assertEqual(recorders[1].watches["i * 10 + j"].head,
                         ["0", "1", "2", "10", "11"])

    def test_a_key_matching_no_loop_attaches_nothing(self):
        # Not expected in practice -- `evaluate_watch` resolves the key from
        # the same tree it instruments -- but declining is the safe answer
        # to a key that does not match, on the rule every other unrecognised
        # shape in this module already follows.
        node = ast.parse("for p in [1, 2]:\n    pass\n").body[0]
        bogus_key = (999, 0, 999, 4)
        expr = ast.parse("p", mode="eval").body
        _, plan, watch_plan = loops.instrument_watching(
            node, {bogus_key: [("p", expr)]})
        self.assertEqual(watch_plan, [()])
        recorders = loops.watching_traces(plan, watch_plan, repr)
        self.assertEqual(recorders[0].watches, {})

    def test_instrument_without_watches_is_unaffected(self):
        # `instrument` (no watches) and `instrument_watching` (empty
        # watches) must produce the same rewrite: #48 is additive to the
        # existing feature, never a second code path for it.
        node = ast.parse("for p in [1, 2]:\n    pass\n").body[0]
        plain, plan = loops.instrument(node)
        watched, plan2, watch_plan = loops.instrument_watching(node, {})
        self.assertEqual(ast.dump(plain), ast.dump(watched))
        self.assertEqual(plan, plan2)
        self.assertEqual(watch_plan, [()])


class InnermostLoopAt(unittest.TestCase):
    """`loops.innermost_loop_at` -- where a nominated expression's position
    resolves to the loop #48 attaches its watch to."""

    def test_an_unnested_position_resolves_to_the_loop_itself(self):
        node = ast.parse("for p in [1]:\n    pass\n").body[0]
        self.assertIs(loops.innermost_loop_at(node, 1, 4), node)

    def test_a_position_on_the_header_also_resolves_to_the_loop(self):
        node = ast.parse("for p in [1]:\n    pass\n").body[0]
        self.assertIs(loops.innermost_loop_at(node, 0, 5), node)

    def test_a_nested_position_resolves_to_the_inner_loop(self):
        node = ast.parse(
            "for i in range(2):\n    for j in range(3):\n        pass\n"
        ).body[0]
        inner = node.body[0]
        self.assertIs(loops.innermost_loop_at(node, 2, 8), inner)

    def test_a_position_on_the_outer_header_stays_the_outer_loop(self):
        node = ast.parse(
            "for i in range(2):\n    for j in range(3):\n        pass\n"
        ).body[0]
        self.assertIs(loops.innermost_loop_at(node, 0, 5), node)

    def test_a_position_after_the_nested_loop_is_the_outer_loop(self):
        node = ast.parse(
            "for i in range(2):\n    for j in range(3):\n        pass\n"
            "    total = i\n"
        ).body[0]
        self.assertIs(loops.innermost_loop_at(node, 3, 4), node)

    def test_a_position_outside_the_loop_entirely_is_none(self):
        node = ast.parse("for p in [1]:\n    pass\n").body[0]
        self.assertIsNone(loops.innermost_loop_at(node, 10, 0))

    def test_a_while_loop_is_never_a_candidate(self):
        # #48 is scoped to `for`/`async for`, matching every other rewrite in
        # this module; a `while` is never instrumented at all.
        node = ast.parse("while True:\n    break\n").body[0]
        self.assertIsNone(loops.innermost_loop_at(node, 0, 0))

    def test_an_async_for_is_a_candidate(self):
        node = ast.parse(
            "async def f():\n    async for p in xs:\n        pass\n"
        ).body[0]
        async_for = node.body[0]
        self.assertIs(loops.innermost_loop_at(node, 1, 10), async_for)


if __name__ == "__main__":
    unittest.main()
