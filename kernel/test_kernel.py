"""Tests for the kernel, driven as a real subprocess over real pipes.

These deliberately do not import the kernel and call its functions. Almost
every failure mode worth catching here is a property of the *process* -- that
stdout stays a clean protocol channel, that a request cannot be eaten by
`input()`, that an exception leaves a usable namespace behind -- and none of
those are observable in-process.
"""

import json
import os
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

    def test_loading_stops_at_the_first_failure(self):
        source = "a = 1\nraise ValueError('stop here')\nb = 2\n"
        result = self.load(source)
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["type"], "ValueError")
        self.assertEqual(result["statements"], 1, "one statement ran before it")
        self.assertEqual(result["range"]["start"]["line"], 1)
        # Everything before the failure is in the namespace; nothing after is.
        self.assertEqual(self.k.evaluate("a\n", 0)["value"], "1")
        self.assertFalse(self.k.evaluate("b\n", 0)["ok"])

    def test_output_during_a_load_is_captured(self):
        self.assertEqual(self.load("print('loading')\n")["stdout"], "loading\n")

    def test_a_syntax_error_is_reported_with_its_position(self):
        result = self.load("a = 1\ndef (\n")
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["type"], "SyntaxError")

    def test_loading_an_empty_file_is_not_an_error(self):
        result = self.load("")
        self.assertTrue(result["ok"])
        self.assertEqual(result["statements"], 0)


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
