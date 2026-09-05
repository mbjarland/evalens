"""Tests for the kernel, driven as a real subprocess over real pipes.

These deliberately do not import the kernel and call its functions. Almost
every failure mode worth catching here is a property of the *process* -- that
stdout stays a clean protocol channel, that a request cannot be eaten by
`input()`, that an exception leaves a usable namespace behind -- and none of
those are observable in-process.
"""

import contextlib
import json
import os
import re
import subprocess
import sys
import tempfile
import threading
import time
import unittest

KERNEL = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                      "evalens_kernel.py")

#: How long any single answer may take before the test calls it a hang.
#: Generous, because a loaded CI runner is slow; finite, because the failure
#: these interrupt tests guard against is a kernel that never answers, and a
#: suite that stops instead of failing is a suite nobody runs in CI.
ANSWER_TIMEOUT = 15


#: Whether this harness can give the kernel its control channel.
#:
#: `pass_fds` is POSIX-only, and `subprocess` cannot renumber a descriptor on
#: the way into the child -- which is why the kernel takes `--control-in` /
#: `--control-out` rather than insisting on 3 and 4. Node, which is what
#: actually spawns the kernel, hands over an ordered `stdio` array and has the
#: channel on every platform; this limit is the test harness's, not the
#: product's.
CAN_OPEN_CONTROL = os.name != "nt"


class KernelProcess:
    """A running kernel, spoken to one JSON line at a time."""

    def __init__(self, control=True):
        argv = [sys.executable, KERNEL]
        pass_fds = ()
        if control and CAN_OPEN_CONTROL:
            # Two pipes: one each way. The kernel keeps requests and their
            # responses on stdin/stdout and everything that has to be serviced
            # *during* an evaluation on these, because a stream someone is
            # blocked reading cannot also be read by anybody else.
            to_kernel_read, to_kernel_write = os.pipe()
            from_kernel_read, from_kernel_write = os.pipe()
            argv += ["--control-in", str(to_kernel_read),
                     "--control-out", str(from_kernel_write)]
            pass_fds = (to_kernel_read, from_kernel_write)

        self.proc = subprocess.Popen(
            argv,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True, bufsize=1,
            pass_fds=pass_fds,
        )
        self.control_out = None
        self.control_in = None
        if pass_fds:
            # The child owns its ends now; holding copies open here would keep
            # the kernel's control reader from ever seeing end-of-file.
            os.close(to_kernel_read)
            os.close(from_kernel_write)
            self.control_out = os.fdopen(to_kernel_write, "w")
            self.control_in = os.fdopen(from_kernel_read, "r")
        self._id = 0

    def send(self, **request):
        self.send_async(**request)
        return self.read()

    def send_async(self, **request):
        """Write a request without waiting for its answer.

        Anything that has to happen *while* the kernel is busy needs this --
        an interrupt, an answer to a prompt -- and `send` cannot express it,
        because it blocks on the response line before returning.
        """
        self._id += 1
        request.setdefault("id", self._id)
        self.write_raw(json.dumps(request))
        return request["id"]

    def write_raw(self, text):
        self.proc.stdin.write(text + "\n")
        self.proc.stdin.flush()

    def send_raw(self, text):
        self.write_raw(text)
        return self.read()

    def read(self, timeout=ANSWER_TIMEOUT):
        """The next line the kernel writes, as a failure rather than a hang."""
        with self._deadline(timeout):
            line = self.proc.stdout.readline()
        if not line:
            raise AssertionError(
                f"kernel gave no answer within {timeout}s; stderr:\n"
                f"{self.proc.stderr.read()}")
        return json.loads(line)

    def send_control(self, **message):
        """Write one message on the control channel."""
        self.control_out.write(json.dumps(message) + "\n")
        self.control_out.flush()

    def read_control(self, timeout=ANSWER_TIMEOUT):
        """The next control message, as a failure rather than a hang."""
        with self._deadline(timeout):
            line = self.control_in.readline()
        if not line:
            raise AssertionError(
                f"kernel said nothing on the control channel within "
                f"{timeout}s; stderr:\n{self.proc.stderr.read()}")
        return json.loads(line)

    def read_control_until(self, op, timeout=ANSWER_TIMEOUT):
        """The next control message with this ``op``, skipping the rest.

        Status messages are chatter between the messages a given test is about,
        and a test that had to enumerate them would be pinned to the order of
        two independent streams.
        """
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            message = self.read_control(timeout=timeout)
            if message.get("op") == op:
                return message
        raise AssertionError(f"no {op!r} on the control channel in {timeout}s")

    def interrupt(self):
        self.send_control(op="interrupt")

    @contextlib.contextmanager
    def _deadline(self, timeout):
        """Kill the kernel if it goes quiet, so a hang shows up as a failure.

        `unittest` runs without a time limit, and the regression these tests
        exist to catch -- a signal that does not arrive, a prompt nobody
        answers -- looks exactly like a kernel that never writes another line.
        Killing it makes the read return empty and the assertion above fire.
        """
        timer = threading.Timer(timeout, self.proc.kill)
        timer.start()
        try:
            yield
        finally:
            timer.cancel()

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
            for stream in (self.proc.stdout, self.proc.stderr,
                           self.control_in, self.control_out):
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


def spinner(marker):
    """A ``while`` loop that reports it has started, then runs forever.

    The marker is written from *inside* the loop rather than on the line
    before it, and that is the whole trick: a test that waits for the file to
    appear knows the signal it then sends lands in the user's loop, not in the
    gap before the loop began. Those are different code paths -- one is caught
    by ``_run``, the other by the protocol loop -- and a test that could hit
    either is a test that proves neither.
    """
    return (
        "started = False\n"
        "while True:\n"
        "    if not started:\n"
        f"        open({marker!r}, 'w').close()\n"
        "        started = True\n"
    )


@unittest.skipUnless(CAN_OPEN_CONTROL,
                     "this harness cannot hand the kernel a control channel")
class Interrupt(KernelTest):
    """Cancel, and what it costs.

    Interrupting rather than killing is the entire design here: the request
    raises KeyboardInterrupt inside the running code, the kernel reports it
    through the same path as any other exception, and the namespace survives.
    That last part works because of how the error handling is written rather
    than because anything says so, which is why it is pinned.

    The request arrives on the control channel because it has to: the main
    thread is, by definition, busy at the moment someone wants to stop it, and
    a message it has to read itself is a message it will read when it is
    finished -- which is never, for the loop this feature exists to end.
    """

    def setUp(self):
        super().setUp()
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.marker = os.path.join(directory.name, "running")

    def wait_until_running(self, timeout=10):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if os.path.exists(self.marker):
                return
            time.sleep(0.01)
        self.fail("the evaluated code never reported that it had started")

    def test_an_interrupt_stops_the_loop_and_keeps_the_namespace(self):
        # The ticket's acceptance test, end to end: bind something, run an
        # infinite loop, interrupt it, and find the binding still there.
        source = "x = 41\n" + spinner(self.marker)
        self.assertEqual(self.k.evaluate(source, 0)["value"], "41")
        self.k.evaluate(source, 1)

        self.k.send_async(op="eval", source=source, line=2, character=0)
        self.wait_until_running()
        self.k.interrupt()

        result = self.k.read()
        self.assertFalse(result["ok"], result)
        self.assertEqual(result["error"]["type"], "KeyboardInterrupt")

        # And the reason for signalling rather than killing: everything the
        # session had built up is still in the namespace afterwards.
        self.assertEqual(self.k.evaluate("x\n", 0)["value"], "41")

    def test_the_kernel_acknowledges_an_interrupt_before_delivering_it(self):
        # Cancel is not fire-and-forget: the extension needs to be able to say
        # "sent, and heard" rather than hoping. The acknowledgement is the
        # weaker of the two available claims on purpose -- this says the kernel
        # heard, not that the loop has stopped, which no message could honestly
        # promise while a C extension is free to ignore the interrupt.
        source = spinner(self.marker)
        self.k.evaluate(source, 0)
        self.k.send_async(op="eval", source=source, line=1, character=0)
        self.wait_until_running()

        self.k.interrupt()
        self.assertEqual(
            self.k.read_control_until("interrupt_ack")["op"], "interrupt_ack")
        self.assertEqual(self.k.read()["error"]["type"], "KeyboardInterrupt")

    def test_the_kernel_says_when_it_is_busy_and_when_it_is_not(self):
        # So the extension's progress UI is driven by what the kernel is doing
        # rather than by "the promise has not settled yet", which is also true
        # while an interpreter is still being probed.
        self.k.send_async(op="ping")
        first = self.k.read_control()
        self.assertEqual((first["op"], first["state"]), ("status", "busy"))
        second = self.k.read_control()
        self.assertEqual((second["op"], second["state"]), ("status", "idle"))
        self.assertEqual(first["id"], second["id"])

    def test_an_interrupt_while_idle_does_not_take_the_kernel_down(self):
        # The race Cancel loses when the evaluation finishes first. Answering
        # a late interrupt by dying would discard the namespace for the sake of
        # stopping something that had already stopped.
        self.assertEqual(self.k.evaluate_lines("y = 7\ny\n", 0, 1)["value"], "7")
        self.k.interrupt()
        self.k.read_control_until("interrupt_ack")
        time.sleep(0.2)
        self.assertTrue(self.k.send(op="ping")["ok"])
        self.assertEqual(self.k.evaluate("y\n", 0)["value"], "7")

    def test_a_kernel_with_no_control_channel_still_evaluates(self):
        # Every existing three-pipe caller, and the harness's own default on a
        # platform that cannot pass extra descriptors. Losing the channel loses
        # the ability to interrupt; it must not lose the ability to run code.
        plain = KernelProcess(control=False)
        self.addCleanup(plain.close)
        self.assertEqual(plain.evaluate_lines("z = 3\nz\n", 0, 1)["value"], "3")

    def test_an_interrupt_stops_a_load_instead_of_failing_every_line(self):
        # A load does not stop at a failure -- a file being explored in is
        # expected to contain broken lines. An interrupt is not that: it is
        # the user asking for the load to end, and carrying on into the next
        # statement would answer "stop" by running more of their code.
        source = spinner(self.marker) + "after = 'reached'\n"
        self.k.send_async(op="eval_file", source=source, filename="/tmp/m.py")
        self.wait_until_running()
        self.k.interrupt()

        result = self.k.read()
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["statements"], 3)
        self.assertEqual(result["ran"], 1, "only `started = False` completed")
        self.assertEqual(len(result["results"]), 2, "the load stopped here")
        self.assertEqual(
            result["results"][-1]["error"]["type"], "KeyboardInterrupt")
        self.assertFalse(self.k.evaluate("after\n", 0)["ok"],
                         "the statement after the loop must not have run")


@unittest.skipUnless(CAN_OPEN_CONTROL,
                     "this harness cannot hand the kernel a control channel")
class Prompts(KernelTest):
    """`input()`, and the boundary around it.

    The kernel hands evaluated code an isolated stdin so that a read cannot
    eat the protocol channel. This is that isolation given somewhere to go:
    the stub asks the extension on the control channel and blocks for the
    answer, and nothing that needs a real terminal is wrapped.
    """

    def ask(self, source, line=0, **extra):
        """Start an evaluation that will prompt, and return the request."""
        self.k.send_async(op="eval", source=source, line=line,
                          allow_stdin=True, **extra)
        return self.k.read_control_until("input_request")

    def test_a_prompt_round_trips_and_the_answer_becomes_the_value(self):
        request = self.ask("name = input('who? ')\n")
        self.assertEqual(request["prompt"], "who? ")
        self.assertFalse(request["password"])

        self.k.send_control(op="input_reply", seq=request["seq"], value="Ada")
        result = self.k.read()
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["value"], "'Ada'")

    def test_cancelling_a_prompt_raises_EOFError(self):
        # Preserved deliberately as the escape hatch. A student who cannot get
        # out of a prompt is worse off than one whose program errors.
        request = self.ask("name = input('who? ')\n")
        self.k.send_control(op="input_reply", seq=request["seq"], value=None)
        result = self.k.read()
        self.assertFalse(result["ok"], result)
        self.assertEqual(result["error"]["type"], "EOFError")

    def test_a_request_arriving_during_a_prompt_is_not_eaten(self):
        # The regression this whole two-pipe design exists to prevent, and the
        # thing that must never come back. The user is looking at an input box
        # and their instinct is to press the evaluate key again. That request
        # lands on the request pipe while the kernel is blocked -- and if the
        # code waiting for the answer were reading that same pipe, it would
        # take the JSON as the typed answer, bind it to `name`, and leave the
        # second request with no response for anyone to wait on.
        request = self.ask("name = input('who? ')\n")

        interloper = self.k.send_async(op="ping")
        self.k.send_control(op="input_reply", seq=request["seq"], value="Ada")

        answered = self.k.read()
        self.assertEqual(answered["value"], "'Ada'",
                         "the interloping request was read as the answer")

        pinged = self.k.read()
        self.assertEqual(pinged["id"], interloper,
                         "the request that arrived mid-prompt got no response")
        self.assertTrue(pinged["ok"])

    def test_a_file_load_never_prompts_however_it_is_asked(self):
        # A load exists to avoid waiting. Twenty prompts in a teaching file
        # would otherwise stop it dead on the first one until a human noticed,
        # which is the opposite of what the command is for.
        result = self.k.send(op="eval_file", allow_stdin=True,
                             source="name = input('who? ')\nprint(name)\n",
                             filename="/tmp/course.py")
        self.assertTrue(result["ok"], result)

        first = result["results"][0]
        self.assertFalse(first["ok"])
        self.assertEqual(first["error"]["type"], "EOFError")
        self.assertIn("evaluate the line on its own", first["error"]["message"])

        during = []
        while True:
            message = self.k.read_control()
            during.append(message)
            if message.get("op") == "status" and message.get("state") == "idle":
                break
        self.assertNotIn("input_request", [m.get("op") for m in during])

    def test_an_interrupt_is_the_way_out_of_a_prompt_nobody_answers(self):
        # Why these two features had to land together. While this waits, the
        # kernel is blocked -- correctly, it is what a REPL does -- and a
        # prompt the user walked away from is indistinguishable from a hung
        # kernel. Without a way out, prompting would have replaced one
        # dead-feeling failure with another.
        self.ask("name = input('who? ')\n")
        self.k.interrupt()

        result = self.k.read()
        self.assertFalse(result["ok"], result)
        self.assertEqual(result["error"]["type"], "KeyboardInterrupt")
        self.assertEqual(
            self.k.evaluate_lines("q = 1\nq\n", 0, 1)["value"], "1")

    def test_a_stale_answer_does_not_land_in_the_next_prompt(self):
        # An answer to a question that was already abandoned -- the prompt was
        # interrupted, the box was still open, the user typed anyway. Letting
        # it stand would put someone's earlier typing into an unrelated name.
        request = self.ask("name = input('who? ')\n")
        self.k.send_control(op="input_reply", seq=request["seq"] + 99,
                            value="stale")
        self.k.send_control(op="input_reply", seq=request["seq"], value="Ada")
        self.assertEqual(self.k.read()["value"], "'Ada'")

    def test_the_prompt_is_whatever_was_printed_and_not_terminated(self):
        # How the stub carries a prompt without hooking `input`: the prompt is
        # not a parameter of the read, it is output nobody ended with a
        # newline, which is exactly why a terminal shows it on the line you
        # type on. Reading it back means `sys.stdin.readline()` gets a prompt
        # too, which hooking `input` alone would never have managed.
        source = ("import sys\n"
                  "def ask():\n"
                  "    sys.stdout.write('Q: ')\n"
                  "    return sys.stdin.readline().strip()\n"
                  "reply = ask()\n")
        self.k.evaluate(source, 0)
        self.k.evaluate(source, 1)

        request = self.ask(source, line=4)
        self.assertEqual(request["prompt"], "Q: ")
        self.k.send_control(op="input_reply", seq=request["seq"], value="here")
        self.assertEqual(self.k.read()["value"], "'here'")

    def test_a_password_read_is_marked_so_it_is_not_echoed(self):
        # getpass is out of scope and is not wrapped -- but where there is no
        # terminal it falls back to sys.stdin and arrives here like any other
        # read. Echoing it into a visible box would leak the one thing that
        # function exists to hide, so the stack says what the stream cannot.
        # `fallback_getpass` is called directly because whether the real
        # `getpass` finds a terminal depends on how the tests were started.
        source = ("import getpass\n"
                  "secret = getpass.fallback_getpass('Password: ')\n")
        self.k.evaluate(source, 0)

        request = self.ask(source, line=1)
        self.assertTrue(request["password"])
        self.assertEqual(request["prompt"], "Password: ",
                         "the prompt goes to stderr on this path")
        self.k.send_control(op="input_reply", seq=request["seq"], value="hunter2")
        self.assertEqual(self.k.read()["value"], "'hunter2'")

    def test_output_arrives_while_the_statement_is_still_running(self):
        # Invisible in any test that only reads the response: the captured
        # stdout would look the same either way. This one reads the printed
        # line off the control channel while the kernel is demonstrably still
        # inside the statement, because it is blocked waiting to be answered.
        source = ("def announce():\n"
                  "    print('working')\n"
                  "    return input('done? ')\n"
                  "reply = announce()\n")
        self.k.evaluate(source, 0)

        self.k.send_async(op="eval", source=source, line=3, allow_stdin=True)
        streamed = ""
        while "working" not in streamed:
            message = self.k.read_control()
            if message.get("op") == "stream":
                streamed += message["text"]

        request = self.k.read_control_until("input_request")
        self.k.send_control(op="input_reply", seq=request["seq"], value="yes")
        result = self.k.read()
        self.assertEqual(result["value"], "'yes'")
        self.assertEqual(result["stdout"], "working\ndone? ",
                         "the response still carries the whole of it")


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


class LoadSelection(KernelTest):
    """A load narrowed to the lines a selection touches.

    Everything a full load does, over less of the file. The narrowing is a
    line range over the whole buffer rather than a slice of the source, and
    most of what is pinned here is a consequence of that: the file the kernel
    parses is the file the user is looking at, so the numbers it answers with
    are that file's numbers and not an offset into a fragment.
    """

    #: 0: a = 1  1: b = 2  2-4: def f  5: c = f(1)
    SOURCE = ("a = 1\n"
              "b = 2\n"
              "def f(x):\n"
              "    y = x + 1\n"
              "    return y\n"
              "c = f(1)\n")

    def load(self, source, start=None, end=None):
        request = {"op": "eval_file", "source": source,
                   "filename": "/tmp/module.py"}
        if start is not None:
            request["start_line"] = start
        if end is not None:
            request["end_line"] = end
        return self.k.send(**request)

    def bound(self, name):
        """What the namespace holds for `name`, or the error type instead."""
        result = self.k.evaluate(name + "\n", 0)
        return result["value"] if result["ok"] else result["error"]["type"]

    def test_only_the_selected_statements_run(self):
        result = self.load(self.SOURCE, 0, 1)
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["ran"], 2)
        self.assertEqual(self.bound("a"), "1")
        self.assertEqual(self.bound("b"), "2")
        self.assertEqual(self.bound("f"), "NameError",
                         "nothing below the selection may have run")

    def test_the_statement_count_is_the_selections_not_the_files(self):
        # The status message quotes this number, and a count of the whole file
        # beside a run of two lines is a sentence about the wrong thing.
        self.assertEqual(self.load(self.SOURCE, 0, 1)["statements"], 2)

    def test_a_selection_starting_mid_statement_runs_it_whole(self):
        # Lines 3-5 as written are a stray assignment, a `return` outside a
        # function, and an assignment calling something undefined. Snapping
        # outward is what makes them a `def` and a call.
        result = self.load(self.SOURCE, 3, 5)
        self.assertEqual(result["ran"], 2)
        self.assertEqual(self.bound("c"), "2")

    def test_the_span_that_ran_is_reported_when_it_widened(self):
        # The extension has the selection and cannot work out how far the
        # kernel reached; the side that widened says so.
        result = self.load(self.SOURCE, 3, 5)
        self.assertEqual(result["range"]["start"], {"line": 2, "character": 0})
        self.assertEqual(result["range"]["end"]["line"], 5)

    def test_a_selection_of_whole_statements_reports_its_own_span(self):
        result = self.load(self.SOURCE, 0, 1)
        self.assertEqual(result["range"]["start"], {"line": 0, "character": 0})
        self.assertEqual(result["range"]["end"], {"line": 1, "character": 5})

    def test_a_selection_with_no_statement_in_it_is_not_an_error(self):
        result = self.load("a = 1\n\n# a comment\n\nb = 2\n", 1, 3)
        self.assertTrue(result["ok"], "nothing to run is an outcome")
        self.assertEqual(result["statements"], 0)
        self.assertEqual(result["results"], [])
        self.assertNotIn("range", result)
        self.assertEqual(self.bound("a"), "NameError",
                         "and nothing near it ran instead")

    def test_a_whole_file_load_says_nothing_about_a_span(self):
        # Absent means "you did not narrow this", which is what keeps the
        # extension from reporting a widening nobody asked about.
        self.assertNotIn("range", self.load(self.SOURCE))

    def test_annotations_carry_real_file_line_numbers(self):
        # The reason for a line range rather than a sliced source. Line 5 of
        # the file is line 0 of any slice starting at 5, and an annotation
        # painted on line 0 is beside somebody else's code.
        result = self.load(self.SOURCE, 5, 5)
        self.assertEqual(result["results"][0]["range"]["start"]["line"], 5)

    def test_a_traceback_quotes_the_real_line_of_the_real_file(self):
        source = "a = 1\nb = 2\nc = undefined_name\n"
        result = self.load(source, 2, 2)
        failure = result["results"][0]
        self.assertFalse(failure["ok"])
        self.assertIn("line 3", failure["error"]["traceback"])
        self.assertIn("c = undefined_name", failure["error"]["traceback"])

    def test_a_failure_does_not_stop_the_rest_of_the_selection(self):
        source = "a = 1\nundefined_one\nb = 2\nc = 3\n"
        result = self.load(source, 1, 2)
        self.assertTrue(result["ok"])
        self.assertEqual((result["statements"], result["ran"]), (2, 1))
        self.assertEqual(self.bound("b"), "2")

    def test_a_selected_string_that_is_not_a_docstring_still_answers(self):
        source = '"""doc"""\nx = 1\n"hello"\n'
        result = self.load(source, 2, 2)
        self.assertEqual(result["results"][0]["value"], "'hello'")

    def test_a_selection_still_refuses_to_prompt(self):
        # A selection is the same command over less code, and the reason a
        # load does not stop to ask is unchanged by how much of the file it
        # covers.
        result = self.load("x = 1\nname = input('Your name? ')\n", 0, 1)
        self.assertEqual(result["ran"], 1)
        self.assertEqual(result["results"][1]["error"]["type"], "EOFError")

    def test_a_half_stated_range_runs_nothing_rather_than_everything(self):
        # A client bug must not answer "run part of this" by running all of
        # it. This is the one shape where guessing has an irreversible cost.
        result = self.load(self.SOURCE, start=0)
        self.assertTrue(result["ok"])
        self.assertEqual(result["statements"], 0)
        self.assertEqual(self.bound("a"), "NameError")


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


class Names(KernelTest):
    """What the names on a line hold, which for most lines is the answer.

    One value per statement is right for a binding and has nothing to say for
    everything else. `print("y unaffected by rebind:", y)` produced `None` on
    the line whose entire lesson is `y`.
    """

    def pairs(self, result):
        return [(p["name"], p["value"]) for p in result.get("names", [])]

    def test_a_line_reports_the_names_it_read(self):
        result = self.k.evaluate_lines(
            "y = [1, 2, 3]\nprint('y:', y)\n", 0, 1)
        self.assertEqual(result["value"], "None", "still true, still useless")
        self.assertEqual(self.pairs(result), [("y", "[1, 2, 3]")])

    def test_a_binding_reports_what_it_read_alongside(self):
        result = self.k.evaluate_lines("a = 1\nb = 2\nt = a + b\n", 0, 1, 2)
        self.assertEqual(result["display"], "t")
        self.assertEqual(self.pairs(result), [("a", "1"), ("b", "2")])

    def test_builtins_are_not_names_worth_reporting(self):
        # They are the line's machinery, not its data, and they drop out for
        # free: `print` and `len` live in __builtins__, not in the namespace.
        result = self.k.evaluate_lines(
            "xs = [1, 2]\nprint(len(xs))\n", 0, 1)
        self.assertEqual(self.pairs(result), [("xs", "[1, 2]")])

    def test_a_users_own_function_is_skipped_too(self):
        # Its signature is worth showing where the `def` runs, and not on
        # every line that calls it afterwards.
        result = self.k.evaluate_lines(
            "def double(n):\n    return n * 2\nk = 3\ndouble(k)\n", 0, 2, 3)
        self.assertEqual(self.pairs(result), [("k", "3")])

    def test_a_module_is_skipped(self):
        result = self.k.evaluate_lines("import json\njson.dumps([1])\n", 0, 1)
        self.assertEqual(self.pairs(result), [])

    def test_a_class_is_skipped_and_its_instance_is_not(self):
        result = self.k.evaluate_lines(
            "class Box:\n    pass\nb = Box()\n[b, Box]\n", 0, 2, 3)
        self.assertEqual(self.pairs(result), [("b", "<Box instance>")])

    def test_a_described_value_carries_its_untouched_repr(self):
        result = self.k.evaluate_lines(
            "class Box:\n    pass\nb = Box()\n[b]\n", 0, 2, 3)
        self.assertRegex(result["names"][0]["repr"], r"0x[0-9a-f]+")

    def test_the_number_of_names_on_one_line_is_capped(self):
        # A line that reports every name it mentions becomes a second copy of
        # the namespace and buries the code it is written beside.
        source = ("a = 1\nb = 2\nc = 3\nd = 4\ne = 5\nf = 6\n"
                  "[a, b, c, d, e, f]\n")
        result = self.k.evaluate_lines(source, 0, 1, 2, 3, 4, 5, 6)
        self.assertEqual(len(result["names"]), 4)
        self.assertEqual([p["name"] for p in result["names"]],
                         ["a", "b", "c", "d"])

    def test_a_name_the_namespace_does_not_hold_is_simply_not_reported(self):
        # `caught` is deleted by Python at the end of the except block, so it
        # is gone by the time anyone looks.
        result = self.k.evaluate(
            "try:\n    raise ValueError('x')\n"
            "except ValueError as caught:\n    handled = str(caught)\n", 0)
        self.assertTrue(result["ok"], result)
        self.assertEqual(self.pairs(result), [("handled", "'x'")])

    def test_the_values_are_the_ones_the_statement_left_behind(self):
        # A trace, not a watch: read once, at the moment the line ran, and
        # never refreshed. Evaluating the line above again must not disturb
        # what this one already reported.
        source = "y = [1, 2, 3]\ny.append(4)\n"
        self.k.evaluate(source, 0)
        first = self.k.evaluate(source, 1)
        self.assertEqual(self.pairs(first), [("y", "[1, 2, 3, 4]")])
        second = self.k.evaluate(source, 1)
        self.assertEqual(self.pairs(second), [("y", "[1, 2, 3, 4, 4]")],
                         "each evaluation reports the namespace it left")

    def test_a_line_with_nothing_to_add_carries_no_names_at_all(self):
        self.assertNotIn("names", self.k.evaluate("x = 1 + 1\n", 0))
        self.assertNotIn("names", self.k.evaluate("sum([10, 20])\n", 0))

    def test_a_failure_reports_no_names(self):
        # The statement did not finish, so the namespace is half-updated and
        # a value read out of it would sit beside code that did not produce
        # it.
        result = self.k.evaluate_lines(
            "xs = [1]\nxs.append(undefined_name)\n", 0, 1)
        self.assertFalse(result["ok"])
        self.assertNotIn("names", result)

    def test_a_statement_with_no_value_of_its_own_still_reports_names(self):
        # An `if` had nothing to point at and so annotated nothing at all,
        # which made the most informative line in a file the emptiest.
        result = self.k.evaluate_lines(
            "budget = 500\nif budget > 100:\n    tier = 'large'\n", 0, 1)
        self.assertIsNone(result["value"])
        self.assertEqual(self.pairs(result),
                         [("tier", "'large'"), ("budget", "500")])

    def test_loading_a_file_reports_names_the_same_way(self):
        result = self.k.send(
            op="eval_file", source="y = [1, 2]\ny.append(3)\n",
            filename="/tmp/module.py")
        self.assertEqual(self.pairs(result["results"][1]),
                         [("y", "[1, 2, 3]")])


class Docstrings(KernelTest):
    """The first impression the extension makes on a documented file.

    A module docstring used to come back as its own text, wrapped and escaped,
    on the one statement in the file whose value nobody could want.
    """

    DOCUMENTED = ('"""Module 01 -- names, mutability, truthiness."""\n'
                  "x = 1\n"
                  '"hello"\n')

    def test_a_module_docstring_answers_with_no_value(self):
        result = self.k.evaluate(self.DOCUMENTED, 0)
        self.assertTrue(result["ok"], result)
        self.assertIsNone(result["display"])
        self.assertIsNone(result["value"], "its own text is not an answer")

    def test_a_bare_string_out_of_docstring_position_still_answers(self):
        result = self.k.evaluate(self.DOCUMENTED, 2)
        self.assertEqual(result["value"], "'hello'")

    def test_loading_a_file_skips_its_docstring_and_nothing_else(self):
        result = self.k.send(op="eval_file", source=self.DOCUMENTED,
                             filename="/tmp/module.py")
        self.assertEqual(
            [(r["display"], r["value"]) for r in result["results"]],
            [(None, None), ("x", "1"), ("'hello'", "'hello'")])

    def test_the_docstring_still_reports_that_it_was_evaluated(self):
        # Nothing to paint is not nothing to do. The kind and the range are
        # what drive the region highlight, and dropping them would make a
        # docstring look like a blank line the cursor found nothing on.
        result = self.k.evaluate(self.DOCUMENTED, 0)
        self.assertTrue(result["resolved"])
        self.assertEqual(result["kind"], "Expr")
        self.assertEqual(result["range"]["start"]["line"], 0)


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
