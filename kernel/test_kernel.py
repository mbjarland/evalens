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

    def test_a_builtin_with_no_signature_falls_back_to_its_repr(self):
        # inspect.signature raises ValueError for min, and a raise here would
        # take down an evaluation over a cosmetic feature.
        result = self.show("min\n")
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["value"], "<built-in function min>")
        self.assertNotIn("repr", result)

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
