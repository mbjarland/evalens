"""Tests for the kernel, driven as a real subprocess over real pipes.

These deliberately do not import the kernel and call its functions. Almost
every failure mode worth catching here is a property of the *process* -- that
stdout stays a clean protocol channel, that a request cannot be eaten by
`input()`, that an exception leaves a usable namespace behind -- and none of
those are observable in-process.
"""

import json
import os
import re
import subprocess
import sys
import unittest

KERNEL = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                      "evalens_kernel.py")


class KernelProcess:
    """A running kernel, spoken to one JSON line at a time."""

    def __init__(self):
        self.proc = subprocess.Popen(
            [sys.executable, KERNEL],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True, bufsize=1,
        )
        self._id = 0

    def send(self, **request):
        self._id += 1
        request.setdefault("id", self._id)
        self.proc.stdin.write(json.dumps(request) + "\n")
        self.proc.stdin.flush()
        line = self.proc.stdout.readline()
        if not line:
            raise AssertionError(
                f"kernel died; stderr:\n{self.proc.stderr.read()}")
        return json.loads(line)

    def send_raw(self, text):
        self.proc.stdin.write(text + "\n")
        self.proc.stdin.flush()
        return json.loads(self.proc.stdout.readline())

    def evaluate(self, source, line, **extra):
        return self.send(op="eval", source=source, line=line, **extra)

    def evaluate_lines(self, source, *lines, **extra):
        """Evaluate several lines in order, returning the last response.

        Line 40 needs lines 1-39 to have run; a test that skips them gets a
        NameError, which is the ordering property working rather than a bug.
        """
        result = None
        for line in lines:
            result = self.evaluate(source, line, **extra)
        return result

    def close(self):
        try:
            self.proc.stdin.close()
            self.proc.wait(timeout=5)
        except Exception:
            self.proc.kill()
            self.proc.wait(timeout=5)
        finally:
            for stream in (self.proc.stdout, self.proc.stderr):
                if stream is not None and not stream.closed:
                    stream.close()


class KernelTest(unittest.TestCase):
    def setUp(self):
        self.k = KernelProcess()
        self.addCleanup(self.k.close)


class Persistence(KernelTest):
    def test_state_survives_across_requests(self):
        src = "a = 21\nb = a * 2\nb\n"
        self.k.evaluate(src, 0)
        self.k.evaluate(src, 1)
        self.assertEqual(self.k.evaluate(src, 2)["value"], "42")

    def test_reset_clears_the_namespace(self):
        src = "a = 1\na\n"
        self.k.evaluate(src, 0)
        self.assertEqual(self.k.evaluate(src, 1)["value"], "1")
        self.assertTrue(self.k.send(op="reset")["ok"])
        after = self.k.evaluate(src, 1)
        self.assertFalse(after["ok"])
        self.assertEqual(after["error"]["type"], "NameError")

    def test_the_idea_document_example_reproduces(self):
        src = "lst = [1, 2, 3]\ny = lst\ny.append(4)\nlst\n"
        self.assertEqual(self.k.evaluate(src, 0)["value"], "[1, 2, 3]")
        self.assertEqual(self.k.evaluate(src, 1)["value"], "[1, 2, 3]")
        self.k.evaluate(src, 2)
        self.assertEqual(self.k.evaluate(src, 3)["value"], "[1, 2, 3, 4]")


class SideEffects(KernelTest):
    def test_an_expression_statement_runs_exactly_once(self):
        # The trap this guards: exec the statement, then evaluate the display
        # expression, and `xs.append(1)` has appended twice. Caught by hand
        # against the IDEA.md example, which read [1, 2, 3, 4, 4].
        src = "xs = []\nxs.append(1)\nxs\n"
        self.k.evaluate(src, 0)
        self.k.evaluate(src, 1)
        self.assertEqual(self.k.evaluate(src, 2)["value"], "[1]")

    def test_a_call_with_a_side_effect_fires_once(self):
        src = "calls = []\ndef bump():\n    calls.append(1)\n    return len(calls)\nbump()\ncalls\n"
        for line in (0, 1):
            self.k.evaluate(src, line)
        self.assertEqual(self.k.evaluate(src, 4)["value"], "1")
        self.assertEqual(self.k.evaluate(src, 5)["value"], "[1]")


class ChannelIsolation(KernelTest):
    def test_print_does_not_corrupt_the_framing(self):
        src = "print('hello')\nx = 1\nx\n"
        first = self.k.evaluate(src, 0)
        self.assertTrue(first["ok"], first)
        self.assertEqual(first["stdout"], "hello\n")
        # The next request must still be answered in order.
        self.k.evaluate(src, 1)
        self.assertEqual(self.k.evaluate(src, 2)["value"], "1")

    def test_input_raises_rather_than_eating_the_next_request(self):
        # Left alone, input() reads the protocol channel and consumes the next
        # request as the user's typed answer -- the extension appears to hang
        # while the kernel quietly eats its instructions.
        result = self.k.evaluate("name = input('who? ')\n", 0)
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["type"], "EOFError")
        self.assertEqual(
            self.k.evaluate_lines("z = 9\nz\n", 0, 1)["value"], "9")

    def test_user_code_rebinding_stdout_does_not_hijack_the_protocol(self):
        src = "import io, sys\nsys.stdout = io.StringIO()\nq = 5\nq\n"
        for line in (0, 1, 2):
            self.k.evaluate(src, line)
        self.assertEqual(self.k.evaluate(src, 3)["value"], "5")

    def test_stderr_is_reported_separately_from_failure(self):
        src = "import sys\nsys.stderr.write('warned')\n"
        self.k.evaluate(src, 0)
        result = self.k.evaluate(src, 1)
        self.assertTrue(result["ok"], "writing to stderr is not a failure")
        self.assertEqual(result["stderr"], "warned")


class Failures(KernelTest):
    def test_an_exception_is_reported_and_the_kernel_survives(self):
        result = self.k.evaluate("boom\n", 0)
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["type"], "NameError")
        self.assertEqual(
            self.k.evaluate_lines("ok = 1\nok\n", 0, 1)["value"], "1")

    def test_the_traceback_quotes_the_buffer_not_the_disk(self):
        # An unsaved edit otherwise makes the reported source line wrong.
        src = "raise ValueError('from the buffer')\n"
        result = self.k.evaluate(src, 0, filename=__file__)
        self.assertIn("from the buffer", result["error"]["traceback"])
        self.assertIn("raise ValueError", result["error"]["traceback"])

    def test_the_traceback_omits_the_kernels_own_frames(self):
        result = self.k.evaluate("1 / 0\n", 0, filename="/tmp/user.py")
        self.assertNotIn("evalens_kernel.py", result["error"]["traceback"])

    def test_sys_exit_does_not_take_the_kernel_down(self):
        result = self.k.evaluate_lines("import sys\nsys.exit(3)\n", 0, 1)
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["type"], "SystemExit")
        self.assertEqual(
            self.k.evaluate_lines("alive = 1\nalive\n", 0, 1)["value"], "1")

    def test_a_repr_that_raises_is_contained(self):
        src = ("class Bad:\n"
               "    def __repr__(self):\n"
               "        raise RuntimeError('nope')\n"
               "bad = Bad()\n")
        self.k.evaluate(src, 0)
        result = self.k.evaluate(src, 3)
        self.assertTrue(result["ok"])
        self.assertIn("repr() raised RuntimeError", result["value"])

    def test_a_syntax_error_reports_its_position(self):
        result = self.k.evaluate("a = 1\ndef (\n", 0)
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["type"], "SyntaxError")
        self.assertEqual(result["range"]["start"]["line"], 1)

    def test_malformed_json_is_answered_not_swallowed(self):
        result = self.k.send_raw("{not json")
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["type"], "ProtocolError")
        self.assertEqual(
            self.k.evaluate_lines("v = 2\nv\n", 0, 1)["value"], "2")


class LoadFile(KernelTest):
    SOURCE = (
        "import sys\n"
        "GREETING = 'hello'\n"
        "def shout():\n"
        "    return GREETING.upper()\n"
        "if __name__ == '__main__':\n"
        "    sys.exit('the main guard ran')\n"
    )

    def load(self, source=None):
        return self.k.send(op="eval_file",
                           source=self.SOURCE if source is None else source,
                           filename="/tmp/module.py")

    def test_loading_populates_the_namespace_in_one_step(self):
        result = self.load()
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["statements"], 4)
        # The point of the command: a line near the bottom now evaluates
        # without walking down the file first.
        called = self.k.evaluate(self.SOURCE + "shout()\n", 6)
        self.assertEqual(called["value"], "'HELLO'")

    def test_the_main_guard_does_not_run(self):
        # True because __name__ is "__evalens__", which is what importing a
        # module means. Pinned because it is a consequence of the namespace
        # setup rather than an explicit rule, and would be easy to break by
        # making __name__ look more realistic.
        self.assertTrue(self.load()["ok"])
        self.assertEqual(
            self.k.evaluate("__name__\n", 0)["value"], "'__evalens__'")

    def test_loading_continues_past_a_failure(self):
        # A file being explored in is expected to contain broken lines; that
        # is why you are poking at it. Abandoning everything below the first
        # mistake means the command that sets up a session refuses to.
        source = "a = 1\nundefined_one\nb = 2\nundefined_two\nc = 3\n"
        result = self.load(source)
        self.assertTrue(result["ok"], "a broken line is not a broken load")
        self.assertEqual(result["statements"], 5)
        self.assertEqual(result["ran"], 3)
        failed = [r for r in result["results"] if not r["ok"]]
        self.assertEqual(len(failed), 2)
        self.assertEqual([f["range"]["start"]["line"] for f in failed], [1, 3])
        # Including the statement BELOW both failures.
        for name, expected in (("a", "1"), ("b", "2"), ("c", "3")):
            self.assertEqual(self.k.evaluate(name + "\n", 0)["value"], expected)

    def test_loading_reports_a_value_for_every_statement(self):
        # Load File exists to remove the tedium of walking down a file
        # pressing a key. Running the statements and showing nothing removes
        # nothing.
        result = self.load("a = 1\nb = a + 1\nb\n")
        shown = [(r["display"], r["value"]) for r in result["results"]]
        self.assertEqual(shown, [("a", "1"), ("b", "2"), ("b", "2")])

    def test_a_statement_with_no_value_still_reports_that_it_ran(self):
        result = self.load("x = 0\nif True:\n    x = 5\nx\n")
        conditional = result["results"][1]
        self.assertTrue(conditional["ok"])
        self.assertIsNone(conditional["value"])
        self.assertEqual(conditional["kind"], "If")
        self.assertEqual(result["results"][2]["value"], "5")

    def test_loading_does_not_double_execute_expression_statements(self):
        # A bare exec loop would reintroduce the double-execution bug across
        # a whole file, which is a far worse version of it.
        result = self.load("xs = []\nxs.append(7)\nxs\n")
        self.assertEqual(result["results"][2]["value"], "[7]")

    def test_output_is_captured_and_attributed_per_statement(self):
        # Per statement rather than for the whole load: with twenty prints in
        # a file, one merged blob says nothing about which line wrote what.
        result = self.load("print('first')\nprint('second')\n")
        self.assertEqual(
            [r["stdout"] for r in result["results"]], ["first\n", "second\n"])

    def test_a_syntax_error_is_reported_with_its_position(self):
        result = self.load("a = 1\ndef (\n")
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["type"], "SyntaxError")

    def test_loading_an_empty_file_is_not_an_error(self):
        result = self.load("")
        self.assertTrue(result["ok"])
        self.assertEqual(result["statements"], 0)


class Descriptions(KernelTest):
    """What a value shows when its repr is a memory address.

    The complaint these answer is that `<function area at 0x10614a610>` changed
    on every evaluation while the code did not, which teaches the reader to
    distrust the annotation. The line that matters most is the last one here:
    the same `def`, evaluated twice, reads identically.
    """

    ADDRESS = re.compile(r"0x[0-9a-fA-F]+")

    def show(self, source):
        """The last statement's response, with everything above it run."""
        lines = range(len(source.rstrip("\n").split("\n")))
        return self.k.evaluate_lines(source, *lines)

    def test_a_function_shows_its_signature_not_its_address(self):
        result = self.show("def area(w, h):\n    return w * h\n")
        self.assertEqual(result["value"], "area(w, h)")
        self.assertNotRegex(result["value"], self.ADDRESS)

    def test_the_untouched_repr_is_still_available(self):
        # Nothing is lost by describing: the extension puts this on the hover.
        result = self.show("def area(w, h):\n    return w * h\n")
        self.assertRegex(result["repr"], r"^<function area at 0x[0-9a-f]+>$")

    def test_annotations_and_defaults_come_through(self):
        result = self.show(
            "def area(w: int, h: int = 2) -> int:\n    return 1\n")
        self.assertEqual(result["value"], "area(w: int, h: int = 2) -> int")

    def test_the_kernels_own_future_import_does_not_reach_user_code(self):
        # compile() applies the future statements of the frame that calls it,
        # so this module's `from __future__ import annotations` used to turn
        # every annotation in the user's buffer into a string. It showed up as
        # `area(w: 'int')`, but the real damage was wider: get_type_hints,
        # dataclasses and any runtime validator saw 'int' where the file said
        # int, and user code behaved differently under Evalens than under
        # `python file.py`.
        src = ("def area(w: int) -> int:\n"
               "    return w\n"
               "area.__annotations__['w'] is int\n")
        self.assertEqual(self.k.evaluate_lines(src, 0, 2)["value"], "True")

    def test_star_args_and_kwargs_come_through(self):
        result = self.show(
            "def call(a, *args, key=None, **kwargs):\n    pass\n")
        self.assertEqual(result["value"], "call(a, *args, key=None, **kwargs)")

    def test_a_generator_function_says_what_calling_it_returns(self):
        # The trap worth surfacing: this is the explanation for why iterating
        # the result a second time found it empty.
        result = self.show("def counted(n):\n    yield n\n")
        self.assertEqual(result["value"], "counted(n) -> generator")

    def test_a_coroutine_function_says_so_too(self):
        result = self.show("async def fetch(url):\n    return url\n")
        self.assertEqual(result["value"], "fetch(url) -> coroutine")

    def test_a_class_shows_how_to_construct_one(self):
        result = self.show("class Config:\n"
                           "    def __init__(self, name, port=8080):\n"
                           "        self.name = name\n")
        self.assertEqual(result["value"], "class Config(name, port=8080)")

    def test_an_instance_with_the_default_repr_shows_its_class(self):
        result = self.show("class Config:\n"
                           "    def __init__(self, name):\n"
                           "        self.name = name\n"
                           "cfg = Config('a')\n")
        self.assertEqual(result["value"], "<Config instance>")
        self.assertRegex(result["repr"], self.ADDRESS)

    def test_a_custom_repr_is_left_completely_alone(self):
        # The one rule this feature must not break. A repr someone wrote is a
        # deliberate statement about how the object should read, and rewriting
        # it would be the extension overruling the user's own code.
        result = self.show("class Money:\n"
                           "    def __repr__(self):\n"
                           "        return '$4.00'\n"
                           "price = Money()\n")
        self.assertEqual(result["value"], "$4.00")
        self.assertNotIn("repr", result)

    def test_an_inherited_custom_repr_is_left_alone_as_well(self):
        # Detected by comparing type(obj).__repr__ against object.__repr__, not
        # by looking at the text: a base class's __repr__ was written for this
        # object just as deliberately as its own would have been.
        result = self.show("class Money:\n"
                           "    def __repr__(self):\n"
                           "        return '$4.00'\n"
                           "class Euros(Money):\n"
                           "    pass\n"
                           "price = Euros()\n")
        self.assertEqual(result["value"], "$4.00")
        self.assertNotIn("repr", result)

    def test_a_metaclass_repr_is_left_alone(self):
        result = self.show("class Shouty(type):\n"
                           "    def __repr__(cls):\n"
                           "        return 'THE CLASS'\n"
                           "class Thing(metaclass=Shouty):\n"
                           "    pass\n")
        self.assertEqual(result["value"], "THE CLASS")

    def test_a_builtin_with_no_signature_reads_the_one_in_its_docstring(self):
        # inspect.signature raises ValueError for min, which used to leave
        # `<built-in function min>`. A builtin that cannot express a
        # machine-readable signature states one in its docstring's first line
        # by convention, precisely so tooling can find it there.
        result = self.show("min\n")
        self.assertTrue(result["ok"], result)
        self.assertEqual(
            result["value"],
            "min(iterable, *[, default=obj, key=func]) -> value")
        # And the substitution still hides nothing: the hover has the original.
        self.assertEqual(result["repr"], "<built-in function min>")

    def test_a_builtin_type_keeps_reading_as_a_class(self):
        # The docstring line already names the type, so the `class` prefix is
        # the only thing telling a reader that calling `range` constructs one.
        # Dropping it here would make builtin types read unlike written ones.
        result = self.show("range\n")
        self.assertEqual(result["value"], "class range(stop) -> range object")

    def test_a_prose_docstring_is_never_mistaken_for_a_signature(self):
        # ValueError has no signature, and its docstring opens "Inappropriate
        # argument value (of correct type)." -- prose that even contains a
        # parenthesis, so only the leading name rules it out. A sentence
        # rendered where a call belongs is worse than the repr it replaced,
        # because the reader cannot tell that it is wrong.
        result = self.show("ValueError\n")
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["value"], "<class 'ValueError'>")
        self.assertNotIn("repr", result)

    def test_only_the_first_documented_overload_is_shown(self):
        # `dict` documents four ways to build one; a one-line annotation has
        # room for the first, and the rest are a hover's problem.
        result = self.show("dict\n")
        self.assertEqual(result["value"],
                         "class dict() -> new empty dictionary")

    def test_the_common_builtins_all_describe_themselves(self):
        # The regression guard, and the reason it is a table: which builtins
        # carry an Argument Clinic signature and which fall back to their
        # docstring changes between Python releases -- `print`, `zip`, `map`
        # and `filter` all moved between 3.9 and 3.14. What must not change is
        # that every one of them answers with a call rather than with a
        # `<built-in ...>` or `<class ...>` placeholder.
        names = ("len print min max range dict list sorted sum open "
                 "isinstance enumerate zip int str abs round map filter "
                 "type").split()
        for name in names:
            with self.subTest(builtin=name):
                value = self.show(f"{name}\n")["value"]
                self.assertIn("(", value)
                self.assertNotRegex(value, r"^<(built-in|class) ")

    def test_ordinary_values_are_untouched(self):
        for source, expected in (("[1, 2, 3]\n", "[1, 2, 3]"),
                                 ("{'a': 1}\n", "{'a': 1}"),
                                 ("None\n", "None"),
                                 ("42\n", "42")):
            with self.subTest(source=source):
                result = self.show(source)
                self.assertEqual(result["value"], expected)
                self.assertNotIn("repr", result)

    def test_evaluating_the_same_def_twice_gives_the_same_annotation(self):
        # The ticket's acceptance criterion. Re-running a `def` is the normal
        # inner-loop move; with the address in the annotation it changed every
        # time while nothing about the code had.
        source = "def area(w, h):\n    return w * h\n"
        first = self.k.evaluate(source, 0)["value"]
        second = self.k.evaluate(source, 0)["value"]
        self.assertEqual(first, second)
        self.assertEqual(first, "area(w, h)")

    def test_re_binding_an_instance_gives_the_same_annotation(self):
        source = ("class Config:\n"
                  "    pass\n"
                  "cfg = Config()\n")
        self.k.evaluate_lines(source, 0, 2)
        for _ in range(2):
            self.assertEqual(
                self.k.evaluate(source, 2)["value"], "<Config instance>")


class Loops(KernelTest):
    """A `for` reports the sequence it ran through, not where it stopped.

    `p: 4` is true and nearly useless: the reason to run a loop in an
    exploration file is to watch what it does, and every iteration but the
    last is thrown away.
    """

    def test_a_loop_reports_every_value_its_target_held(self):
        result = self.k.evaluate("for p in [1, 2, 3, 4]:\n    pass\n", 0)
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["display"], "p")
        self.assertEqual(
            result["loop"],
            {"values": ["1", "2", "3", "4"], "last": None, "count": 4})

    def test_the_value_is_still_the_last_iteration(self):
        # A reader of the wire that knows nothing about `loop` shows something
        # true rather than nothing.
        result = self.k.evaluate("for p in [1, 2, 3, 4]:\n    pass\n", 0)
        self.assertEqual(result["value"], "4")

    def test_an_ordinary_statement_carries_no_loop_at_all(self):
        self.assertNotIn("loop", self.k.evaluate("x = 1 + 1\n", 0))

    def test_a_long_loop_is_bounded_rather_than_sent_whole(self):
        result = self.k.evaluate("for p in range(10000):\n    pass\n", 0)
        self.assertEqual(result["loop"]["values"], ["0", "1", "2", "3", "4"])
        self.assertEqual(result["loop"]["last"], "9999")
        self.assertEqual(result["loop"]["count"], 10000)

    def test_break_shows_the_values_up_to_the_break(self):
        result = self.k.evaluate(
            "for p in [1, 2, 3, 4]:\n    if p == 3:\n        break\n", 0)
        self.assertEqual(result["loop"]["values"], ["1", "2", "3"])

    def test_continue_still_records_the_iteration_it_skipped(self):
        result = self.k.evaluate(
            "for p in [1, 2, 3]:\n    if p == 2:\n        continue\n", 0)
        self.assertEqual(result["loop"]["values"], ["1", "2", "3"])

    def test_a_loop_over_mutable_objects_shows_what_each_iteration_held(self):
        # The same list every time, mutated by the body. Taking the repr() at
        # the end would report [0, 1, 2] three times, which reads as three
        # observations of nothing changing.
        result = self.k.evaluate_lines(
            "row = []\n"
            "for r in [row, row, row]:\n    r.append(len(r))\n", 0, 1)
        self.assertEqual(result["loop"]["values"], ["[]", "[0]", "[0, 1]"])

    def test_a_tuple_target_records_the_tuple(self):
        result = self.k.evaluate(
            "for k, v in {'a': 1, 'b': 2}.items():\n    pass\n", 0)
        self.assertEqual(result["display"], "(k, v)")
        self.assertEqual(result["loop"]["values"], ["('a', 1)", "('b', 2)"])

    def test_a_loop_that_never_runs_says_so_rather_than_lying(self):
        # The target is never bound, so reading it afterwards either raises
        # NameError or -- worse -- returns what an earlier loop left in it and
        # reports a value this one never produced.
        result = self.k.evaluate_lines(
            "p = 99\nfor p in []:\n    pass\n", 0, 1)
        self.assertTrue(result["ok"], result)
        self.assertIsNone(result["value"])
        self.assertEqual(result["loop"]["count"], 0)

    def test_each_recorded_value_is_capped_before_the_wire(self):
        result = self.k.evaluate(
            "for s in ['x' * 5000, 'y' * 5000]:\n    pass\n", 0)
        for value in result["loop"]["values"]:
            self.assertLess(len(value), 400)
            self.assertIn("truncated from", value)

    def test_a_traceback_from_inside_a_loop_points_at_the_real_line(self):
        # The injected statement carries the `for` line, so the body keeps its
        # own. Without that, a traceback quotes a line the user never wrote.
        result = self.k.evaluate(
            "for p in [1, 2, 3]:\n    if p == 2:\n"
            "        raise ValueError('two')\n", 0, filename="/tmp/user.py")
        self.assertFalse(result["ok"])
        self.assertIn("line 3", result["error"]["traceback"])
        self.assertIn("raise ValueError", result["error"]["traceback"])
        self.assertNotIn("loops.py", result["error"]["traceback"])
        self.assertNotIn("evalens_kernel.py", result["error"]["traceback"])

    def test_the_loop_leaves_no_machinery_in_the_namespace(self):
        self.k.evaluate("for p in [1, 2]:\n    pass\n", 0)
        listed = self.k.evaluate("sorted(dir())\n", 0)["value"]
        self.assertNotIn("evalens_loops", listed)

    def test_a_function_defined_in_a_loop_still_works_afterwards(self):
        # Its own loops run when it is called, long after this evaluation
        # finished; instrumenting them would plant a NameError inside it.
        src = ("fns = []\n"
               "for i in [1, 2]:\n"
               "    def make(n=i):\n"
               "        out = []\n"
               "        for j in range(n):\n"
               "            out.append(j)\n"
               "        return out\n"
               "    fns.append(make)\n"
               "[f() for f in fns]\n")
        self.assertEqual(
            self.k.evaluate_lines(src, 0, 1, 8)["value"], "[[0], [0, 1]]")

    def test_loading_a_file_reports_a_loops_sequence_too(self):
        result = self.k.send(op="eval_file",
                             source="for p in [1, 2, 3]:\n    pass\n",
                             filename="/tmp/module.py")
        self.assertEqual(result["results"][0]["loop"]["values"],
                         ["1", "2", "3"])


class Anchors(KernelTest):
    """Which line the value is written on, over the wire.

    `range` says how much code ran and `anchor` says where the answer goes.
    They agree for almost everything, which is why the field is absent unless
    they do not.
    """

    def test_a_def_answers_with_the_def_line(self):
        result = self.k.evaluate("def greet(name):\n    return name\n", 0)
        self.assertEqual(result["anchor"], 0)
        self.assertEqual(result["range"]["end"]["line"], 1)

    def test_a_loop_answers_with_its_header_line(self):
        result = self.k.evaluate_lines(
            "squares = [1, 4]\nfor p in squares:\n    print(p)\n", 0, 1)
        self.assertEqual(result["anchor"], 1)
        self.assertEqual(result["range"]["end"]["line"], 2)

    def test_an_ordinary_statement_carries_no_anchor_at_all(self):
        self.assertNotIn("anchor", self.k.evaluate("x = 1\n", 0))
        self.assertNotIn(
            "anchor", self.k.evaluate("t = sum([\n    1,\n    2,\n])\n", 0))

    def test_a_failing_compound_statement_reports_on_its_header_too(self):
        result = self.k.evaluate("for p in [1]:\n    undefined_name\n", 0)
        self.assertFalse(result["ok"])
        self.assertEqual(result["anchor"], 0)

    def test_loading_a_file_anchors_each_statement_the_same_way(self):
        result = self.k.send(op="eval_file",
                             source="x = 1\nif x:\n    y = 2\n",
                             filename="/tmp/module.py")
        self.assertNotIn("anchor", result["results"][0])
        self.assertEqual(result["results"][1]["anchor"], 1)


class Protocol(KernelTest):
    def test_responses_carry_the_request_id(self):
        self.assertEqual(self.k.send(op="ping", id=77)["id"], 77)

    def test_a_blank_line_resolves_to_nothing_without_erroring(self):
        result = self.k.evaluate("a = 1\n\nb = 2\n", 1)
        self.assertTrue(result["ok"])
        self.assertFalse(result["resolved"])

    def test_a_statement_with_nothing_to_show_still_runs(self):
        src = "x = 0\nif True:\n    x = 5\nx\n"
        self.k.evaluate(src, 0)
        shown = self.k.evaluate(src, 1)
        self.assertTrue(shown["ok"])
        self.assertIsNone(shown["value"])
        self.assertEqual(shown["kind"], "If")
        self.assertEqual(self.k.evaluate(src, 3)["value"], "5")

    def test_a_huge_repr_is_capped_before_the_wire(self):
        src = "big = 'x' * 100000\nbig\n"
        self.k.evaluate(src, 0)
        value = self.k.evaluate(src, 1)["value"]
        self.assertLess(len(value), 9000)
        self.assertIn("truncated from", value)

    def test_eval_above_is_reserved_not_silently_wrong(self):
        result = self.k.send(op="eval_above", source="a = 1\n", line=0)
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["type"], "NotImplemented")

    def test_an_unknown_op_is_reported(self):
        self.assertEqual(
            self.k.send(op="nonsense")["error"]["type"], "UnknownOp")


if __name__ == "__main__":
    unittest.main()
