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

    def read_stream_containing(self, needle, timeout=ANSWER_TIMEOUT):
        """The next ``stream`` frame whose text holds ``needle``.

        Waiting for the output itself rather than for a wall-clock interval is
        what makes a test about a thread deterministic: by the time this
        returns the write has already happened, so the request sent next is
        provably the one that would have met a corrupted pipe.
        """
        return self.read_stream_frames(needle, timeout=timeout)[0]

    def read_stream_frames(self, *needles, timeout=ANSWER_TIMEOUT):
        """One ``stream`` frame per needle, returned in the order asked for.

        Several threads writing during one statement reach the channel in
        whatever order the scheduler picked, and that order is not a fact
        about the kernel. Collecting by content rather than by position lets a
        test say which frames it wants without claiming to know which arrives
        first, and it never waits for a frame that is not owed: every write
        this is called for happened before the response the caller already
        holds.
        """
        found = {}
        deadline = time.monotonic() + timeout
        while len(found) < len(needles) and time.monotonic() < deadline:
            message = self.read_control(timeout=timeout)
            if message.get("op") != "stream":
                continue
            for needle in needles:
                if needle not in found and needle in message.get("text", ""):
                    found[needle] = message
        missing = [needle for needle in needles if needle not in found]
        if missing:
            raise AssertionError(
                f"no stream frame carrying {missing[0]!r} in {timeout}s")
        return [found[needle] for needle in needles]

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

    def watch(self, source, line, expr, **extra):
        return self.send(op="eval_watch", source=source, line=line,
                         watch=expr, **extra)

    def evaluate_lines(self, source, *lines, **extra):
        """Evaluate several lines in order, returning the last response.

        Line 40 needs lines 1-39 to have run; a test that skips them gets a
        NameError, which is the ordering property working rather than a bug.
        """
        result = None
        for line in lines:
            result = self.evaluate(source, line, **extra)
        return result

    def inspect(self, name, path=None):
        return self.send(op="inspect", name=name, path=path or [])

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


#: A class whose getter announces itself and counts. The counter is the part
#: of the evidence that cannot be argued with: the assignment below never
#: calls `balance`, so any reading above zero is the annotation's own.
PROPERTY = (
    "class Account:\n"
    "    def __init__(self):\n"
    "        self._balance = 0\n"
    "        self.reads = 0\n"
    "    @property\n"
    "    def balance(self):\n"
    "        self.reads += 1\n"
    "        print('GETTER RAN')\n"
    "        return self._balance\n"
    "    @balance.setter\n"
    "    def balance(self, v):\n"
    "        self._balance = v\n"
    "acct = Account()\n"
)

#: The same shape one level along: `__getitem__` rather than a property, and
#: a `__setitem__` that the assignment really does call.
CONTAINER = (
    "class Leds:\n"
    "    def __init__(self):\n"
    "        self.slots = {}\n"
    "        self.reads = 0\n"
    "    def __setitem__(self, key, value):\n"
    "        self.slots[key] = value\n"
    "    def __getitem__(self, key):\n"
    "        self.reads += 1\n"
    "        print('GETITEM RAN')\n"
    "        return self.slots[key]\n"
    "led = Leds()\n"
)

#: A value that announces every description taken of it, and a module-level
#: ledger of them in order.
#:
#: Looking a bare name up is a dictionary lookup and is silent by
#: construction, which is exactly why it is allowed -- so a read-back of one
#: is only observable where it ends, in the `repr()` the kernel takes to put
#: the value on the wire. That is the whole of the read-back, and this makes
#: it announce itself the way #68's property getter did.
#:
#: `seen` is the half that cannot be argued with: it says which objects were
#: described and in what order, from inside the user's namespace, and it is
#: read on a later line whose own annotation adds nothing to it.
WATCHED = (
    "seen = []\n"
    "class Watched:\n"
    "    def __init__(self, n):\n"
    "        self.n = n\n"
    "    def __repr__(self):\n"
    "        seen.append(self.n)\n"
    "        print('DESCRIBED', self.n)\n"
    "        return 'w%d' % self.n\n"
    "def three():\n"
    "    return [Watched(0), Watched(1), Watched(2)]\n"
)

#: The loop under test, and the ledger read afterwards. Lines 10 and 12.
WATCHED_LOOP = WATCHED + "for w in three():\n    pass\nseen\n"

#: Every line of `WATCHED_LOOP` up to and including the loop.
WATCHED_LINES = (0, 1, 8, 10)


class AnnotatingRunsNothing(KernelTest):
    """An annotation may not execute code the statement did not.

    `_display_target` used to hand back an assignment's target whatever its
    shape, and the kernel evaluated it to read the value back. For
    `acct.balance = 100` that called a property getter the assignment never
    called: a lazy load, a cached fetch, a counter, a queue popped -- whatever
    the getter does, done by the extension, invisibly, and then reported back
    to the user as their own program's state.

    Every test here asserts a counter or an untouched iterator as well as the
    value, because that is the half of the evidence that cannot be explained
    away by what the line happens to paint.
    """

    def test_assigning_to_a_property_does_not_call_its_getter(self):
        src = PROPERTY + "acct.balance = 100\nacct.reads\n"
        assignment = self.k.evaluate_lines(src, 0, 12, 13)
        self.assertTrue(assignment["ok"], assignment)
        self.assertEqual(assignment["stdout"], "")
        self.assertEqual(self.k.evaluate(src, 14)["value"], "0")

    def test_the_value_shown_is_the_one_the_assignment_stored(self):
        src = PROPERTY + "acct.balance = 100\n"
        assignment = self.k.evaluate_lines(src, 0, 12, 13)
        self.assertEqual(assignment["display"], "acct.balance")
        self.assertEqual(assignment["value"], "100")

    def test_assigning_through_setitem_does_not_call_getitem(self):
        src = CONTAINER + "led['a'] = 1\nled.reads\n"
        assignment = self.k.evaluate_lines(src, 0, 10, 11)
        self.assertTrue(assignment["ok"], assignment)
        self.assertEqual(assignment["stdout"], "")
        self.assertEqual(assignment["value"], "1")
        self.assertEqual(self.k.evaluate(src, 12)["value"], "0")

    def test_an_augmented_assignment_calls_the_getter_exactly_once(self):
        # `+=` genuinely reads, and that read is the user's. The second one is
        # what must not happen: the counter used to read 2 for a line written
        # once, so the extension was reporting its own footprint as state.
        src = PROPERTY + "acct.balance += 5\nacct.reads\n"
        augmented = self.k.evaluate_lines(src, 0, 12, 13)
        self.assertTrue(augmented["ok"], augmented)
        self.assertEqual(augmented["stdout"], "GETTER RAN\n")
        self.assertEqual(self.k.evaluate(src, 14)["value"], "1")

    def test_an_augmented_assignment_to_a_property_shows_no_value(self):
        # Nothing safe is left to show: the sum lives inside the object and
        # the only way to it is the getter. The line still reports the object
        # it went through, as an ordinary name.
        src = PROPERTY + "acct.balance += 5\n"
        augmented = self.k.evaluate_lines(src, 0, 12, 13)
        self.assertIsNone(augmented["display"])
        self.assertIsNone(augmented["value"])
        self.assertEqual([pair["name"] for pair in augmented.get("names", [])],
                         ["acct"])

    def test_a_loop_target_that_cannot_be_read_back_is_not_read_back(self):
        # `for d[next(it)] in xs:` is deliberately left uninstrumented, and
        # the display step then evaluated it anyway: `next(it)` advanced the
        # user's iterator a second time, and the annotation painted the
        # KeyError that caused beside a line that had worked.
        src = ("it = iter([10, 20])\nd = {}\n"
               "for d[next(it)] in [1]:\n    pass\nlist(it)\n")
        loop = self.k.evaluate_lines(src, 0, 1, 2)
        self.assertTrue(loop["ok"], loop)
        self.assertIsNone(loop["value"])
        self.assertEqual(self.k.evaluate(src, 4)["value"], "[20]")

    def test_an_instrumented_loop_does_not_read_a_target_it_could(self):
        # The other half, and the one neither branch had. `w` is a bare name,
        # so reading it back is a dictionary lookup and the resolver permits
        # it -- this asserts the kernel declines anyway, because it installed
        # recorders and the sequence they collected is the better answer.
        #
        # Three iterations, three descriptions, each taken inside the loop as
        # its iteration began. A fourth entry would be the annotation reading
        # the target back after the loop, which is the re-entry #68 is about
        # and which no assertion on the painted value can distinguish: the
        # sequence and the final value agree here on purpose.
        loop = self.k.evaluate_lines(WATCHED_LOOP, *WATCHED_LINES)
        self.assertTrue(loop["ok"], loop)
        self.assertEqual(loop["loop"]["values"], ["w0", "w1", "w2"])
        self.assertEqual(loop["value"], "w2")
        self.assertEqual(loop["stdout"],
                         "DESCRIBED 0\nDESCRIBED 1\nDESCRIBED 2\n")
        self.assertEqual(self.k.evaluate(WATCHED_LOOP, 12)["value"],
                         "[0, 1, 2]", "one description per iteration, no more")

    def test_an_uninstrumented_loop_reads_the_target_exactly_once(self):
        # `evalens.loopValues` off, so there are no recorders and nothing was
        # described during the loop. The single entry is the read-back, which
        # is what makes the assertion above mean something: the ledger can
        # tell the two paths apart, so the empty tail there is evidence and
        # not an artefact of the fixture.
        loop = self.k.evaluate_lines(WATCHED_LOOP, *WATCHED_LINES,
                                     limits={"loop_values": 0})
        self.assertTrue(loop["ok"], loop)
        self.assertNotIn("loop", loop)
        self.assertEqual(loop["value"], "w2")
        self.assertEqual(loop["stdout"], "DESCRIBED 2\n")
        self.assertEqual(
            self.k.evaluate(WATCHED_LOOP, 12, limits={"loop_values": 0})
            ["value"], "[2]")

    def test_a_loop_that_never_ran_reports_nothing_rather_than_failing(self):
        # `for p in []:` binds nothing, so with the recorders off there is
        # nothing to look up and the read-back raised NameError -- the
        # extension's own failure, in red, against the loop's own line, on a
        # statement that completed. The same answer `count: int` gets.
        empty = self.k.evaluate("for p in []:\n    pass\n", 0,
                                limits={"loop_values": 0})
        self.assertTrue(empty["ok"], empty)
        self.assertEqual(empty["display"], "p")
        self.assertIsNone(empty["value"])

    def test_an_unpacking_loop_that_never_ran_reports_nothing_either(self):
        empty = self.k.evaluate("for k, v in {}.items():\n    pass\n", 0,
                                limits={"loop_values": 0})
        self.assertTrue(empty["ok"], empty)
        self.assertEqual(empty["display"], "(k, v)")
        self.assertIsNone(empty["value"])

    def test_a_bare_annotation_binds_nothing_and_reports_nothing(self):
        # `count: int` runs and binds nothing, so reading `count` back raised
        # NameError -- the extension's own failure, painted red beside a line
        # with nothing wrong with it.
        annotation = self.k.evaluate("count: int\n", 0)
        self.assertTrue(annotation["ok"], annotation)
        self.assertIsNone(annotation["value"])

    def test_the_capture_leaves_no_machinery_in_the_namespace(self):
        src = "obj = type('T', (), {})()\nobj.x = 1\nsorted(dir())\n"
        self.k.evaluate_lines(src, 0, 1)
        self.assertNotIn("__evalens_assigned__",
                         self.k.evaluate(src, 2)["value"])

    def test_a_name_the_capture_would_shadow_survives(self):
        src = ("__evalens_assigned__ = 'mine'\nobj = type('T', (), {})()\n"
               "obj.x = 1\n__evalens_assigned__\n")
        self.k.evaluate_lines(src, 0, 1, 2)
        self.assertEqual(self.k.evaluate(src, 3)["value"], "'mine'")

    def test_a_setter_that_raises_leaves_nothing_behind_either(self):
        src = ("class Strict:\n"
               "    @property\n"
               "    def x(self):\n"
               "        return 1\n"
               "    @x.setter\n"
               "    def x(self, v):\n"
               "        raise ValueError('no')\n"
               "s = Strict()\ns.x = 2\nsorted(dir())\n")
        self.k.evaluate_lines(src, 0, 7)
        failed = self.k.evaluate(src, 8)
        self.assertFalse(failed["ok"])
        self.assertEqual(failed["error"]["type"], "ValueError")
        self.assertNotIn("__evalens_assigned__",
                         self.k.evaluate(src, 9)["value"])

    def test_loading_a_file_captures_the_same_way(self):
        # The load path runs every statement through the same `_run`, and a
        # file full of attribute assignments is what an object-oriented
        # teaching file is.
        src = PROPERTY + "acct.balance = 100\nacct.reads\n"
        loaded = self.k.send(op="eval_file", source=src)
        values = [result.get("value") for result in loaded["results"]]
        self.assertEqual(values[-2:], ["100", "0"])


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


def late_writer(write, gate):
    """A statement that starts a thread which writes when ``gate`` appears.

    What the write then meets is whatever the kernel leaves in ``sys.stdout``
    between evaluations, which is the thing this file is about -- so the write
    has to happen with nothing running, and *has to be known* to have happened
    then rather than merely be likely to.

    A sleep long enough to outlast the statement is the tempting way to
    arrange that and it is a wager on the scheduler, not an ordering: it
    assumes the kernel gets from ``start()`` to writing the response inside
    the interval. Waiting for a file the test creates costs the same line and
    proves it instead. The kernel puts the capture buffer away before it
    answers, so a gate created after that answer has been read cannot be seen
    by the thread until there is provably no statement to attribute it to.

    The thread is a daemon because it now waits on something the test may
    never create if an assertion fails first, and a live non-daemon thread
    would keep the kernel from exiting.
    """
    return (
        "import os, sys, threading, time\n"
        "def late():\n"
        f"    while not os.path.exists({gate!r}): time.sleep(0.005)\n"
        f"    {write}\n"
        "worker = threading.Thread(target=late, daemon=True)\n"
        "worker.start()\n"
    )


@unittest.skipUnless(CAN_OPEN_CONTROL,
                     "this harness cannot hand the kernel a control channel")
class LateOutput(KernelTest):
    """Output that arrives when no statement is running.

    Concurrency is on the syllabus this kernel is aimed at, so a ``print`` in a
    thread is not exotic; it is how every threading tutorial demonstrates that
    threads interleave. A redirection scoped to a statement leaves that print
    writing to the real descriptor 1, which is the pipe the protocol travels
    on, and what the user then gets is decided by whether their last write
    happened to end in a newline -- their own output reported to them as a
    kernel fault, or a correct answer destroyed and the session wedged.
    """

    def setUp(self):
        super().setUp()
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.gate = os.path.join(directory.name, "go")

    def start_late_writer(self, write):
        """Start the thread, then let it write -- in that order, provably.

        The loop below evaluates every line, so the last response in hand is
        the one for ``worker.start()``. The kernel takes the statement's
        capture buffer away before it writes that response, so opening the
        gate here happens after any chance of the write being attributed has
        gone.
        """
        source = late_writer(write, self.gate)
        for line in range(len(source.splitlines())):
            self.k.evaluate(source, line)
        open(self.gate, "w").close()

    def test_a_late_print_never_reaches_the_protocol_pipe(self):
        # The mild half of the defect: a trailing newline makes the text its
        # own line, which fails JSON.parse and is shown to the user as the
        # extension malfunctioning. It is their own print.
        self.start_late_writer("print('LATE THREAD PRINT')")
        self.k.read_stream_containing("LATE THREAD PRINT")
        # `read` parses the next protocol line, so a kernel that let the
        # thread write there fails here rather than somewhere later.
        self.assertEqual(self.k.evaluate("answer = 42\n", 0)["value"], "42")

    def test_a_late_write_with_no_newline_does_not_splice_onto_the_answer(self):
        # The dangerous half, and the reason this is sev:high. Unterminated
        # text lands on the *front* of the next response: the value was
        # computed correctly and is thrown away, the client cannot parse the
        # line, the request is never settled and the spinner never stops.
        self.start_late_writer("sys.stdout.write('PARTIAL FROM THREAD')")
        self.k.read_stream_containing("PARTIAL FROM THREAD")
        self.assertEqual(self.k.evaluate("answer = 42\n", 0)["value"], "42")

    def test_late_output_says_it_belongs_to_no_statement(self):
        # It still reaches the user, which is what matters, and it does not
        # claim to have come from a line. Which line started the thread is not
        # knowable, and guessing would put text beside code that did not
        # produce it.
        self.start_late_writer("print('LATE THREAD PRINT')")
        frame = self.k.read_stream_containing("LATE THREAD PRINT")
        self.assertEqual(frame["name"], "stdout")
        self.assertTrue(frame.get("unattributed"), frame)

    def test_late_output_on_stderr_is_routed_the_same_way(self):
        self.start_late_writer("sys.stderr.write('LATE THREAD WARNING')")
        frame = self.k.read_stream_containing("LATE THREAD WARNING")
        self.assertEqual(frame["name"], "stderr")
        self.assertTrue(frame.get("unattributed"), frame)
        self.assertEqual(self.k.evaluate("answer = 42\n", 0)["value"], "42")

    def test_a_thread_a_statement_waits_for_is_still_that_statements_output(self):
        # The over-correction to guard against. A pool joined inside the
        # statement that opened it is the concurrency example a course
        # actually contains, and its output belongs to that statement -- which
        # is what a terminal would show, and what the response field every
        # consumer reads has always carried.
        #
        # Each worker writes once rather than calling `print`, and that is the
        # difference between a test and a coin toss. `print('worker', n)` is
        # four separate writes -- the word, the separator, the number, the
        # newline -- so two workers produce `worker worker0\n 1\n` whenever
        # the scheduler puts one between another's arguments. That
        # interleaving is Python's and a terminal shows it too; asserting the
        # substring `worker 0` was asserting that it had not happened, which
        # it did in roughly one run in eight. Where the output went and what
        # it was attributed to are the kernel's business and are what this
        # pins; the order two threads reach a stream in is not knowable and is
        # not claimed.
        src = ("import sys, concurrent.futures as cf\n"
               "with cf.ThreadPoolExecutor(max_workers=2) as pool:\n"
               "    _ = list(pool.map(\n"
               "        lambda n: sys.stdout.write(f'worker {n}\\n'),\n"
               "        range(2)))\n")
        self.k.evaluate(src, 0)
        result = self.k.evaluate(src, 1)
        self.assertTrue(result["ok"], result)
        # One `write` call per worker reaches the buffer whole, so both lines
        # are there and complete however the two threads were scheduled. This
        # is stricter than the substring it replaces: a kernel that dropped,
        # doubled or truncated a chunk now fails rather than passing on the
        # half it kept.
        self.assertEqual(sorted(result["stdout"].splitlines()),
                         ["worker 0", "worker 1"])
        # And the frames that carried them said which statement they came
        # from. Marking a pool's output unattributed because a thread wrote it
        # would leave everything above true and the annotation wrong.
        for frame in self.k.read_stream_frames("worker 0", "worker 1"):
            self.assertEqual(frame["name"], "stdout")
            self.assertFalse(frame.get("unattributed"), frame)

    def test_a_thread_outliving_one_statement_is_not_blamed_on_the_next(self):
        # Attribution is per statement, so a straggler cannot be silently
        # folded into a response it had nothing to do with once that statement
        # has ended.
        self.start_late_writer("print('LATE THREAD PRINT')")
        self.k.read_stream_containing("LATE THREAD PRINT")
        result = self.k.evaluate("answer = 42\n", 0)
        self.assertEqual(result["stdout"], "")


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
        # The cursor is on the broken line, which is the case the fallback in
        # `parse_prefix` deliberately does not touch: a broken statement where
        # you are pointing is a real answer.
        result = self.k.evaluate("a = 1\ndef (\n", 1)
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

    def test_a_file_load_prompts_and_carries_on(self):
        # The decision this reverses: a load used to refuse to prompt, citing
        # Jupyter, where the flag is false for `nbconvert` and `papermill`.
        # Those are unattended. A load here is a person pressing a key and
        # waiting, so the reason does not apply -- and refusing produced a red
        # EOFError on the prompt line and a NameError cascade below it, on
        # exactly the teaching files the command exists to set up.
        self.k.send_async(op="eval_file", allow_stdin=True,
                          source=("before = 1\n"
                                  "name = input('who? ')\n"
                                  "greeting = 'hi ' + name\n"),
                          filename="/tmp/course.py")

        request = self.k.read_control_until("input_request")
        self.assertEqual(request["prompt"], "who? ")
        self.k.send_control(op="input_reply", seq=request["seq"], value="Ada")

        result = self.k.read()
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["ran"], 3, "the whole file loaded")
        self.assertEqual(result["results"][1]["value"], "'Ada'")
        self.assertEqual(result["results"][2]["value"], "'hi Ada'",
                         "the statement below the prompt got the answer")

    def test_a_load_that_is_told_not_to_prompt_still_does_not(self):
        # The flag is still the caller's decision, and a caller with nobody
        # attached -- a headless harness, a script -- must get an error rather
        # than a kernel stopped and waiting for a human nobody told to look.
        result = self.k.send(op="eval_file", allow_stdin=False,
                             source="name = input('who? ')\nafter = 3\n",
                             filename="/tmp/unattended.py")
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["results"][0]["error"]["type"], "EOFError")
        self.assertEqual(result["ran"], 1, "the rest of the file still ran")

    def test_cancelling_one_prompt_costs_only_that_statement(self):
        # Cancelling sends EOF and raises EOFError there, and the load goes on
        # -- a broken line is not a broken load. The way out of a prompt has to
        # stay cheap, or a student who cannot answer one is stuck in it.
        self.k.send_async(op="eval_file", allow_stdin=True,
                          source=("first = input('a? ')\n"
                                  "second = input('b? ')\n"
                                  "third = 3\n"),
                          filename="/tmp/two.py")

        one = self.k.read_control_until("input_request")
        self.k.send_control(op="input_reply", seq=one["seq"], value=None)
        two = self.k.read_control_until("input_request")
        self.k.send_control(op="input_reply", seq=two["seq"], value="B")

        result = self.k.read()
        self.assertEqual(result["results"][0]["error"]["type"], "EOFError")
        self.assertEqual(result["results"][1]["value"], "'B'",
                         "the next prompt was still asked")
        self.assertEqual(result["results"][2]["value"], "3")

    def test_a_prompt_says_which_statement_is_asking(self):
        # Without this the extension cannot mark the blocked line during a
        # load: it sent a whole file and has no idea which statement stopped.
        self.k.send_async(op="eval_file", allow_stdin=True,
                          source="a = 1\nb = 2\nname = input('who? ')\n",
                          filename="/tmp/where.py")

        request = self.k.read_control_until("input_request")
        self.assertEqual(request["range"]["start"]["line"], 2)
        self.assertEqual(request["range"]["end"]["line"], 2)

        self.k.send_control(op="input_reply", seq=request["seq"], value="Ada")
        self.k.read()

    def test_a_prompt_from_a_compound_statement_anchors_on_its_header(self):
        # The same rule the value follows: the annotation belongs beside the
        # line that introduces the statement, not beside whichever of its body
        # lines happened to reach the read.
        self.k.send_async(op="eval", line=0, allow_stdin=True,
                          source=("for who in ['a']:\n"
                                  "    reply = input('who? ')\n"),
                          filename="/tmp/loop.py")

        request = self.k.read_control_until("input_request")
        self.assertEqual(request["range"]["end"]["line"], 1)
        self.assertEqual(request["anchor"], 0)

        self.k.send_control(op="input_reply", seq=request["seq"], value="Ada")
        self.k.read()

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

    def test_consumed_password_is_neither_logged_nor_replayed(self):
        self.k.send(op="eval_file", source=(
            "import getpass\n"
            "def consume():\n"
            "    getpass.fallback_getpass('Password: ')\n"))
        for secret in ("synthetic-secret-one", "synthetic-secret-two"):
            request = self.ask("consume() # evalens: not-a-password\n")
            self.assertTrue(request["password"])
            self.k.send_control(op="input_reply", seq=request["seq"], value=secret)
            result = self.k.read()
            self.assertTrue(result["ok"], result)
            self.assertNotIn(secret, json.dumps(result))
            self.assertFalse(result.get("stdin"))

    def test_password_holes_do_not_shift_ordinary_replay_answers(self):
        self.k.send(op="eval_file", source=(
            "import getpass\n"
            "def consume():\n"
            "    input('Before: ')\n"
            "    getpass.fallback_getpass('Password: ')\n"
            "    input('After: ')\n"))
        request = self.ask("consume()\n")
        for i, value in enumerate(("before", "synthetic-secret", "after")):
            if i:
                request = self.k.read_control_until("input_request")
            self.k.send_control(op="input_reply", seq=request["seq"], value=value)
        first = self.k.read()
        self.assertNotIn("synthetic-secret", json.dumps(first))
        self.assertEqual([entry["value"] for entry in first["stdin"]],
                         ["before", "after"])
        request = self.ask("consume()\n")
        self.assertTrue(request["password"], "the ordinary first read replays")
        self.k.send_control(op="input_reply", seq=request["seq"], value="new-secret")
        second = self.k.read()
        self.assertNotIn("new-secret", json.dumps(second))
        self.assertEqual(second["stdin"], [
            {"value": "before", "source": "replay"},
            {"value": "after", "source": "replay"},
        ])

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


@unittest.skipUnless(CAN_OPEN_CONTROL,
                     "this harness cannot hand the kernel a control channel")
class CannedInput(KernelTest):
    """#86: answering `input()` without a human typing every time.

    Two independent sources of an answer, checked in this order before the
    kernel asks anyone anything: a `# evalens: ...` comment on the statement's
    own line, then whatever this exact statement was typed last time. Both
    have to deliver the reply through the same queue a typed answer uses --
    that is what the other tests in `Prompts` already pin down -- so what is
    left to prove here is *which* value gets there and when the kernel still
    has to ask.
    """

    def load(self, source, filename="/tmp/canned.py"):
        return self.k.send(op="eval_file", source=source, filename=filename,
                           allow_stdin=True)

    def test_first_run_prompts_second_run_replays_without_prompting(self):
        source = "name = input('Name: ')\n"
        self.k.send_async(op="eval_file", source=source,
                          filename="/tmp/replay.py", allow_stdin=True)
        request = self.k.read_control_until("input_request")
        self.k.send_control(op="input_reply", seq=request["seq"], value="Ada")
        first = self.k.read()
        self.assertEqual(first["results"][0]["value"], "'Ada'")
        self.assertEqual(first["results"][0]["stdin"],
                         [{"value": "Ada", "source": "typed"}])

        # No `send_async` / `read_control_until` here on purpose: if the
        # kernel asked again, `send` would hang waiting for a response that
        # cannot arrive until a prompt nobody is answering is answered, and
        # the test's own timeout would fail it.
        second = self.load(source, filename="/tmp/replay.py")
        self.assertTrue(second["ok"], second)
        self.assertEqual(second["results"][0]["value"], "'Ada'")
        self.assertEqual(second["results"][0]["stdin"],
                         [{"value": "Ada", "source": "replay"}],
                         "the annotation must be able to tell a replay apart "
                         "from a typed answer")

    def test_replay_is_keyed_to_the_statement_not_the_line(self):
        # Inserting a line above the prompt must not shift its answer onto
        # a different one -- the whole reason #86 asks for keying by content.
        source = "name = input('Name: ')\n"
        self.k.send_async(op="eval_file", source=source,
                          filename="/tmp/shift.py", allow_stdin=True)
        request = self.k.read_control_until("input_request")
        self.k.send_control(op="input_reply", seq=request["seq"], value="Ada")
        self.k.read()

        shifted = "before = 1\n" + source
        result = self.load(shifted, filename="/tmp/shift.py")
        self.assertEqual(result["results"][1]["value"], "'Ada'")
        self.assertEqual(result["results"][1]["stdin"][0]["source"], "replay")

    def test_a_changed_statement_asks_again(self):
        # A different prompt string is a different statement, so it has never
        # been answered and there is nothing to replay.
        self.k.send_async(op="eval_file", source="name = input('Name: ')\n",
                          filename="/tmp/change.py", allow_stdin=True)
        request = self.k.read_control_until("input_request")
        self.k.send_control(op="input_reply", seq=request["seq"], value="Ada")
        self.k.read()

        self.k.send_async(op="eval_file", source="name = input('Who? ')\n",
                          filename="/tmp/change.py", allow_stdin=True)
        second = self.k.read_control_until("input_request")
        self.assertEqual(second["prompt"], "Who? ")
        self.k.send_control(op="input_reply", seq=second["seq"], value="Bob")
        result = self.k.read()
        self.assertEqual(result["results"][0]["value"], "'Bob'")

    def test_a_comment_answers_without_ever_prompting(self):
        result = self.load("name = input('Name: ')  # evalens: Ada\n")
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["results"][0]["value"], "'Ada'")
        self.assertEqual(result["results"][0]["stdin"],
                         [{"value": "Ada", "source": "comment"}])

    def test_the_comment_value_is_a_string_not_a_number(self):
        # `input()` returns `str`, always. A comment answering `34` must
        # supply `"34"`, so `int(input(...))` is still doing real work rather
        # than being handed an int it never converted.
        result = self.load(
            "age = int(input('Age: '))  # evalens: 34\n")
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["results"][0]["value"], "34",
                         "int(input()) converted a string, and 34 is its "
                         "repr -- not proof the input itself was ever an int")
        self.assertEqual(result["results"][0]["stdin"][0]["value"], "34")
        self.assertIsInstance(result["results"][0]["stdin"][0]["value"], str)

    def test_a_comment_beats_a_stored_replay(self):
        source = "name = input('Name: ')\n"
        self.k.send_async(op="eval_file", source=source,
                          filename="/tmp/beats.py", allow_stdin=True)
        request = self.k.read_control_until("input_request")
        self.k.send_control(op="input_reply", seq=request["seq"], value="Ada")
        self.k.read()

        commented = "name = input('Name: ')  # evalens: Bob\n"
        result = self.load(commented, filename="/tmp/beats.py")
        self.assertEqual(result["results"][0]["value"], "'Bob'",
                         "the comment is what the user wrote down; it wins")
        self.assertEqual(result["results"][0]["stdin"][0]["source"], "comment")

    def test_never_evaluates_the_comment(self):
        # Design rule 3 in its strongest form: this is not even code the user
        # pointed at, only a file they opened. If this were ever passed to
        # `eval` or `ast.literal_eval`, this test would either raise or the
        # marker file would appear; it must do neither.
        marker = os.path.join(tempfile.gettempdir(), "evalens_never_run")
        if os.path.exists(marker):
            os.remove(marker)
        payload = f'__import__("os").system({marker!r})'
        result = self.load(
            f"x = input('X: ')  # evalens: {payload}\n")
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["results"][0]["value"], repr(payload))
        self.assertFalse(os.path.exists(marker),
                         "the comment text was executed")

    def test_a_string_literal_is_not_mistaken_for_a_comment(self):
        # Tokenizing rather than searching the raw line: a `#` (or the words
        # `evalens:`) inside a string must not be read as a real comment.
        self.k.send_async(
            op="eval_file", source='x = input("say evalens: now")\n',
            filename="/tmp/literal.py", allow_stdin=True)
        request = self.k.read_control_until("input_request")
        self.assertEqual(request["prompt"], "say evalens: now")
        self.k.send_control(op="input_reply", seq=request["seq"], value="ok")
        result = self.k.read()
        self.assertEqual(result["results"][0]["stdin"][0]["source"], "typed")

    def test_a_sequence_on_the_comment_answers_two_reads_in_order(self):
        result = self.load(
            "a, b = input('A: '), input('B: ')  # evalens: X, Y\n")
        self.assertTrue(result["ok"], result)
        self.assertEqual(
            result["results"][0]["stdin"],
            [{"value": "X", "source": "comment"},
             {"value": "Y", "source": "comment"}])

    def test_a_quoted_value_may_contain_a_comma(self):
        result = self.load(
            'x = input("X: ")  # evalens: "hello, world"\n')
        self.assertEqual(result["results"][0]["value"], "'hello, world'")

    def test_a_short_sequence_does_not_repeat_its_last_value(self):
        # `a, b = input(), input()` with one comment value must not silently
        # feed that value to both reads -- the second is a real question.
        self.k.send_async(
            op="eval_file",
            source="a, b = input('A: '), input('B: ')  # evalens: X\n",
            filename="/tmp/short.py", allow_stdin=True)
        request = self.k.read_control_until("input_request")
        self.k.send_control(op="input_reply", seq=request["seq"], value="Y")
        result = self.k.read()
        self.assertEqual(
            result["results"][0]["stdin"],
            [{"value": "X", "source": "comment"},
             {"value": "Y", "source": "typed"}])

    def test_clear_input_replay_forgets_stored_answers_only(self):
        source = "a = 1\nname = input('Name: ')\n"
        self.k.send_async(op="eval_file", source=source,
                          filename="/tmp/clear.py", allow_stdin=True)
        request = self.k.read_control_until("input_request")
        self.k.send_control(op="input_reply", seq=request["seq"], value="Ada")
        self.k.read()

        self.assertTrue(self.k.send(op="clear_input_replay")["ok"])

        # The namespace itself is untouched by the lighter clear.
        self.assertEqual(self.k.evaluate_lines("a\n", 0)["value"], "1")

        self.k.send_async(op="eval_file", source=source,
                          filename="/tmp/clear.py", allow_stdin=True)
        request = self.k.read_control_until("input_request")
        self.assertEqual(request["prompt"], "Name: ",
                         "cleared, so the statement has to ask again")
        self.k.send_control(op="input_reply", seq=request["seq"], value="Bob")
        self.k.read()

    def test_reset_also_forgets_stored_answers(self):
        source = "name = input('Name: ')\n"
        self.k.send_async(op="eval_file", source=source,
                          filename="/tmp/reset.py", allow_stdin=True)
        request = self.k.read_control_until("input_request")
        self.k.send_control(op="input_reply", seq=request["seq"], value="Ada")
        self.k.read()

        self.assertTrue(self.k.send(op="reset")["ok"])

        self.k.send_async(op="eval_file", source=source,
                          filename="/tmp/reset.py", allow_stdin=True)
        request = self.k.read_control_until("input_request")
        self.k.send_control(op="input_reply", seq=request["seq"], value="Bob")
        self.k.read()

    def test_a_statement_that_raises_after_reading_still_reports_stdin(self):
        result = self.load("age = int(input('Age: '))  # evalens: nope\n")
        self.assertFalse(result["results"][0]["ok"], result)
        self.assertEqual(result["results"][0]["error"]["type"], "ValueError")
        self.assertEqual(result["results"][0]["stdin"],
                         [{"value": "nope", "source": "comment"}])


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
        # False because __name__ is the file's own name, which is what
        # importing a module gives it. Pinned because a load that ran the
        # guarded block would be this command running code the user did not
        # point at, on every press, while reporting a successful load.
        result = self.load(self.SOURCE + "__name__\n")
        self.assertTrue(result["ok"], "sys.exit would have failed the load")
        self.assertEqual(result["results"][-1]["value"], "'module'")

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
        # Nothing above the break, so there is no prefix to load and the error
        # is the whole answer.
        result = self.load("def (\na = 1\n")
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["type"], "SyntaxError")
        self.assertEqual(result["range"]["start"]["line"], 0)

    def test_loading_an_empty_file_is_not_an_error(self):
        result = self.load("")
        self.assertTrue(result["ok"])
        self.assertEqual(result["statements"], 0)


class NamespaceResidue(KernelTest):
    """#100: what a non-resetting load's namespace holds that the file just
    read does not bind anywhere in its own text.

    `evaluate_file` itself never resets -- that is #99's job, on the caller's
    side of the pipe -- so these tests send `eval_file` directly, the way a
    kernel with `evalens.resetOnLoad` turned off would be driven.
    """

    def load(self, source, filename="/tmp/module.py", **kwargs):
        return self.k.send(op="eval_file", source=source, filename=filename,
                            **kwargs)

    def test_a_deleted_binding_is_residue_after_reloading_the_same_file(self):
        self.load("x = 1\n")
        result = self.load("y = 2\n")
        self.assertEqual(result.get("residue"), ["x"])

    def test_residue_is_not_scoped_to_the_file_that_made_it(self):
        # #56's sharper finding: an unrelated second file reads straight
        # through to the first file's leftovers, and its own residue set
        # says so.
        self.load("x = 100\n", filename="/tmp/a.py")
        result = self.load("z = 7\n", filename="/tmp/b.py")
        self.assertEqual(result.get("residue"), ["x"])

    def test_a_binding_the_file_still_makes_is_not_residue(self):
        result = self.load("x = 1\nx = 2\n")
        self.assertNotIn("residue", result)

    def test_a_fresh_namespace_reports_no_residue(self):
        result = self.load("x = 1\n")
        self.assertNotIn("residue", result)

    def test_a_reset_load_reports_no_residue(self):
        self.load("x = 1\n")
        self.assertTrue(self.k.send(op="reset")["ok"])
        result = self.load("y = 2\n")
        self.assertNotIn("residue", result)

    def test_a_selection_run_reports_no_residue(self):
        # A narrower question -- "run this part of my file" -- against which
        # nearly everything in the namespace would look like residue. Not the
        # fact this reports.
        self.load("x = 1\n")
        result = self.load("x = 1\ny = 2\n", start_line=1, end_line=1)
        self.assertNotIn("residue", result)

    def test_a_script_run_can_still_report_residue(self):
        # The kernel does not know a script run is unconditionally preceded
        # by a reset in the real product -- that is the extension's doing --
        # so driven on its own, as this test drives it, residue is reported
        # exactly as for an ordinary load.
        self.load("x = 1\n")
        result = self.load("y = 2\n", as_script=True)
        self.assertEqual(result.get("residue"), ["x"])


class ImportPath(KernelTest):
    """What the evaluated file can import, and what it must not be able to.

    Two halves of one property: the import path a user's file sees should be
    the one `python3 thatfile.py` would give it -- its own directory, and not
    the extension's. Both halves stay invisible until someone splits their code
    into two files, at which point the first is why nothing imports and the
    second is why the wrong thing does.
    """

    def setUp(self):
        super().setUp()
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        # Resolved, because on macOS the temporary directory is reached
        # through a symlink and the kernel reports where the file really is.
        self.dir = os.path.realpath(directory.name)
        self.main = os.path.join(self.dir, "main.py")

    def write(self, name, source):
        path = os.path.join(self.dir, name)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(source)
        return path

    def load(self, source, filename=None):
        return self.k.send(op="eval_file", source=source,
                           filename=filename or self.main)

    def test_a_file_can_import_the_module_beside_it(self):
        # The ticket's case, at its smallest. Before the fix this raised
        # ModuleNotFoundError with helper.py in the same directory, and every
        # statement naming anything from it failed after it.
        self.write("helper.py", "def greet():\n    return 'hi'\n")
        result = self.load("import helper\nhelper.greet()\n")
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["ran"], 2, result["results"])
        self.assertEqual(result["results"][1]["value"], "'hi'")

    def test_a_package_beside_the_file_imports(self):
        # A package rather than a module, because that is the shape of the
        # course file that exposed this and the two resolve differently.
        self.write("demo_pkg/__init__.py", "from .geometry import area\n")
        self.write("demo_pkg/geometry.py",
                   "def area(r):\n    return 3 * r * r\n")
        result = self.load("import demo_pkg\n"
                           "from demo_pkg.geometry import area\n"
                           "area(2)\n")
        self.assertEqual(result["ran"], 3, result["results"])
        self.assertEqual(result["results"][2]["value"], "12")

    def test_a_single_evaluation_gets_the_same_path_as_a_load(self):
        # Pressing a key on one import line makes the same promise as loading
        # the file it sits in, and the two go through different methods.
        self.write("helper.py", "VALUE = 41\n")
        source = "import helper\nhelper.VALUE + 1\n"
        self.k.evaluate(source, 0, filename=self.main)
        answer = self.k.evaluate(source, 1, filename=self.main)
        self.assertEqual(answer["value"], "42")

    def test_the_files_own_directory_is_first_on_the_path(self):
        # First, not merely present: a module of the user's shadows one of the
        # same name further down the path, which is what running the file
        # directly does and is occasionally the point of the exercise.
        result = self.load("import sys\nsys.path[0]\n")
        self.assertEqual(result["results"][1]["value"], repr(self.dir))

    def test_the_path_is_back_to_normal_between_requests(self):
        # Otherwise a session accumulates one entry per file evaluated, and
        # each file's imports start depending on which files were opened
        # before it -- the same accidental shadowing, harder to see.
        self.k.evaluate("import sys\nbefore = list(sys.path)\n", 0)
        self.k.evaluate("import sys\nbefore = list(sys.path)\n", 1)
        self.assertTrue(self.load("x = 1\n")["ok"])
        answer = self.k.evaluate("import sys\nbefore == sys.path\n", 1)
        self.assertEqual(answer["value"], "True")

    def test_the_path_survives_user_code_adding_to_it(self):
        # The entry is removed by identity for this reason: someone who put a
        # directory on sys.path from an evaluated line is entitled to keep it,
        # and deleting index 0 would take theirs instead of ours.
        self.load("import sys\nsys.path.insert(0, '/opt/mine')\n")
        answer = self.k.evaluate("import sys\nsys.path[0]\n", 1)
        self.assertEqual(answer["value"], "'/opt/mine'")

    def test_the_kernels_own_directory_is_not_on_the_path(self):
        # The second hazard: a directory on the path is a directory whose
        # modules can be imported by name, and these are not the user's.
        kernel_dir = os.path.realpath(os.path.dirname(KERNEL))
        source = ("import os, sys\n"
                  "[p for p in sys.path if os.path.realpath(p or '.') == "
                  f"{kernel_dir!r}]\n")
        self.assertEqual(self.k.evaluate_lines(source, 0, 1)["value"], "[]")

    def test_the_kernels_own_modules_are_not_importable(self):
        # Removing the directory is not enough on its own: an import consults
        # sys.modules first, and both of these were already in it under
        # exactly the names a user might pick.
        for name in ("resolver", "loops"):
            with self.subTest(module=name):
                answer = self.k.evaluate("import %s\n" % name, 0)
                self.assertFalse(answer["ok"], answer)
                self.assertEqual(
                    answer["error"]["type"], "ModuleNotFoundError")

    def test_a_users_module_named_like_the_kernels_wins(self):
        # The silent half of the defect. This used to succeed with Evalens'
        # own resolver bound to the name, so nothing raised and nothing looked
        # wrong -- the file simply used a module its author had never seen.
        self.write("resolver.py", "WHOSE = 'the user'\n")
        result = self.load("import resolver\nresolver.WHOSE\n")
        self.assertEqual(result["ran"], 2, result["results"])
        self.assertEqual(result["results"][1]["value"], "'the user'")

    def test_a_source_with_no_file_gets_no_path_entry(self):
        # An unsaved buffer has a title, not a location. Falling back to the
        # working directory would import from wherever the editor happened to
        # be launched, which differs between two windows opened the same way.
        self.k.evaluate("import sys\nbefore = list(sys.path)\n", 0)
        self.k.evaluate("import sys\nbefore = list(sys.path)\n", 1)
        self.k.send(op="eval_file", source="x = 1\n", filename="Untitled-1")
        answer = self.k.evaluate("import sys\nbefore == sys.path\n", 1)
        self.assertEqual(answer["value"], "True")


class PackageContext(KernelTest):
    """``__package__`` and the ``sys.path`` a real package member needs.

    Found while #92 was covering import shapes: opening a real package's own
    file directly -- ``demo_pkg/__init__.py``, or a plain submodule beside it
    -- and evaluating it hit ``from .geometry import area`` with no
    ``__package__`` in the namespace to resolve the dot against. `_as_module`
    already gave a load the file's own name (#70) and the file's own
    directory on ``sys.path`` (#69); this is the third thing a real ``import``
    would give it, verified against a real interpreter throughout rather than
    assumed, because `__name__` and `__package__` turn out to disagree by
    exactly one segment and it is easy to get that wrong from memory.

    A script run answers differently, on purpose: see
    `RunFileAsScript.test_a_script_run_over_a_package_member_gets_no_package_context`.
    """

    def setUp(self):
        super().setUp()
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.dir = os.path.realpath(directory.name)

    def write(self, name, source):
        path = os.path.join(self.dir, name)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(source)
        return path

    def load(self, filename, as_script=False):
        with open(filename, encoding="utf-8") as handle:
            source = handle.read()
        request = {"op": "eval_file", "source": source, "filename": filename}
        if as_script:
            request["as_script"] = True
        return self.k.send(**request)

    def test_a_packages_own_file_resolves_its_relative_imports(self):
        # The bug exactly as #92 found it: opening demo_pkg/__init__.py
        # itself, not importing it from a file beside it.
        init = self.write("demo_pkg/__init__.py",
                          "from .geometry import area\n")
        self.write("demo_pkg/geometry.py",
                   "def area(r):\n    return 3 * r * r\n")
        result = self.load(init)
        self.assertTrue(result["ok"], result)
        self.assertTrue(all(r["ok"] for r in result["results"]), result)
        answer = self.k.evaluate("area(2)\n", 0)
        self.assertEqual(answer["value"], "12")

    def test_a_plain_submodule_resolves_a_relative_import_to_a_sibling(self):
        self.write("demo_pkg/__init__.py", "")
        self.write("demo_pkg/geometry.py",
                   "def area(r):\n    return 3 * r * r\n")
        text = self.write(
            "demo_pkg/text.py",
            "from .geometry import area\ndescribed = area(2)\n")
        result = self.load(text)
        self.assertTrue(result["ok"], result)
        self.assertTrue(all(r["ok"] for r in result["results"]), result)

    def test_name_is_dotted_for_a_package_member(self):
        init = self.write("demo_pkg/__init__.py", "__name__\n")
        text = self.write("demo_pkg/text.py", "__name__\n")
        self.assertEqual(self.load(init)["results"][0]["value"], "'demo_pkg'")
        self.assertEqual(
            self.load(text)["results"][0]["value"], "'demo_pkg.text'")

    def test_package_matches_what_a_real_import_would_give(self):
        # Verified against a real `import demo_pkg` and `import
        # demo_pkg.geometry` before being written down here: a package's own
        # file is its own package, and a submodule's package stops one
        # segment short of its own name.
        init = self.write("demo_pkg/__init__.py", "__package__\n")
        geometry = self.write("demo_pkg/geometry.py", "__package__\n")
        self.assertEqual(self.load(init)["results"][0]["value"], "'demo_pkg'")
        self.assertEqual(
            self.load(geometry)["results"][0]["value"], "'demo_pkg'")

    def test_a_plain_top_level_file_has_no_package(self):
        # No real __init__.py beside it, so nothing above it was ever
        # consulted: `__package__` is `""`, on the same terms a real
        # top-level `import` gives one.
        main = self.write("main.py", "__package__\n")
        self.assertEqual(self.load(main)["results"][0]["value"], "''")

    def test_a_sibling_packages_init_does_not_leak_into_a_plain_file(self):
        # main.py sits beside demo_pkg/, not inside it: a package elsewhere
        # in the same directory must not be mistaken for one main.py is a
        # member of.
        self.write("demo_pkg/__init__.py", "")
        main = self.write("main.py", "__name__\n__package__\n")
        result = self.load(main)
        self.assertEqual(result["results"][0]["value"], "'main'")
        self.assertEqual(result["results"][1]["value"], "''")

    def test_multi_level_nesting_resolves_a_grandparent_relative_import(self):
        self.write("outer/__init__.py", "OUTER = 'outer'\n")
        leaf = self.write(
            "outer/inner/leaf.py",
            "from .. import OUTER\nVALUE = 42\n__name__\n__package__\n")
        self.write("outer/inner/__init__.py", "")
        result = self.load(leaf)
        self.assertTrue(result["ok"], result)
        self.assertTrue(all(r["ok"] for r in result["results"]), result)
        self.assertEqual(result["results"][-2]["value"], "'outer.inner.leaf'")
        self.assertEqual(result["results"][-1]["value"], "'outer.inner'")

    def test_a_normal_loads_path_is_the_package_root(self):
        # Not the file's own directory: `demo_pkg/` itself has no
        # `demo_pkg/demo_pkg/` inside it for a real `import demo_pkg` to
        # find, which is the ModuleNotFoundError this answers instead of
        # producing.
        init = self.write("demo_pkg/__init__.py", "import sys\nsys.path[0]\n")
        result = self.load(init)
        self.assertEqual(result["results"][1]["value"], repr(self.dir))


class ModuleName(KernelTest):
    """What ``__name__`` is, and everywhere the answer shows up.

    Python has two answers -- ``__main__`` for a file you run, the file's own
    name for one you import -- and the kernel used to give a third. Being
    neither is what made it visible: an invented name cannot be true of
    anything the user wrote, so every place Python prints a module name printed
    one that appears nowhere in their program.
    """

    def load(self, source, filename="/tmp/course/01_basics.py"):
        return self.k.send(op="eval_file", source=source, filename=filename)

    def value(self, source, filename="/tmp/course/01_basics.py"):
        return self.load(source, filename)["results"][-1]["value"]

    def test_the_module_is_named_after_its_file(self):
        self.assertEqual(self.value("__name__\n"), "'01_basics'")

    def test_a_single_evaluation_is_named_the_same_way(self):
        answer = self.k.evaluate("__name__\n", 0,
                                 filename="/tmp/course/01_basics.py")
        self.assertEqual(answer["value"], "'01_basics'")

    def test_a_package_init_is_named_after_its_directory(self):
        # What Python calls a package: the file is only how it opens.
        self.assertEqual(
            self.value("__name__\n", "/tmp/course/demo_pkg/__init__.py"),
            "'demo_pkg'")

    def test_a_source_with_no_file_keeps_the_placeholder(self):
        # An unsaved buffer has no module and therefore no name for one, and
        # saying so is better than inventing a plausible-looking name.
        self.assertEqual(self.k.evaluate("__name__\n", 0)["value"],
                         "'__evalens__'")

    def test_the_main_guard_still_does_not_fire(self):
        # The point of naming the module after the file rather than
        # __main__: the leaks close and a load still does not run code the
        # author marked as "only when run directly". Running it deliberately
        # is issue #78 run-file-as-script.
        loaded = self.load("if __name__ == '__main__':\n    ran = True\n")
        self.assertTrue(loaded["ok"])
        missing = self.k.evaluate("ran\n", 0)
        self.assertFalse(missing["ok"], missing)
        self.assertEqual(missing["error"]["type"], "NameError")

    def test_an_annotation_names_the_module_the_source_is_in(self):
        # The 09_type_hints.py symptom, and the file where the annotation text
        # IS the lesson. The student wrote `x: Named`; they were shown
        # `x: __evalens__.Named`.
        shown = self.value("class Named:\n    pass\n"
                           "def welcome(x: Named) -> str:\n"
                           "    return 'hi'\n")
        # The name, not the whole signature: how a signature is spelled is
        # somebody else's decision and this test should not break with it.
        self.assertIn("x: 01_basics.Named", shown)
        self.assertNotIn("__evalens__", shown)

    def test_an_instances_repr_names_the_module_its_class_is_in(self):
        # A plain instance is described rather than shown by address, and the
        # untouched repr rides along beside it -- which is where the name
        # leaked from, and what the hover puts on screen.
        loaded = self.load("class Version:\n    pass\nv = Version()\n")
        self.assertEqual(loaded["results"][-1]["value"], "<Version instance>")
        self.assertIn("01_basics.Version", loaded["results"][-1]["repr"])

    def test_a_container_of_instances_is_described_like_a_top_level_one(self):
        # #73: a tuple has a repr of its own, so the top-level substitution
        # never reached its members and their addresses reached the screen
        # whole. Fixed by describing each element the bounded repr walks,
        # not by describing the tuple.
        shown = self.value("class Version:\n    pass\n(Version(),)\n")
        self.assertEqual(shown, "(<Version instance>,)")
        self.assertNotIn("01_basics.Version object at", shown)

    def test_a_class_knows_which_module_defined_it(self):
        # The attribute every one of the above reads. `__module__` is captured
        # when the class is created, so it is the name that was current then.
        self.assertEqual(
            self.value("class Version:\n    pass\nVersion.__module__\n"),
            "'01_basics'")


class RunFileAsScript(KernelTest):
    """``eval_file`` with ``as_script: true`` -- issue #78.

    The one flag that decides whether ``__name__`` is the file's own name (a
    load, and every ``eval_file`` before this ticket) or ``"__main__"`` (a
    script run), which is the one thing that decides whether an
    ``if __name__ == "__main__":`` guard fires. Everything else about the
    request is `LoadFile`'s behaviour, unchanged.
    """

    GUARD = "if __name__ == '__main__':\n    ran = True\n"

    def load(self, source, as_script=False, filename="/tmp/course/10_demo.py"):
        request = {"op": "eval_file", "source": source, "filename": filename}
        if as_script:
            request["as_script"] = True
        return self.k.send(**request)

    def test_the_guard_fires_only_when_asked_to_run_as_a_script(self):
        # The ticket's own acceptance test: one source, one flag, and the
        # namespace either has `ran` or it does not.
        loaded = self.load(self.GUARD)
        self.assertTrue(loaded["ok"], loaded)
        missing = self.k.evaluate("ran\n", 0)
        self.assertFalse(missing["ok"], missing)
        self.assertEqual(missing["error"]["type"], "NameError")

        ran = self.load(self.GUARD, as_script=True)
        self.assertTrue(ran["ok"], ran)
        bound = self.k.evaluate("ran\n", 0)
        self.assertTrue(bound["ok"], bound)
        self.assertEqual(bound["value"], "True")

    def test_name_is_dunder_main_for_a_script_run(self):
        self.assertEqual(
            self.load("__name__\n", as_script=True)["results"][-1]["value"],
            "'__main__'")

    def test_name_is_still_the_files_own_name_otherwise(self):
        # Pinned beside the case above: the two requests differ in exactly
        # one field, so the two answers had better differ in exactly the one
        # way that field explains.
        self.assertEqual(
            self.load("__name__\n")["results"][-1]["value"], "'10_demo'")

    def test_argv_is_the_file_for_a_script_run(self):
        result = self.load(
            "import sys\nsys.argv\n", as_script=True,
            filename="/tmp/course/10_demo.py")
        self.assertEqual(
            result["results"][-1]["value"], "['/tmp/course/10_demo.py']")

    def test_argv_is_untouched_by_an_ordinary_load(self):
        before = self.k.evaluate("import sys\nlist(sys.argv)\n", 0)
        self.load("import sys\n")
        after = self.k.evaluate("import sys\nlist(sys.argv)\n", 0)
        self.assertEqual(after["value"], before["value"])

    def test_argv_is_restored_once_the_script_run_is_over(self):
        before = self.k.evaluate("import sys\nlist(sys.argv)\n", 0)
        self.load("import sys\n", as_script=True)
        after = self.k.evaluate("import sys\nlist(sys.argv)\n", 0)
        self.assertEqual(after["value"], before["value"])

    def test_a_script_run_does_not_reset_the_namespace(self):
        # Whatever an earlier load or evaluation bound is still there going
        # into a script run: this is Load File with one bit flipped, not a
        # second command with its own rules about what survives.
        self.k.evaluate("kept = 'from an earlier load'\n", 0)
        result = self.load("kept\n", as_script=True)
        self.assertEqual(result["results"][-1]["value"],
                         "'from an earlier load'")

    def test_running_as_a_script_twice_just_runs_the_file_twice(self):
        # No special-casing a second run: the guard's body re-executes, the
        # same way pressing Evaluate File twice re-runs an ordinary load.
        source = "counter = globals().get('counter', 0) + 1\n" + self.GUARD
        self.load(source, as_script=True)
        self.load(source, as_script=True)
        self.assertEqual(self.k.evaluate("counter\n", 0)["value"], "2")

    def test_a_script_run_after_an_ordinary_load_still_fires_the_guard(self):
        self.load(self.GUARD)
        missing = self.k.evaluate("ran\n", 0)
        self.assertFalse(missing["ok"])

        self.load(self.GUARD, as_script=True)
        bound = self.k.evaluate("ran\n", 0)
        self.assertTrue(bound["ok"], bound)

    def test_the_dead_guard_says_so_on_an_ordinary_load(self):
        # #78's minimum: the fact costs nothing to say and is said regardless
        # of whether the full command is ever reached for.
        result = self.load(self.GUARD)
        guard = result["results"][0]
        self.assertTrue(guard["ok"])
        self.assertEqual(
            guard["value"],
            "False -- not run as a script (Evalens: Run File as Script)")

    def test_the_dead_guard_annotation_is_silent_once_the_guard_runs(self):
        # The override only ever applies to a guard that cannot fire; once it
        # can and does, the ordinary "no value" answer for an `If` applies,
        # exactly as it would for any other compound statement.
        result = self.load(self.GUARD, as_script=True)
        guard = result["results"][0]
        self.assertTrue(guard["ok"])
        self.assertIsNone(guard["value"])

    def test_the_dead_guard_annotation_is_silent_for_a_dunder_main_file(self):
        # The one case an ordinary load's guard is not dead: `_module_name`
        # answers "__main__" on its own for a file literally named
        # `__main__.py`, the same way `python -m thatpackage` would. The
        # override checks `self.namespace["__name__"]` as it actually stands
        # rather than assuming the guard is always False on a load, and this
        # is the case that assumption would have gotten wrong.
        result = self.load(self.GUARD, filename="/tmp/course/pkg/__main__.py")
        guard = result["results"][0]
        self.assertTrue(guard["ok"])
        self.assertIsNone(guard["value"])
        bound = self.k.evaluate("ran\n", 0)
        self.assertTrue(bound["ok"], bound)

    def test_a_guard_that_is_not_the_idiom_is_left_alone(self):
        # Deliberately narrow: a `!=` guard is a different statement with a
        # different truth value, and must not be relabelled as the dead one.
        result = self.load(
            "if __name__ != '__main__':\n    ran = True\n")
        guard = result["results"][0]
        self.assertTrue(guard["ok"])
        self.assertIsNone(guard["value"])

    def test_a_script_run_over_a_package_member_gets_no_package_context(self):
        # `python3 pkg/mod.py` gives __package__ None -- verified against a
        # real interpreter -- never the enclosing package `PackageContext`
        # gives an ordinary load, however many real __init__.py files
        # surround the file. Imitating `python3 <file>` means imitating this
        # too, relative import failure and all: see #78's design note on
        # which of `python -m` and `python file.py` a script run stands in
        # for.
        with tempfile.TemporaryDirectory() as directory:
            real_dir = os.path.realpath(directory)
            os.makedirs(os.path.join(real_dir, "demo_pkg"))
            init = os.path.join(real_dir, "demo_pkg", "__init__.py")
            with open(init, "w", encoding="utf-8") as handle:
                handle.write("from .geometry import area\n")
            with open(os.path.join(real_dir, "demo_pkg", "geometry.py"),
                      "w", encoding="utf-8") as handle:
                handle.write("def area(r):\n    return 3 * r * r\n")

            result = self.load(
                "from .geometry import area\n", as_script=True, filename=init)
            self.assertFalse(result["ok"] and result["results"][0]["ok"],
                             result)
            failure = result["results"][0]
            self.assertEqual(failure["error"]["type"], "ImportError")

    def test_a_script_runs_path_is_the_files_own_directory(self):
        # Not the package root a load would use: `python3 <file>` puts the
        # file's own directory at sys.path[0] regardless of any package
        # around it, verified against a real interpreter, and a script run
        # answers the same way on purpose.
        with tempfile.TemporaryDirectory() as directory:
            real_dir = os.path.realpath(directory)
            pkg_dir = os.path.join(real_dir, "demo_pkg")
            os.makedirs(pkg_dir)
            init = os.path.join(pkg_dir, "__init__.py")
            with open(init, "w", encoding="utf-8") as handle:
                handle.write("")

            result = self.load(
                "import sys\nsys.path[0]\n", as_script=True, filename=init)
            self.assertEqual(result["results"][1]["value"], repr(pkg_dir))

    def test_a_spawned_worker_still_cannot_find_a_script_runs_function(self):
        """#80, pinned rather than fixed: multiprocessing stays broken here.

        The question, before any fix was written: does making `__name__`
        `"__main__"` for a script run -- everything `as_script` already
        does -- let a `multiprocessing` worker actually find a function
        this run defined? A spike outside this suite answered it
        empirically, against both start methods and against the real
        `10_concurrency.py` this bug was filed against, by additionally
        registering the run's own namespace as `sys.modules["__main__"]`
        for the duration (a change this ticket does not make, precisely
        because of what follows).

        `fork` says yes: a forked worker is the parent's whole memory,
        `sys.modules["__main__"]` included, so the registration finds the
        function every time. `spawn` -- what this audience's Python has
        defaulted to since 3.8, and what `ctx` below forces regardless of
        which platform runs this test -- says no on both branches of the
        registration. With no `__file__` on the namespace (the kernel does
        not set one for a script run; see `_as_module`), `spawn`'s
        bootstrap has no path to re-import and the worker's `__main__`
        stays empty. Given one, the only way `spawn` can rebuild the
        function is by re-running the *file on disk* in the worker, which
        silently diverges from whatever buffer this run actually evaluated
        the moment the two disagree -- an unsaved edit, or no file at all
        -- trading today's clear `PicklingError` for a wrong answer nobody
        asked to see, exactly the failure design rule 1 exists to rule
        out. So the registration was not made, and this pins the plain
        failure instead: the same one Jupyter and IPython hit for the
        identical reason, kept clear rather than made silently wrong.
        """
        source = (
            "import multiprocessing\n"
            "def square(n):\n"
            "    return n * n\n"
            "ctx = multiprocessing.get_context('spawn')\n"
            "with ctx.Pool(1) as pool:\n"
            "    pool.map(square, [1, 2, 3])\n"
        )
        result = self.load(source, as_script=True)
        self.assertTrue(result["ok"], result)
        failure = result["results"][-1]
        self.assertFalse(failure["ok"], failure)
        self.assertEqual(failure["error"]["type"], "PicklingError")


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


class Outline(KernelTest):
    """Where the statements are, for a walk that steps by statements.

    The whole reason this op exists rather than a scan of line text on the
    extension side: only the parser knows that a comment inside a list literal
    is not a gap between statements, that a decorator belongs to the `def`
    under it, and that a ten-line body is one step.
    """

    def outline(self, source):
        return self.k.send(op="outline", source=source,
                           filename="/tmp/module.py")

    def test_every_top_level_statement_is_reported_once(self):
        result = self.outline("a = 1\nb = 2\nc = 3\n")
        self.assertTrue(result["ok"], result)
        self.assertEqual(
            [s["range"]["start"]["line"] for s in result["statements"]],
            [0, 1, 2])

    def test_a_body_is_part_of_its_statement_not_a_statement(self):
        # The case that decides the feature: eleven lines, one step.
        result = self.outline(
            "def area(w, h):\n"
            "    scaled = w * h\n"
            "    return scaled\n"
            "\n"
            "area(3, 4)\n")
        spans = [(s["range"]["start"]["line"], s["range"]["end"]["line"])
                 for s in result["statements"]]
        self.assertEqual(spans, [(0, 2), (4, 4)])

    def test_a_decorated_definition_starts_at_its_decorator(self):
        # `FunctionDef.lineno` points at the `def`, so a walk that used it
        # would drop the cursor below the decorator it is about to run.
        result = self.outline("@shout\ndef greeting():\n    return 'ok'\n")
        span = result["statements"][0]
        self.assertEqual(span["range"]["start"]["line"], 0)
        self.assertEqual(span["range"]["end"]["line"], 2)

    def test_the_anchor_is_the_one_an_evaluation_would_report(self):
        # Stepping and evaluating have to agree about where a statement is,
        # and they do because one parser answers both.
        source = "def area(w, h):\n    return w * h\n"
        outlined = self.outline(source)["statements"][0]
        evaluated = self.k.evaluate(source, 0)
        self.assertEqual(outlined["anchor"], evaluated["anchor"])
        self.assertEqual(outlined["range"], evaluated["range"])
        self.assertEqual(outlined["kind"], evaluated["kind"])

    def test_a_comment_inside_a_statement_does_not_split_it(self):
        result = self.outline(
            "matrix = [\n"
            "    [1, 2],\n"
            "    # a comment in the middle of a statement\n"
            "    [3, 4],\n"
            "]\n")
        self.assertEqual(len(result["statements"]), 1)
        self.assertEqual(result["statements"][0]["range"]["end"]["line"], 4)

    def test_nothing_runs(self):
        # An outline is asked for on every press of Evaluate and Advance. If it
        # executed anything, the command that exists to walk a file would run
        # each statement twice -- and a question about the shape of a file
        # would become a reason to trigger side effects.
        self.assertTrue(self.outline("marker = 'ran'\n")["ok"])
        after = self.k.evaluate("marker\n", 0)
        self.assertFalse(after["ok"])
        self.assertEqual(after["error"]["type"], "NameError")

    def test_a_file_of_comments_outlines_to_nothing(self):
        result = self.outline("\n# only a comment\n\n")
        self.assertTrue(result["ok"])
        self.assertEqual(result["statements"], [])

    def test_a_syntax_error_is_reported_with_its_position(self):
        result = self.outline("a = 1\ndef (\n")
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["type"], "SyntaxError")
        self.assertEqual(result["range"]["start"]["line"], 1)


class BrokenElsewhere(KernelTest):
    """A syntax error somewhere else does not make every line unevaluable.

    `ast` is all-or-nothing, so before this the whole file went dark the moment
    one line went half-typed -- which is precisely the state a file is in while
    someone is evaluating things in it. The kernel now answers from as much of
    the buffer as parses, says so, and reports the break on the line that
    caused it.
    """

    #: A file whose last line is being typed. Twelve good statements, then the
    #: opening quote of a string nobody has finished.
    SOURCE = "".join(f"x{n} = {n}\n" for n in range(1, 13)) + 's = "half-typ\n'
    BREAK = 12

    def evaluate(self, line, source=None):
        return self.k.evaluate(
            self.SOURCE if source is None else source, line,
            filename="/tmp/broken.py")

    def test_a_valid_line_evaluates_with_a_broken_last_line(self):
        result = self.evaluate(0)
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["value"], "1")

    def test_the_answer_says_it_was_computed_without_the_whole_file(self):
        # A value from a reduced context is a weaker claim than a value from
        # the whole file, and the two must not paint identically.
        partial = self.evaluate(0)["partial"]
        self.assertEqual(partial["truncated_at"], self.BREAK)
        self.assertEqual(partial["error"]["type"], "SyntaxError")

    def test_the_break_is_reported_where_the_break_is(self):
        # The half of the complaint that costs the most. The break is reported
        # at the line that caused it, so the reader is sent to the fix rather
        # than to whichever line they happened to press a key on.
        #
        # Asserted on the reported position, never on the message's wording.
        # CPython rephrases its syntax errors between releases and only some
        # years put the line number in the text at all -- 3.9 says "EOL while
        # scanning string literal" and 3.12 onwards says "unterminated string
        # literal (detected at line 13)". The position is on the wire either
        # way, it is what the extension paints with, and it is the actual
        # subject of this test.
        result = self.evaluate(0)
        partial = result["partial"]
        self.assertEqual(partial["range"]["start"]["line"], self.BREAK)
        self.assertEqual(partial["range"]["end"]["line"], self.BREAK)
        # The two accounts of where parsing stopped agree: the range the red
        # annotation is painted on, and the line the caveat counts from.
        self.assertEqual(partial["truncated_at"], self.BREAK)
        # And it lands on the break rather than on the cursor, which is the
        # whole complaint -- line 1 was evaluated and is not where this points.
        self.assertNotEqual(
            partial["range"]["start"]["line"],
            result["range"]["start"]["line"])
        # There is still a message to paint, whatever this year's wording is.
        self.assertTrue(partial["error"]["message"])

    def test_a_line_that_parses_whole_carries_no_caveat_at_all(self):
        # Absence is the signal, so it has to be genuinely absent: a reader of
        # the wire must not be able to mistake "full context" for "nobody
        # filled this in".
        self.assertNotIn("partial", self.evaluate(0, "a = 1\nb = 2\n"))

    def test_a_syntax_error_under_the_cursor_reports_normally(self):
        # The fallback is for a break somewhere else. A broken statement where
        # you are pointing is a real answer, not an obstacle.
        result = self.evaluate(self.BREAK)
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["type"], "SyntaxError")
        self.assertEqual(result["range"]["start"]["line"], self.BREAK)
        self.assertNotIn("partial", result)

    def test_a_break_above_the_cursor_reports_rather_than_guesses(self):
        # Truncating from the end cannot reach past a break to the lines below
        # it, and inventing a context for them would be answering a question
        # nobody asked. The error is the honest answer.
        source = "a = 1\ndef (\nb = 2\n"
        result = self.evaluate(2, source)
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["type"], "SyntaxError")

    def test_the_namespace_still_gets_what_the_line_bound(self):
        # A partial answer is a real evaluation, not a preview of one.
        self.evaluate(3)
        self.assertEqual(self.evaluate(3)["value"], "4")

    def test_a_blank_line_still_reports_the_break(self):
        # Nothing to evaluate here is not nothing to say: the file is broken,
        # and that is worth knowing whichever line the cursor is on.
        source = "a = 1\n\n" + 's = "half-typ\n'
        result = self.evaluate(1, source)
        self.assertTrue(result["ok"])
        self.assertFalse(result["resolved"])
        self.assertEqual(result["partial"]["truncated_at"], 2)

    def test_a_load_takes_the_part_that_parses(self):
        # #25 settled that a broken line must not stop a load. A line that does
        # not parse is the same argument one step earlier, and refusing the
        # whole file over a half-typed line at the bottom is how the command
        # that sets up a session comes to need the session already set up.
        result = self.k.send(op="eval_file", source=self.SOURCE,
                             filename="/tmp/broken.py")
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["statements"], self.BREAK)
        self.assertEqual(result["ran"], self.BREAK)
        self.assertEqual(result["partial"]["truncated_at"], self.BREAK)
        # The bindings are really there, which is the whole point of loading.
        self.assertEqual(self.k.evaluate("x12\n", 0)["value"], "12")

    def test_a_load_of_a_file_that_parses_carries_no_caveat(self):
        result = self.k.send(op="eval_file", source="a = 1\nb = 2\n",
                             filename="/tmp/fine.py")
        self.assertNotIn("partial", result)

    def test_a_definition_below_the_break_is_simply_not_there(self):
        # The honest consequence of a reduced context, and the reason it has to
        # be visible: the failure looks like a typo and is not one.
        source = "a = 1\ndef helper():\n    return 2\nb = helper(\n"
        result = self.evaluate(0, source)
        self.assertEqual(result["partial"]["truncated_at"], 3)
        after = self.evaluate(1, source)
        self.assertTrue(after["ok"], after)
        self.assertEqual(after["display"], "helper")


class SelectionInABrokenFile(KernelTest):
    """A selection evaluated in a file that does not parse.

    Neither the narrowing nor the fallback anticipated the other, and the order
    they compose in is not a preference. Narrowing snaps outward to statement
    boundaries; boundaries only exist inside a tree; for a broken file only
    `parse_prefix` produces one. So the file is parsed first and the selection
    is applied *inside what parsed*, and every case below is a consequence of
    that rather than a rule written separately.

    The consequence to be most careful about is the empty one. A selection
    lying below the break matches nothing, and the tempting repair -- run the
    prefix, there is something runnable right there -- is the exact failure
    both features exist to prevent: executing code the user did not select.
    """

    #: 0: docstring  1: a  2-4: def f  5: c  6: "hello"  7: d
    #: 8: the half-typed line, and 9-10 below it looking perfectly runnable.
    SOURCE = ('"""Module docstring."""\n'
              "a = 1\n"
              "def f(x):\n"
              "    y = x + 1\n"
              "    return y\n"
              "c = f(1)\n"
              '"hello"\n'
              "d = 2\n"
              's = "half-typ\n'
              "t = 3\n"
              "u = 4\n")
    BREAK = 8

    def load(self, start=None, end=None, source=None):
        request = {"op": "eval_file",
                   "source": self.SOURCE if source is None else source,
                   "filename": "/tmp/broken.py"}
        if start is not None:
            request["start_line"] = start
        if end is not None:
            request["end_line"] = end
        return self.k.send(**request)

    def bound(self, name):
        """What the namespace holds for `name`, or the error type instead."""
        result = self.k.evaluate(name + "\n", 0)
        return result["value"] if result["ok"] else result["error"]["type"]

    def test_a_selection_above_the_break_runs_and_says_it_was_narrowed(self):
        result = self.load(1, 1)
        self.assertTrue(result["ok"], result)
        self.assertEqual((result["statements"], result["ran"]), (1, 1))
        self.assertEqual(self.bound("a"), "1")
        self.assertEqual(result["partial"]["truncated_at"], self.BREAK)

    def test_a_selection_below_the_break_runs_nothing(self):
        # The whole composition in one assertion. There are eight parsed
        # statements sitting above this selection and not one of them may run:
        # the user pointed at lines 10-11, and code they did not point at is
        # what both the narrowing and the fallback exist to refuse.
        result = self.load(9, 10)
        self.assertTrue(result["ok"], "nothing to run is an outcome")
        self.assertEqual((result["statements"], result["ran"]), (0, 0))
        self.assertEqual(result["results"], [])
        self.assertEqual(self.bound("a"), "NameError",
                         "the prefix must not have run instead")

    def test_a_selection_below_the_break_says_why_nothing_ran(self):
        # Silence here would read as "your selection held only comments". The
        # reason is the break, and the break is on the wire.
        result = self.load(9, 10)
        self.assertEqual(result["partial"]["truncated_at"], self.BREAK)
        self.assertEqual(result["partial"]["error"]["type"], "SyntaxError")
        self.assertNotIn("range", result,
                         "nothing ran, so there is no span that ran")

    def test_a_selection_spanning_the_break_runs_the_part_above_it(self):
        # Lines 8-9 are `d = 2` and the half-typed line. The first is a whole
        # statement in the prefix and runs; the second is not in the tree at
        # all and cannot.
        result = self.load(7, 8)
        self.assertEqual((result["statements"], result["ran"]), (1, 1))
        self.assertEqual(self.bound("d"), "2")
        self.assertEqual(self.bound("s"), "NameError")

    def test_what_ran_and_where_parsing_stopped_are_separate_facts(self):
        # Two different numbers about two different things, and neither can be
        # computed from the other: the run ended at line 7 because that is
        # where the last selected statement ended, and parsing stopped at line
        # 8 because that is where the file broke.
        result = self.load(7, 8)
        self.assertEqual(result["range"]["end"]["line"], 7)
        self.assertEqual(result["partial"]["truncated_at"], self.BREAK)

    def test_the_snap_outward_still_works_inside_the_prefix(self):
        # Lines 4-5 are the body of `f`. Truncating the file did not cost the
        # selection its statement boundaries, because it is applied to the
        # tree rather than to the text.
        result = self.load(3, 4)
        self.assertEqual(result["ran"], 1)
        self.assertEqual(result["range"]["start"], {"line": 2, "character": 0})
        # `def f(x)` rather than `f(x)`: a description leads with Python's own
        # keyword, which is the part a bare signature cannot say.
        self.assertEqual(self.bound("f"), "def f(x)")

    def test_a_selected_string_in_a_broken_file_is_not_a_docstring(self):
        # `first_in_body` is decided against the module body, and the module
        # body is the prefix's -- which still starts with the real docstring on
        # line 0, so the string on line 6 is a value like any other.
        result = self.load(6, 6)
        self.assertEqual(result["results"][0]["value"], "'hello'")

    def test_a_half_stated_range_in_a_broken_file_still_runs_nothing(self):
        # Two ways of arriving at "run nothing" at once. Neither may be
        # answered by falling back to the part that happens to be runnable.
        result = self.load(start=0)
        self.assertTrue(result["ok"])
        self.assertEqual(result["statements"], 0)
        self.assertEqual(result["partial"]["truncated_at"], self.BREAK)
        self.assertEqual(self.bound("a"), "NameError")

    def test_a_selection_in_a_file_that_parses_says_nothing_about_partial(self):
        # Absence is the signal, and narrowing must not manufacture one.
        result = self.load(0, 0, source="a = 1\nb = 2\n")
        self.assertNotIn("partial", result)
        self.assertEqual(result["ran"], 1)


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
        self.assertEqual(result["value"], "def area(w, h)")
        self.assertNotRegex(result["value"], self.ADDRESS)

    def test_a_function_says_it_is_one_the_way_a_class_does(self):
        # Replacing the address with a signature removed the noise and also the
        # one word that said what kind of thing this was, while classes kept
        # Python's own keyword -- an inconsistency inside this feature rather
        # than a missing feature. It matters most where the line does not
        # already say it: `f = area` reads `f: def area(w, h)`, which is what
        # tells the reader what `f` now is.
        source = "def area(w, h):\n    return w * h\nf = area\n"
        self.assertEqual(self.show(source)["value"], "def area(w, h)")

    def test_a_bound_method_is_described_as_a_function_too(self):
        # Nothing is special-cased to a module-level def: the same rule answers
        # for anything Python calls a routine.
        result = self.show("class Box:\n"
                           "    def put(self, item):\n"
                           "        pass\n"
                           "handle = Box().put\n")
        self.assertEqual(result["value"], "def Box.put(item)")

    def test_the_untouched_repr_is_still_available(self):
        # Nothing is lost by describing: the extension puts this on the hover.
        result = self.show("def area(w, h):\n    return w * h\n")
        self.assertRegex(result["repr"], r"^<function area at 0x[0-9a-f]+>$")

    def test_annotations_and_defaults_come_through(self):
        result = self.show(
            "def area(w: int, h: int = 2) -> int:\n    return 1\n")
        self.assertEqual(result["value"], "def area(w: int, h: int = 2) -> int")

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
        self.assertEqual(
            result["value"], "def call(a, *args, key=None, **kwargs)")

    def test_a_generator_function_says_what_calling_it_returns(self):
        # The trap worth surfacing: this is the explanation for why iterating
        # the result a second time found it empty.
        result = self.show("def counted(n):\n    yield n\n")
        self.assertEqual(result["value"], "def counted(n) -> generator")

    def test_a_coroutine_function_says_so_too(self):
        result = self.show("async def fetch(url):\n    return url\n")
        self.assertEqual(result["value"], "def fetch(url) -> coroutine")

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
            "def min(iterable, *[, default=obj, key=func]) -> value")
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
        self.assertEqual(first, "def area(w, h)")

    def test_re_binding_an_instance_gives_the_same_annotation(self):
        source = ("class Config:\n"
                  "    pass\n"
                  "cfg = Config()\n")
        self.k.evaluate_lines(source, 0, 2)
        for _ in range(2):
            self.assertEqual(
                self.k.evaluate(source, 2)["value"], "<Config instance>")


class DescriptionsInsideContainers(KernelTest):
    """#73: the same substitution `Descriptions` proves at the top level,
    reached for a value found *inside* a list, tuple, dict or set.

    A container writes its own ``__repr__``, so nothing about it triggers
    the top-level substitution in `wire_value` -- the fix has to happen
    while the container's own repr is being built, for each element it
    walks, which is what `_BoundedRepr._describe_element` is for.
    """

    ADDRESS = re.compile(r"0x[0-9a-fA-F]+")

    def show(self, source):
        lines = range(len(source.rstrip("\n").split("\n")))
        return self.k.evaluate_lines(source, *lines)

    def test_a_list_of_functions_names_each_one_instead_of_its_address(self):
        result = self.show(
            "def greet(name):\n    pass\ndef bye(name):\n    pass\n"
            "[greet, bye]\n")
        self.assertEqual(result["value"], "[def greet(name), def bye(name)]")
        self.assertNotRegex(result["value"], self.ADDRESS)

    def test_a_dict_of_plain_instances_is_described_by_value(self):
        result = self.show(
            "class Config:\n    pass\n"
            "{'a': Config(), 'b': Config()}\n")
        self.assertEqual(
            result["value"],
            "{'a': <Config instance>, 'b': <Config instance>}")
        self.assertNotRegex(result["value"], self.ADDRESS)

    def test_a_generator_inside_a_container_names_its_function(self):
        result = self.show(
            "def greet_all():\n    yield 'hi'\n[greet_all()]\n")
        self.assertEqual(result["value"], "[<generator greet_all>]")
        self.assertNotRegex(result["value"], self.ADDRESS)

    def test_a_generator_alone_is_described_the_same_way(self):
        # Not a container case, but the other half of #73: this reaches
        # `describe` directly through `wire_value`, never through
        # `_BoundedRepr` at all.
        result = self.show(
            "def greet_all():\n    yield 'hi'\ngreet_all()\n")
        self.assertEqual(result["value"], "<generator greet_all>")

    def test_describing_a_generator_never_advances_it(self):
        # The sharp case #73 names: consuming a generator to describe it
        # would destroy the value the annotation claims to be showing.
        source = ("def counter():\n"
                  "    yield 1\n    yield 2\n"
                  "gen = counter()\n"
                  "gen\n"
                  "next(gen)\n")
        self.k.evaluate_lines(source, 0, 3)
        described = self.k.evaluate(source, 4)["value"]
        self.assertEqual(described, "<generator counter>")
        self.assertEqual(self.k.evaluate(source, 5)["value"], "1")

    def test_a_coroutine_inside_a_container_names_its_function(self):
        source = ("async def fetch(url):\n    return url\n"
                  "coro = fetch('x')\n"
                  "[coro]\n"
                  "coro.close()\n")
        result = self.k.evaluate_lines(source, 0, 2, 3)
        self.assertEqual(result["value"], "[<coroutine fetch>]")
        # Close it rather than leave it to the garbage collector, so the
        # test does not print "coroutine was never awaited" of its own.
        self.k.evaluate(source, 4)

    def test_a_nested_container_describes_every_level(self):
        result = self.show(
            "def greet(name):\n    pass\n"
            "[{'f': greet}]\n")
        self.assertEqual(result["value"], "[{'f': def greet(name)}]")

    def test_a_hand_written_repr_inside_a_list_is_left_untouched(self):
        # The one rule this must not break, proven again one level down:
        # a `__repr__` someone wrote is used exactly as it is at the top.
        result = self.show(
            "class Money:\n"
            "    def __repr__(self):\n"
            "        return '$4.00'\n"
            "[Money(), Money()]\n")
        self.assertEqual(result["value"], "[$4.00, $4.00]")

    def test_a_list_subclass_of_instances_is_still_walked_as_a_list(self):
        # The type-identity rule `describe` and `_BoundedRepr` both use:
        # `Stack` keeps its own bounded repr because it never wrote a
        # `__repr__` of its own, and its *elements* still get described.
        result = self.show(
            "class Stack(list):\n    pass\n"
            "def greet(name):\n    pass\n"
            "Stack([greet])\n")
        self.assertEqual(result["value"], "[def greet(name)]")


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
            self.assertIn("more chars)", value)

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


class LoopBodyBindings(KernelTest):
    """What a loop computed, not only what it was handed.

    The target is usually the input being iterated and the name the body binds
    is usually the result. Reporting the input's whole history beside the
    result's final value -- in the same style, side by side -- is exactly
    backwards, and one of them then reads as the other's last entry.
    """

    def bindings(self, result):
        return [(b["name"], b["values"], b["count"]) for b in
                result.get("bindings", [])]

    def test_a_body_binding_reports_every_value_it_took(self):
        # The ticket's example, through the real kernel. stdout said 4, 8 and
        # 12; the annotation said `u: 12`.
        source = ("x = [1, 2, 3]\n"
                  "for v in x:\n"
                  "    u = 4 * v\n"
                  "    print('value is ' + str(u))\n")
        result = self.k.evaluate_lines(source, 0, 1)
        self.assertEqual(result["stdout"],
                         "value is 4\nvalue is 8\nvalue is 12\n")
        self.assertEqual(result["loop"]["values"], ["1", "2", "3"])
        self.assertEqual(self.bindings(result), [("u", ["4", "8", "12"], 3)])

    def test_a_binding_is_not_also_reported_as_a_name(self):
        # It would appear twice on one line otherwise -- once as the sequence
        # it took, once as where it stopped -- and the second reads as a
        # correction of the first.
        result = self.k.evaluate("for v in [1, 2, 3]:\n    u = 4 * v\n", 0)
        self.assertNotIn("u", [pair["name"] for pair in
                               result.get("names", [])])

    def test_an_iteration_that_continued_has_nothing_to_contribute(self):
        # The acceptance case for unequal lengths: three iterations of the
        # target, two results. Anything that renders these as parallel columns
        # is wrong the first time someone writes a filter loop.
        result = self.k.evaluate(
            "for v in [1, 2, 3]:\n    if v == 2:\n        continue\n"
            "    u = 4 * v\n", 0)
        self.assertEqual(result["loop"]["count"], 3)
        self.assertEqual(self.bindings(result), [("u", ["4", "12"], 2)])

    def test_an_unchanging_binding_is_reported_once(self):
        result = self.k.evaluate(
            "for v in [1, 2, 3, 4]:\n    c = 7\n", 0)
        self.assertEqual(result["bindings"],
                         [{"name": "c", "values": ["7"], "last": None,
                           "count": 4, "constant": True}])

    def test_a_loop_whose_body_binds_nothing_carries_no_bindings(self):
        result = self.k.evaluate("for p in [1, 2, 3]:\n    pass\n", 0)
        self.assertIn("loop", result)
        self.assertNotIn("bindings", result)

    def test_a_name_the_first_pass_does_not_bind_is_not_an_error(self):
        # The recorder reads the frame rather than being handed values, so a
        # name that does not exist yet costs a missing entry rather than a
        # NameError raised inside the user's loop.
        result = self.k.evaluate(
            "for v in [1, 2, 3]:\n    if v > 1:\n        u = v\n", 0)
        self.assertTrue(result["ok"], result)
        self.assertEqual(self.bindings(result), [("u", ["2", "3"], 2)])

    def test_a_binding_no_iteration_reached_says_nothing(self):
        # Including when an earlier evaluation left a value in the namespace
        # under that name: it is not what this statement did.
        result = self.k.evaluate_lines(
            "u = 99\nfor v in [1, 2]:\n    if v > 9:\n        u = v\n", 0, 1)
        self.assertNotIn("bindings", result)
        self.assertNotIn("u", [pair["name"] for pair in
                               result.get("names", [])])

    def test_each_recorded_binding_is_capped_before_the_wire(self):
        result = self.k.evaluate(
            "for v in [1, 2]:\n    wide = 'x' * 5000 + str(v)\n", 0)
        for value in result["bindings"][0]["values"]:
            self.assertLess(len(value), 400)
            self.assertIn("more chars)", value)

    def test_a_body_that_raises_leaves_the_line_reporting_the_failure(self):
        # The recorder is the last statement of the body, so an exception
        # never reaches it -- and the failure path reports no values at all,
        # which is what it did before.
        result = self.k.evaluate(
            "for v in [1, 2]:\n    u = 1 / (v - 1)\n", 0,
            filename="/tmp/user.py")
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["type"], "ZeroDivisionError")
        self.assertNotIn("loops.py", result["error"]["traceback"])

    def test_the_loop_still_leaves_no_machinery_in_the_namespace(self):
        self.k.evaluate("for v in [1, 2]:\n    u = v\n", 0)
        listed = self.k.evaluate("sorted(dir())\n", 0)["value"]
        self.assertNotIn("evalens_loops", listed)

    def test_loading_a_file_reports_the_body_bindings_too(self):
        result = self.k.send(op="eval_file",
                             source="for v in [1, 2, 3]:\n    u = 4 * v\n",
                             filename="/tmp/module.py")
        self.assertEqual(result["results"][0]["bindings"][0]["values"],
                         ["4", "8", "12"])


class ComprehensionLoops(KernelTest):
    """#75: a comprehension hides its loop, and the loop is the lesson.

    A comprehension's target has a scope of its own -- #63's fix -- so what
    is shown here can never come from reading a name back afterwards. It
    comes from `loops.LoopTrace.trace`, wrapped around the clause's own
    iterable while the comprehension runs, the way `LoopBodyBindings` above
    gets a `for` loop's body values.
    """

    def bindings(self, result):
        return [(b["name"], b["values"], b["count"]) for b in
                result.get("bindings", [])]

    def test_a_list_comprehension_reports_what_its_target_ran_through(self):
        result = self.k.evaluate(
            "squares = [x**2 for x in range(10)]\n", 0)
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["value"],
                         "[0, 1, 4, 9, 16, 25, 36, 49, 64, 81]")
        self.assertEqual(self.bindings(result),
                         [("x", ["0", "1", "2", "3", "4"], 10)])

    def test_a_filter_reports_what_it_iterated_not_what_survived(self):
        # The gap between the two numbers is the filter explaining itself:
        # twenty iterations, ten survivors.
        result = self.k.evaluate(
            "evens = [x for x in range(20) if x % 2 == 0]\n", 0)
        self.assertEqual(result["value"], "[0, 2, 4, 6, 8, 10, 12, 14, 16, 18]")
        self.assertEqual(result["bindings"][0]["count"], 20)

    def test_multiple_for_clauses_each_report_their_own_sequence(self):
        # The inner clause legitimately repeats -- once per outer iteration --
        # which is the lesson about nesting, not a bug to average away.
        result = self.k.evaluate(
            "pairs = [(x, y) for x in range(3) for y in range(2)]\n", 0)
        self.assertEqual(self.bindings(result),
                         [("x", ["0", "1", "2"], 3),
                          ("y", ["0", "1", "0", "1", "0"], 6)])

    def test_a_nested_comprehension_reports_both_targets(self):
        result = self.k.evaluate(
            "out = [[y for y in row] for row in [[1, 2], [3, 4]]]\n", 0)
        self.assertEqual(self.bindings(result),
                         [("row", ["[1, 2]", "[3, 4]"], 2),
                          ("y", ["1", "2", "3", "4"], 4)])

    def test_a_tuple_target_reports_the_tuple(self):
        result = self.k.evaluate(
            "d = {k: v for k, v in [(1, 'a'), (2, 'b')]}\n", 0)
        self.assertEqual(self.bindings(result),
                         [("(k, v)", ["(1, 'a')", "(2, 'b')"], 2)])

    def test_a_set_comprehension_is_traced_too(self):
        result = self.k.evaluate("s = {x for x in range(5)}\n", 0)
        self.assertEqual(result["value"], "{0, 1, 2, 3, 4}")
        self.assertEqual(self.bindings(result),
                         [("x", ["0", "1", "2", "3", "4"], 5)])

    def test_a_generator_expression_carries_no_trace_at_all(self):
        # Lazy: nothing has been drawn from it by the time this statement
        # finishes, and forcing it to find out would consume the generator
        # the user just made -- the one thing an annotation may never do.
        result = self.k.evaluate("g = (x for x in range(5))\n", 0)
        self.assertNotIn("bindings", result)

    def test_a_generator_expression_is_not_consumed_by_being_evaluated(self):
        source = "g = (x for x in range(5))\nfirst = next(g)\n"
        result = self.k.evaluate_lines(source, 0, 1)
        self.assertEqual(result["value"], "0")
        second = self.k.evaluate("next(g)\n", 0)
        self.assertEqual(second["value"], "1", "still lazy, still whole")

    def test_a_bare_comprehension_expression_statement_is_still_traced(self):
        # `ast.Expr` is evaluated through a different path than every other
        # statement -- one `eval()` rather than `exec()` -- and it is the one
        # place the rewrite could be computed and then silently thrown away.
        result = self.k.evaluate("[x * x for x in range(5)]\n", 0)
        self.assertEqual(result["value"], "[0, 1, 4, 9, 16]")
        self.assertEqual(self.bindings(result),
                         [("x", ["0", "1", "2", "3", "4"], 5)])

    def test_the_outer_variable_of_the_same_name_is_never_touched(self):
        # #63's regression, restated for the feature that reverses its
        # *display* decision without reopening its *scope* decision: the
        # comprehension's own `x` is what gets traced, and the module-level
        # `x` of the same name is untouched throughout.
        source = "x = [1, 2, 3]\nsquares = [x**2 for x in range(10)]\n"
        result = self.k.evaluate_lines(source, 0, 1)
        self.assertEqual(self.bindings(result),
                         [("x", ["0", "1", "2", "3", "4"], 10)])
        self.assertNotIn("x", [pair["name"] for pair in
                               result.get("names", [])])
        after = self.k.evaluate("x\n", 0)
        self.assertEqual(after["value"], "[1, 2, 3]",
                         "the comprehension must not have touched it")

    def test_a_comprehension_still_reports_what_it_reads_from_outside(self):
        # Only the loop targets are scoped away; a name read from the
        # enclosing scope is still legitimate context and stays a name.
        source = "factor = 10\ndata = [1, 2]\nout = [x * factor for x in data]\n"
        result = self.k.evaluate_lines(source, 0, 1, 2)
        self.assertEqual(result["value"], "[10, 20]")
        self.assertEqual(self.bindings(result),
                         [("x", ["1", "2"], 2)])
        self.assertEqual([pair["name"] for pair in result["names"]],
                         ["factor", "data"])

    def test_a_comprehension_inside_a_nested_def_is_left_alone(self):
        # It runs when the function is called, long after this evaluation
        # finished and the recorders were uninstalled.
        source = "def f():\n    return [x * x for x in range(3)]\n"
        result = self.k.evaluate(source, 0)
        self.assertNotIn("bindings", result)
        self.assertEqual(
            self.k.evaluate_lines(source + "f()\n", 0, 1, 2)["value"],
            "[0, 1, 4]")

    def test_zero_loop_values_leaves_the_comprehension_uninstrumented(self):
        # The same off switch a `for` loop obeys: `evalens.loopValues` turns
        # the rewrite off, not merely the display, so an uninstrumented
        # comprehension costs nothing extra per iteration.
        result = self.k.evaluate(
            "squares = [x**2 for x in range(10)]\n", 0,
            limits={"loop_values": 0})
        self.assertTrue(result["ok"], result)
        self.assertNotIn("bindings", result)
        self.assertEqual(result["value"], "[0, 1, 4, 9, 16, 25, 36, 49, "
                                          "64, 81]")

    def test_a_request_may_ask_for_more_comprehension_iterations(self):
        result = self.k.evaluate(
            "squares = [x**2 for x in range(20)]\n", 0,
            limits={"loop_values": 8})
        self.assertEqual(result["bindings"][0]["values"],
                         ["0", "1", "2", "3", "4", "5", "6", "7"])
        self.assertEqual(result["bindings"][0]["count"], 20)

    def test_each_recorded_value_is_capped_before_the_wire(self):
        result = self.k.evaluate(
            "s = ['x' * 5000 for _ in range(2)]\n", 0)
        for value in result["bindings"][0]["values"]:
            self.assertLess(len(value), 400)

    def test_a_long_comprehension_is_bounded_rather_than_sent_whole(self):
        result = self.k.evaluate(
            "big = [x for x in range(100000)]\n", 0)
        self.assertEqual(result["bindings"][0]["values"],
                         ["0", "1", "2", "3", "4"])
        self.assertEqual(result["bindings"][0]["last"], "99999")
        self.assertEqual(result["bindings"][0]["count"], 100000)

    def test_the_comprehension_leaves_no_machinery_in_the_namespace(self):
        self.k.evaluate("squares = [x * x for x in range(3)]\n", 0)
        listed = self.k.evaluate("sorted(dir())\n", 0)["value"]
        self.assertNotIn("evalens_loops", listed)

    def test_a_raise_from_inside_the_iterable_names_no_kernel_frame(self):
        # The one place this rewrite genuinely does put a frame of its own on
        # the stack: an iterable whose own iteration raises, rather than the
        # comprehension's element expression or a filter. `_error` strips it.
        source = ("def gen():\n"
                 "    yield 1\n"
                 "    raise ValueError('boom')\n"
                 "result = [x for x in gen()]\n")
        self.k.evaluate(source, 0)
        result = self.k.evaluate(source, 3, filename="/tmp/user.py")
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["type"], "ValueError")
        self.assertNotIn("loops.py", result["error"]["traceback"])
        self.assertNotIn("evalens_kernel.py", result["error"]["traceback"])

    def test_a_raise_from_the_element_expression_names_no_kernel_frame(self):
        # The common student mistake -- dividing by a value the comprehension
        # itself produced -- runs entirely in the comprehension's own frame
        # and was never at risk, checked here so a future change cannot
        # regress it unnoticed.
        result = self.k.evaluate(
            "result = [10 / n for n in [1, 2, 0, 3]]\n", 0,
            filename="/tmp/user.py")
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["type"], "ZeroDivisionError")
        self.assertNotIn("loops.py", result["error"]["traceback"])

    def test_loading_a_file_reports_a_comprehensions_trace_too(self):
        result = self.k.send(
            op="eval_file",
            source="squares = [x**2 for x in range(5)]\n",
            filename="/tmp/module.py")
        self.assertEqual(result["results"][0]["bindings"][0]["values"],
                         ["0", "1", "2", "3", "4"])


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
        # the namespace and buries the code it is written beside. `NAME_LIMIT`
        # itself is a generous transport bound now (#85), so the cap this
        # exercises is the one a request asks for explicitly -- the same
        # mechanism the renderer's display cap relies on downstream.
        source = ("a = 1\nb = 2\nc = 3\nd = 4\ne = 5\nf = 6\n"
                  "[a, b, c, d, e, f]\n")
        result = self.k.evaluate_lines(source, 0, 1, 2, 3, 4, 5, 6,
                                       limits={"names": 4})
        self.assertEqual(len(result["names"]), 4)
        self.assertEqual([p["name"] for p in result["names"]],
                         ["a", "b", "c", "d"])

    def test_the_cap_says_how_many_names_it_left_off(self):
        # Silently is the problem, not the cap. A reader who counts six names
        # on the line and four beside it has no way to tell whether the rest
        # were omitted, unreadable, or somehow not names.
        source = ("a = 1\nb = 2\nc = 3\nd = 4\ne = 5\nf = 6\n"
                  "[a, b, c, d, e, f]\n")
        result = self.k.evaluate_lines(source, 0, 1, 2, 3, 4, 5, 6,
                                       limits={"names": 4})
        self.assertEqual(result["more_names"], 2)

    def test_a_line_inside_the_cap_says_nothing_about_it(self):
        result = self.k.evaluate_lines("a = 1\nb = 2\n[a, b]\n", 0, 1, 2)
        self.assertNotIn("more_names", result)

    def test_what_never_qualified_does_not_inflate_the_count(self):
        # The count is of values the line would have shown. A module was never
        # going to be one of them, so counting it would report an omission
        # that did not happen.
        source = ("import json\na = 1\nb = 2\nc = 3\nd = 4\n"
                  "[a, b, c, d, json]\n")
        result = self.k.evaluate_lines(source, 0, 1, 2, 3, 4, 5)
        self.assertEqual(len(result["names"]), 4)
        self.assertNotIn("more_names", result)

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

    def test_a_comprehension_does_not_report_a_variable_of_the_same_name(self):
        # The ticket's case, with the namespace that makes it a false
        # statement rather than a display preference: `x` still holds
        # [1, 2, 3] afterwards, untouched, because the comprehension's `x`
        # lived and died in a scope of its own. Reporting it paints an
        # unrelated variable as part of the line, and it looks plausible.
        source = "x = [1, 2, 3]\nsquares = [x**2 for x in range(10)]\n"
        result = self.k.evaluate_lines(source, 0, 1)
        self.assertEqual(result["display"], "squares")
        self.assertEqual(self.pairs(result), [])
        self.assertEqual(self.k.evaluate("x\n", 0)["value"], "[1, 2, 3]",
                         "the comprehension must not have touched it")

    def test_a_nested_comprehension_reports_neither_of_its_targets(self):
        source = ("x = [1, 2, 3]\ny = [1, 2, 3, 4]\n"
                  "pairs = [(x, y) for x in range(3) for y in range(2)]\n")
        result = self.k.evaluate_lines(source, 0, 1, 2)
        self.assertEqual(self.pairs(result), [])

    def test_a_comprehension_still_reports_what_it_read_from_outside(self):
        # The other half of the rule: only the loop targets are scoped away.
        source = ("factor = 10\ndata = [1, 2]\n"
                  "out = [x * factor for x in data]\n")
        result = self.k.evaluate_lines(source, 0, 1, 2)
        self.assertEqual(result["value"], "[10, 20]")
        self.assertEqual(self.pairs(result),
                         [("factor", "10"), ("data", "[1, 2]")])

    def test_unpacking_names_each_binding_instead_of_echoing_the_source(self):
        # The ticket's case. `=> ({'a': 1}, {'b': 2})` restated the line and
        # left the actual question -- what is `d1` now -- unanswered.
        result = self.k.evaluate('d1, d2 = {"a": 1}, {"b": 2}\n', 0)
        self.assertIsNone(result["display"])
        self.assertIsNone(result["value"])
        self.assertEqual(self.pairs(result),
                         [("d1", "{'a': 1}"), ("d2", "{'b': 2}")])

    def test_a_starred_target_reports_the_list_the_star_collected(self):
        # Re-evaluating the unparsed target gave `(1, 2, 3, 4)`, because a
        # starred element in a tuple display re-splats: a faithful echo of the
        # right-hand side and a misleading picture of the namespace.
        result = self.k.evaluate("head, *rest = [1, 2, 3, 4]\n", 0)
        self.assertEqual(self.pairs(result),
                         [("head", "1"), ("rest", "[2, 3, 4]")])

    def test_a_nested_pattern_reports_every_leaf_it_bound(self):
        result = self.k.evaluate("a, (b, c) = 1, (2, 3)\n", 0)
        self.assertEqual(self.pairs(result),
                         [("a", "1"), ("b", "2"), ("c", "3")])

    def test_the_values_come_from_the_namespace_not_from_the_source(self):
        # A trace, not a re-evaluation: the right-hand side runs once, and
        # what is reported is what the names hold afterwards. A swap has no
        # right-hand side to echo that would say the same thing.
        result = self.k.evaluate_lines(
            "x, y = 1, 2\nx, y = y, x\n", 0, 1)
        self.assertEqual(self.pairs(result), [("x", "2"), ("y", "1")])

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

    def test_a_multi_name_from_import_names_every_binding(self):
        # The ticket's case: `from math import floor, ceil, sqrt` annotated
        # `def floor(x, /)`, reporting one of three bindings as though it
        # were the statement's whole value, with no sign the other two
        # existed.
        result = self.k.evaluate("from math import floor, ceil, sqrt\n", 0)
        self.assertIsNone(result["display"])
        self.assertIsNone(result["value"])
        self.assertEqual(
            self.pairs(result),
            [("floor", "def floor(x, /)"), ("ceil", "def ceil(x, /)"),
             ("sqrt", "def sqrt(x, /)")])

    def test_a_multi_name_plain_import_names_every_module_it_bound(self):
        # A module is exactly what an import line means to report, and
        # exactly the kind of value `_worth_a_pair` hides everywhere else --
        # rightly, on a line that only *mentions* a module (see
        # `test_a_module_is_skipped` above), wrongly on the one line whose
        # entire effect is binding it.
        #
        # `itertools` and `sys` are true interpreter builtins on every Python
        # this suite runs against, 3.9 through 3.13, so their reprs are exact
        # and stable. The ticket's own example, `import os, sys`, is checked
        # too, but `os` by shape rather than by exact text: its repr says
        # `(frozen)` on a newer interpreter and names a `.py` file on an
        # older one.
        result = self.k.evaluate("import itertools, sys\n", 0)
        self.assertIsNone(result["display"])
        self.assertEqual(
            self.pairs(result),
            [("itertools", "<module 'itertools' (built-in)>"),
             ("sys", "<module 'sys' (built-in)>")])

        ticket = dict(self.pairs(self.k.evaluate("import os, sys\n", 0)))
        self.assertRegex(ticket["os"], r"^<module 'os'")
        self.assertEqual(ticket["sys"], "<module 'sys' (built-in)>")

    def test_an_aliased_multi_name_import_names_every_alias(self):
        result = self.k.evaluate("from math import sqrt as root, floor\n", 0)
        self.assertIsNone(result["display"])
        self.assertEqual(
            self.pairs(result),
            [("root", "def sqrt(x, /)"), ("floor", "def floor(x, /)")])

    def test_a_line_that_merely_mentions_an_import_is_still_filtered(self):
        # The distinction the fix has to preserve: `_worth_a_pair` skips a
        # module only for the import statement that bound it, not for every
        # later line that happens to name it.
        result = self.k.evaluate_lines(
            "import os, sys\nos.getcwd()\n", 0, 1)
        self.assertEqual(self.pairs(result), [])

    def test_a_single_name_import_is_unaffected(self):
        # The display slot still holds the one name a single-alias import
        # binds; only a multi-name import routes through `names`.
        result = self.k.evaluate("import math\n", 0)
        self.assertEqual(result["display"], "math")
        self.assertNotIn("names", result)


class StarImports(KernelTest):
    """`from pkg import *` ran, bound its names, and was painted as broken.

    The display step was handed the literal `"*"` as the expression to show
    and compiled it, so the extension's own `SyntaxError` arrived through the
    same channel as one in the user's source -- in red, on a working line,
    quoting `<unknown>, line 1`, which is a file and a line the reader cannot
    go and look at. A star import is one of the first things a teaching file
    demonstrates.
    """

    def package(self, name, body):
        """A real importable package, on the kernel's path. Returns its dir."""
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        os.mkdir(os.path.join(directory.name, name))
        with open(os.path.join(directory.name, name, "__init__.py"), "w",
                  encoding="utf-8") as handle:
            handle.write(body)
        return directory.name

    def source_importing(self, name, body, *rest):
        """A buffer that puts the package on `sys.path` and star-imports it."""
        root = self.package(name, body)
        return ("import sys\n"
                f"sys.path.insert(0, {root!r})\n"
                f"from {name} import *\n" + "".join(rest))

    STARPKG = ("__all__ = ['label', 'SIZE']\n"
               "def label(n):\n"
               "    return '#%d' % n\n"
               "SIZE = 2\n"
               "_hidden = 'not exported'\n")

    def test_a_star_import_is_not_a_syntax_error(self):
        source = self.source_importing("starpkg", self.STARPKG, "label(3)\n")
        result = self.k.evaluate_lines(source, 0, 1, 2)
        self.assertTrue(result["ok"], result)
        self.assertIsNone(result["display"])
        # And the names really did arrive, which is what says the import was
        # never broken in the first place.
        self.assertEqual(self.k.evaluate(source, 3)["value"], "'#3'")

    def test_a_star_import_says_what_it_brought_in(self):
        source = self.source_importing("countpkg", self.STARPKG)
        result = self.k.evaluate_lines(source, 0, 1, 2)
        self.assertEqual(result["value"], "2 names: label, SIZE")

    def test_the_names_are_the_modules_own_all(self):
        # `_hidden` is in the module and not in `__all__`, so the import did
        # not bind it and the count must not include it.
        source = self.source_importing("allpkg", self.STARPKG)
        result = self.k.evaluate_lines(source, 0, 1, 2)
        self.assertNotIn("_hidden", result["value"])

    def test_a_module_with_no_all_falls_back_to_its_public_names(self):
        source = self.source_importing(
            "openpkg", "alpha = 1\nbeta = 2\n_private = 3\n")
        result = self.k.evaluate_lines(source, 0, 1, 2)
        self.assertEqual(result["value"], "2 names: alpha, beta")

    def test_a_second_evaluation_says_exactly_the_same_thing(self):
        # Why the count is read from the module rather than diffed out of the
        # namespace: a diff answers `2 names` the first time and `0 names` the
        # second, and an annotation that changes while the code has not is
        # what teaches a reader to distrust every annotation.
        source = self.source_importing("stablepkg", self.STARPKG)
        first = self.k.evaluate_lines(source, 0, 1, 2)
        second = self.k.evaluate(source, 2)
        self.assertEqual(first["value"], second["value"])

    def test_a_wide_star_import_is_counted_rather_than_listed(self):
        # The first four of twenty are wherever the module defined them, not
        # a sample of anything, and the line has other things on it.
        body = "".join(f"name{n} = {n}\n" for n in range(20))
        source = self.source_importing("widepkg", body)
        result = self.k.evaluate_lines(source, 0, 1, 2)
        self.assertEqual(result["value"], "20 names")

    def test_an_ordinary_import_is_unaffected(self):
        result = self.k.evaluate("import os.path\n", 0)
        self.assertEqual(result["display"], "os")

    def test_loading_a_file_with_a_star_import_reports_no_failure(self):
        source = self.source_importing("loadpkg", self.STARPKG, "label(1)\n")
        loaded = self.k.send(op="eval_file", source=source)
        self.assertTrue(loaded["ok"], loaded)
        self.assertEqual(loaded["ran"], loaded["statements"])
        self.assertEqual([r for r in loaded["results"] if not r["ok"]], [])


class Limits(KernelTest):
    """How much to show is the reader's call, and it mostly arrives per request.

    `loop_values` is still a user setting sent whole on every request: the
    kernel is not configured with it because the only way to change a
    kernel's mind would be to restart it, and restarting discards the
    namespace. `names` is different since #85: the kernel's own default is a
    generous transport bound rather than a display preference, because the
    kernel has no way to know which of a line's names the reader has already
    seen painted above it, and choosing by position instead throws away
    whichever one changed most recently -- see `PaintedAbove` in
    `src/render/repeats.ts` for where that decision moved to. A request may
    still ask for a smaller `names` limit than the default, which is what the
    off switch for `evalens.readNames` does.
    """

    def sequence(self, source, **extra):
        return self.k.evaluate(source, 0, **extra)

    def test_a_request_may_ask_for_more_names_than_the_default(self):
        source = ("a = 1\nb = 2\nc = 3\nd = 4\ne = 5\n"
                  "print(a, b, c, d, e)\n")
        result = self.k.evaluate_lines(source, 0, 1, 2, 3, 4, 5,
                                       limits={"names": 5})
        self.assertEqual([p["name"] for p in result["names"]],
                         ["a", "b", "c", "d", "e"])

    def test_the_default_is_generous_rather_than_a_display_cap(self):
        # Five names is nowhere near NAME_LIMIT now: the wire is not where
        # "how many names per line" gets decided any more, so a request that
        # says nothing gets every name the line read, not four of them.
        source = ("a = 1\nb = 2\nc = 3\nd = 4\ne = 5\n"
                  "print(a, b, c, d, e)\n")
        result = self.k.evaluate_lines(source, 0, 1, 2, 3, 4, 5)
        self.assertEqual([p["name"] for p in result["names"]],
                         ["a", "b", "c", "d", "e"])
        self.assertNotIn("more_names", result)

    def test_zero_names_reports_none_at_all(self):
        # The off switch for `evalens.readNames`. The line still evaluates and
        # still says what it produced; it just stops repeating the namespace.
        result = self.k.evaluate_lines(
            "y = [1, 2, 3]\nprint('y:', y)\n", 0, 1, limits={"names": 0})
        self.assertEqual(result["value"], "None")
        self.assertNotIn("names", result)

    def test_a_request_may_ask_for_more_loop_iterations(self):
        result = self.sequence("for p in range(20):\n    pass\n",
                               limits={"loop_values": 8})
        self.assertEqual(result["loop"]["values"],
                         ["0", "1", "2", "3", "4", "5", "6", "7"])
        self.assertEqual(result["loop"]["count"], 20)

    def test_zero_loop_values_leaves_the_loop_uninstrumented(self):
        # The off switch for `evalens.loopValues`, and it has to turn off the
        # rewrite rather than the rendering: hiding the sequence while still
        # taking one repr() per iteration would charge for a feature nobody
        # asked for.
        #
        # The target's final value is then reported the way any other bare
        # name's is. Reporting nothing instead would leave the line blank, and
        # a blank line reads as "nothing happened" -- a worse falsehood than a
        # final value, which is one true binding in the shape every other
        # binding is shown in. Nothing here is dressed up as a history,
        # because with no recorders there is no history on the line to confuse
        # it with. The safety half of that split is the resolver's and stays
        # there: see `WhereTheValueComesFrom` in `test_resolver`.
        result = self.sequence("for p in range(1000):\n    pass\n",
                               limits={"loop_values": 0})
        self.assertTrue(result["ok"], result)
        self.assertNotIn("loop", result)
        self.assertEqual(result["value"], "999")

    def test_a_malformed_limit_falls_back_rather_than_silencing(self):
        # A typo in settings.json must not look like a broken extension. The
        # user has no reason to connect the two, and "it stopped annotating"
        # is the least diagnosable symptom this extension has.
        for bad in ({"names": "four"}, {"names": -1}, {"names": True},
                    {"names": None}, "not a mapping"):
            with self.subTest(bad=bad):
                result = self.k.evaluate_lines(
                    "y = [1, 2, 3]\nprint('y:', y)\n", 0, 1, limits=bad)
                self.assertEqual(
                    [p["name"] for p in result.get("names", [])], ["y"])

    def test_a_file_load_honours_the_same_limits(self):
        result = self.k.send(
            op="eval_file", source="y = [1, 2]\nprint('y:', y)\n",
            filename="/tmp/module.py", limits={"names": 0})
        self.assertNotIn("names", result["results"][1])


class Watches(KernelTest):
    """`eval_watch` -- #48. A nominated expression, traced across a loop the
    same way its target and its body's own bindings already are.

    **This is a trace, not a watch, whatever the op is called on the wire.**
    Every result below is read once, during the one loop this request ran;
    nothing is kept between requests, and a later plain `eval` of the same
    loop -- see `test_a_plain_eval_of_the_same_loop_carries_no_watch` -- shows
    none of it. See `loops.py`'s module docstring for the fuller argument.
    """

    def test_a_target_expression_is_traced_alongside_the_loop(self):
        source = "squares = [0, 1, 4, 9, 16]\nfor p in squares:\n    pass\n"
        self.k.evaluate(source, 0)
        result = self.k.watch(source, 1, "p+6")
        self.assertTrue(result["ok"], result)
        watch = next(b for b in result["bindings"] if b["name"] == "p+6")
        self.assertEqual(watch["values"], ["6", "7", "10", "15", "22"])
        # The loop's own sequence is untouched by nominating something else.
        self.assertEqual(result["loop"]["values"],
                         ["0", "1", "4", "9", "16"])

    def test_an_accumulator_is_traced_after_the_body_updates_it(self):
        source = "total = 0\nfor x in [1, 2, 3, 4]:\n    total += x\n"
        self.k.evaluate(source, 0)
        result = self.k.watch(source, 1, "total")
        watch = next(b for b in result["bindings"] if b["name"] == "total")
        self.assertEqual(watch["values"], ["1", "3", "6", "10"])

    def test_nominating_an_already_bound_name_does_not_paint_it_twice(self):
        # `total` is already a body binding (#75) on this loop: nominating
        # it too must not print `total: ... total: ...` on one line, since
        # both read the same name at the same point in the same iteration
        # and would say the identical sequence twice.
        source = "total = 0\nfor x in [1, 2, 3, 4]:\n    total += x\n"
        self.k.evaluate(source, 0)
        result = self.k.watch(source, 1, "total")
        names = [b["name"] for b in result["bindings"]]
        self.assertEqual(names.count("total"), 1, result["bindings"])

    def test_a_raising_expression_is_reported_once_and_the_loop_finishes(self):
        result = self.k.watch("for p in [1, 0, 2, 0, 3]:\n    pass\n", 0,
                              "1/p")
        self.assertTrue(result["ok"], result)
        # The loop itself completed and shows every iteration.
        self.assertEqual(result["loop"]["count"], 5)
        watch = next(b for b in result["bindings"] if b["name"] == "1/p")
        self.assertEqual(watch["values"], ["1.0", "0.5", "0.3333333333333333"])
        self.assertEqual(watch["error"]["type"], "ZeroDivisionError")
        self.assertEqual(watch["failed"], 1)
        # Reported once, on stderr, not once per failing iteration: two
        # zeroes raised and the message names the type exactly once.
        self.assertEqual(result["stderr"].count("ZeroDivisionError"), 1)
        self.assertIn("watching '1/p'", result["stderr"])

    def test_ten_thousand_iterations_stays_bounded_and_correct(self):
        source = "acc = 0\nfor i in range(10000):\n    acc += i\n"
        self.k.evaluate(source, 0)
        result = self.k.watch(source, 1, "acc * 2")
        watch = next(b for b in result["bindings"] if b["name"] == "acc * 2")
        self.assertEqual(watch["count"], 10000)
        self.assertEqual(watch["last"], str(sum(range(10000)) * 2))
        self.assertEqual(len(watch["values"]), 5)

    def test_loop_values_zero_disables_the_watch_entirely(self):
        # The same off switch #75 already answers to for a comprehension
        # trace: an off switch that still instrumented would stop showing
        # the sequence and keep charging one repr() per iteration for it.
        source = "total = 0\nfor x in [1, 2, 3, 4]:\n    total += x\n"
        self.k.evaluate(source, 0)
        result = self.k.watch(source, 1, "total",
                              limits={"loop_values": 0, "names": 12})
        self.assertTrue(result["ok"], result)
        self.assertNotIn("loop", result)
        self.assertNotIn("bindings", result)

    def test_a_plain_eval_of_the_same_loop_carries_no_watch(self):
        # Design rule 4: a nomination is data on one request, not a standing
        # instruction the kernel remembers. Nothing about `eval_watch` having
        # run once changes what a later, ordinary `eval` of the same loop
        # reports.
        source = "for p in [1, 2, 3]:\n    pass\n"
        self.k.watch(source, 0, "p * 2")
        plain = self.k.evaluate(source, 0)
        self.assertTrue(plain["ok"], plain)
        for binding in plain.get("bindings", []):
            self.assertNotEqual(binding["name"], "p * 2")

    def test_the_statement_under_the_cursor_must_be_a_loop(self):
        result = self.k.watch("x = 1\n", 0, "x")
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["type"], "NoLoop")

    def test_an_unparsable_expression_is_a_syntax_error_not_a_crash(self):
        result = self.k.watch("for p in [1]:\n    pass\n", 0, "p +")
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["type"], "SyntaxError")
        # The loop is untouched by a nomination that never parsed: a second,
        # ordinary evaluation still works.
        self.assertTrue(self.k.evaluate("for p in [1]:\n    pass\n", 0)["ok"])

    def test_an_empty_expression_is_reported_rather_than_run(self):
        result = self.k.watch("for p in [1]:\n    pass\n", 0, "   ")
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["type"], "NoExpression")

    def test_a_blank_cursor_line_resolves_to_nothing(self):
        result = self.k.watch("a = 1\n\nb = 2\n", 1, "a")
        self.assertTrue(result["ok"])
        self.assertFalse(result["resolved"])

    def test_a_watch_nested_inside_an_outer_loop_attaches_to_the_inner_one(self):
        source = "for i in range(2):\n    for j in range(3):\n        pass\n"
        # `character=8` lands inside the inner loop's own header ("    for j
        # in range(3):"), which is what tells `innermost_loop_at` apart from
        # the outer loop that also contains this line.
        result = self.k.watch(source, 1, "i * 10 + j", character=8)
        self.assertTrue(result["ok"], result)
        # The outer loop's own sequence is unaffected by a watch nested
        # inside it.
        self.assertEqual(result["loop"]["values"], ["0", "1"])
        watch = next(b for b in result["bindings"]
                    if b["name"] == "i * 10 + j")
        self.assertEqual(watch["count"], 6)

    def test_the_namespace_carries_no_watch_machinery_afterwards(self):
        self.k.watch("for p in [1, 0]:\n    pass\n", 0, "1/p")
        names = eval(self.k.evaluate("sorted(dir())", 0)["value"])
        self.assertFalse(
            [n for n in names if "evalens" in n or "watch" in n.lower()],
            names)


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


class Dependencies(KernelTest):
    """`binds` and `reads` over the wire.

    The only fields in a response that say nothing about the statement's own
    answer. They exist so the extension can mark which *other* annotations an
    evaluation has just put out of date -- and marking is the whole of it. The
    kernel never re-runs a dependant, never queues one, and has no idea what
    the extension has on screen.
    """

    def test_the_two_line_example_carries_its_dependency(self):
        src = "x = 1\ny = x + 1\n"
        first = self.k.evaluate(src, 0)
        self.assertEqual(first["binds"], ["x"])
        self.assertNotIn("reads", first)

        second = self.k.evaluate(src, 1)
        self.assertEqual(second["binds"], ["y"])
        self.assertEqual(second["reads"], ["x"])
        # And the value is still the value: nothing about this changed what a
        # statement reports about itself.
        self.assertEqual(second["value"], "2")

    def test_a_statement_that_touches_nothing_carries_neither_field(self):
        result = self.k.evaluate("pass\n", 0)
        self.assertNotIn("binds", result)
        self.assertNotIn("reads", result)

    def test_a_failure_still_reports_what_it_would_have_touched(self):
        # A statement that raised may have bound something before it did, and
        # a dependant marked that did not need it costs one grey pixel.
        result = self.k.evaluate("y = undefined_name\n", 0)
        self.assertFalse(result["ok"])
        self.assertEqual(result["binds"], ["y"])
        self.assertEqual(result["reads"], ["undefined_name"])

    def test_loading_a_file_reports_them_per_statement(self):
        result = self.k.send(op="eval_file", source="x = 1\ny = x + 1\n",
                             filename="/tmp/module.py")
        self.assertEqual(result["results"][0]["binds"], ["x"])
        self.assertEqual(result["results"][1]["reads"], ["x"])

    def test_a_definition_reports_its_decorator_as_a_read(self):
        src = ("def shout(fn):\n    return fn\n\n\n"
               "@shout\ndef greeting():\n    return 'ok'\n")
        self.k.evaluate(src, 0)
        result = self.k.evaluate(src, 5)
        self.assertEqual(result["binds"], ["greeting"])
        self.assertEqual(result["reads"], ["shout"])


class LargeValues(KernelTest):
    """A big value costs what its annotation costs, not what it costs whole.

    The defect these pin: `repr()` was called in full and the wire limit
    applied to the result, so `list(range(5_000_000))` spent 1.16 seconds and
    46 MB building 44 million characters of which 8,192 survived. The kernel
    is single threaded, so nothing else was serviced while that ran -- it
    looked exactly like the wedged kernel the interrupt work exists for, and
    it was reached by one ordinary keystroke rather than by a runaway loop.
    """

    #: Comfortably below what the defect costs and far above what the fix
    #: does: the same request took over a second before and a millisecond
    #: after, so a loaded CI runner has two orders of magnitude to be slow in
    #: without either failing this or letting the regression back through.
    BUDGET = 0.5

    def display(self, source, line):
        """The value of `line`, and how long the kernel took to answer.

        The line before it is evaluated first and untimed, because building
        five million integers is the test's setup rather than its subject.
        """
        self.k.evaluate(source, line - 1)
        start = time.monotonic()
        result = self.k.evaluate(source, line)
        self.assertTrue(result["ok"], result)
        return result["value"], time.monotonic() - start

    def test_a_huge_list_is_answered_without_building_its_repr(self):
        value, elapsed = self.display(
            "big = list(range(5_000_000))\nbig\n", 1)
        self.assertLess(elapsed, self.BUDGET,
                        f"took {elapsed:.3f}s to say {len(value)} characters")

    def test_a_huge_list_shows_both_ends_and_counts_the_rest(self):
        # The three claims that stop a cut list reading as a short one: it
        # starts where the real list starts, it ends where the real list ends,
        # and it says in between how much is not being shown.
        value, _ = self.display("big = list(range(5_000_000))\nbig\n", 1)
        self.assertTrue(value.startswith("[0, 1, 2, "), value[:40])
        self.assertTrue(value.endswith("4999998, 4999999]"), value[-40:])
        self.assertRegex(value, r"… \(\+[\d,]+ more\) …")
        self.assertLess(len(value), 8192)

    def test_a_wide_dict_is_answered_in_its_own_order(self):
        # `reprlib` sorts a dict's keys to make its truncation deterministic.
        # Insertion order is part of what a dict *is*, so sorting it would
        # paint a value that never existed next to the code that built it.
        value, elapsed = self.display(
            "wide = {i: i * i for i in range(3000, 0, -1)}\nwide\n", 1)
        self.assertTrue(value.startswith("{3000: 9000000, 2999:"), value[:40])
        self.assertTrue(value.endswith("2: 4, 1: 1}"), value[-40:])
        self.assertLess(elapsed, self.BUDGET)

    def test_a_huge_string_keeps_its_opening_and_says_what_it_dropped(self):
        value, elapsed = self.display("s = 'ab' * 500_000\ns\n", 1)
        self.assertTrue(value.startswith("'abab"), value[:20])
        self.assertIn("more chars)", value)
        self.assertLess(len(value), 8192)
        self.assertLess(elapsed, self.BUDGET)

    def test_a_deeply_nested_structure_stops_rather_than_descends(self):
        source = ("deep = 1\n"
                  "for _ in range(40):\n"
                  "    deep = [deep]\n"
                  "deep\n")
        self.k.evaluate_lines(source, 0, 1)
        value = self.k.evaluate(source, 3)["value"]
        self.assertTrue(value.startswith("[[[["), value[:20])
        self.assertTrue(value.endswith("]]]]"), value[-20:])
        self.assertIn("…", value)
        self.assertLess(len(value), 100)

    def test_a_list_holding_itself_reads_the_way_python_prints_it(self):
        # Python's own containers carry a recursion guard and print `[...]`.
        # Formatting the walk ourselves would lose it and paint six levels of
        # brackets instead, which describes a shape the value does not have.
        src = "ring = []\nring.append(ring)\nring\n"
        self.k.evaluate_lines(src, 0, 1)
        self.assertEqual(self.k.evaluate(src, 2)["value"], "[[...]]")

    def test_a_list_subclass_is_bounded_the_way_a_list_is(self):
        # `reprlib` dispatches on the type's *name*, so `Stack` finds no
        # handler and falls back to the full `repr()` this exists to avoid.
        # Subclassing a builtin container is ordinary teaching code.
        source = ("class Stack(list):\n    pass\n"
                  "s = Stack(range(2_000_000))\ns\n")
        self.k.evaluate_lines(source, 0, 2)
        start = time.monotonic()
        value = self.k.evaluate(source, 3)["value"]
        self.assertLess(time.monotonic() - start, self.BUDGET)
        self.assertLess(len(value), 8192)
        self.assertTrue(value.endswith("1999999]"), value[-30:])

    def test_a_hand_written_repr_is_shown_whole_and_not_summarised(self):
        # Design rule 3's neighbour: a `__repr__` somebody wrote is a
        # statement about how the object should read, and a formatter that
        # elided it would be the extension overruling the user's own code.
        source = ("class Grid:\n"
                  "    def __repr__(self):\n"
                  "        return '<' + ' '.join('#' * 40) + '>'\n"
                  "g = Grid()\ng\n")
        self.k.evaluate_lines(source, 0, 3)
        self.assertEqual(self.k.evaluate(source, 4)["value"],
                         "<" + " ".join("#" * 40) + ">")

    def test_a_repr_that_recurses_says_which_value_it_could_not_show(self):
        # `<repr() raised RecursionError>` was a correct rescue and a poor
        # answer: it told the reader everything except what they were looking
        # at. The type is the durable fact and belongs first.
        source = ("class Knot:\n"
                  "    def __repr__(self):\n"
                  "        return repr(self)\n"
                  "knot = Knot()\nknot\n")
        self.k.evaluate_lines(source, 0, 3)
        value = self.k.evaluate(source, 4)["value"]
        self.assertTrue(value.startswith("<Knot instance:"), value)
        self.assertIn("RecursionError", value)

    def test_one_fat_element_does_not_crowd_out_the_rest(self):
        source = "rows = [['q' * 100_000] for _ in range(20)]\nrows\n"
        value, elapsed = self.display(source, 1)
        self.assertLess(len(value), 8192)
        self.assertTrue(value.endswith("]]"), value[-20:])
        self.assertGreater(value.count("more chars)"), 1)
        self.assertLess(elapsed, self.BUDGET)


class Inspecting(KernelTest):
    """#23: one level of a value's children, for the object explorer.

    The property this class exists to pin above every other one: nothing
    here ever calls anything the user's code defines. `NoExecution` proves
    it directly, with a class built to announce the two calls design rule 3
    forbids; the rest of this class is the ordinary shape of the feature.
    """

    def test_a_dict_lists_its_items_by_key(self):
        self.k.evaluate("config = {'host': 'localhost', 'port': 8080}\n", 0)
        result = self.k.inspect("config")
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["type"], "dict")
        names = [child["name"] for child in result["children"]]
        self.assertEqual(names, ["'host'", "'port'"])
        self.assertEqual(result["children"][0]["type"], "str")
        self.assertEqual(result["children"][0]["value"], "'localhost'")
        self.assertEqual(result["children"][1]["type"], "int")
        self.assertEqual(result["children"][1]["value"], "8080")
        self.assertEqual(result["count"], 2)
        self.assertFalse(result["truncated"])

    def test_a_plain_instance_lists_its_own_dict(self):
        source = (
            "class User:\n"
            "    def __init__(self, name, age):\n"
            "        self.name = name\n"
            "        self.age = age\n"
            "user = User('Jane Smith', 25)\n"
        )
        self.k.evaluate_lines(source, 0, 1, 2, 3, 4)
        result = self.k.inspect("user")
        self.assertEqual(result["type"], "User")
        by_name = {child["name"]: child for child in result["children"]}
        self.assertEqual(by_name["name"]["value"], "'Jane Smith'")
        self.assertEqual(by_name["age"]["value"], "25")
        self.assertEqual(by_name["name"]["kind"], "attr")
        self.assertEqual(by_name["name"]["step"], {"kind": "attr", "name": "name"})

    def test_a_property_is_shown_unevaluated(self):
        source = (
            "class Config:\n"
            "    def __init__(self):\n"
            "        self.host = 'localhost'\n"
            "    @property\n"
            "    def url(self):\n"
            "        raise AssertionError('must not run')\n"
            "cfg = Config()\n"
        )
        self.k.evaluate_lines(source, *range(7))
        result = self.k.inspect("cfg")
        by_name = {child["name"]: child for child in result["children"]}
        self.assertEqual(by_name["host"]["value"], "'localhost'")
        prop = by_name["url"]
        self.assertEqual(prop["kind"], "property")
        self.assertFalse(prop["expandable"])
        self.assertFalse(prop["evaluated"])
        self.assertNotIn("step", prop)
        self.assertIsNone(prop["value"])

    def test_a_list_of_dicts_is_addressed_by_position_not_key(self):
        source = "rows = [{'id': 1}, {'id': 2}]\n"
        self.k.evaluate(source, 0)
        result = self.k.inspect("rows")
        self.assertEqual([c["name"] for c in result["children"]],
                         ["[0]", "[1]"])
        first_step = result["children"][0]["step"]
        self.assertEqual(first_step, {"kind": "item", "index": 0})
        nested = self.k.inspect("rows", path=[first_step])
        self.assertEqual(nested["type"], "dict")
        self.assertEqual(nested["children"][0]["name"], "'id'")
        self.assertEqual(nested["children"][0]["value"], "1")
        deeper = self.k.inspect(
            "rows", path=[first_step, nested["children"][0]["step"]])
        self.assertEqual(deeper["value"], "1")
        self.assertEqual(deeper["children"], [])

    def test_a_set_is_addressed_by_position(self):
        self.k.evaluate("s = {10, 20, 30}\n", 0)
        result = self.k.inspect("s")
        self.assertEqual(len(result["children"]), 3)
        self.assertEqual(
            [c["step"] for c in result["children"]],
            [{"kind": "item", "index": i} for i in range(3)])

    def test_a_dict_subclass_with_its_own_getitem_is_not_walked_as_a_dict(self):
        # #73's rule applied to `__getitem__` instead of `__repr__`: a
        # mapping that overrode how it is read is not a safe dict to open,
        # whatever it inherits `__repr__` from.
        source = (
            "class LazyRow(dict):\n"
            "    def __getitem__(self, key):\n"
            "        raise AssertionError('must not run')\n"
            "row = LazyRow(a=1, b=2)\n"
        )
        self.k.evaluate_lines(source, 0, 1, 2, 3)
        result = self.k.inspect("row")
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["children"], [])
        self.assertEqual(result["count"], 0)

    def test_children_are_capped_and_the_total_is_still_exact(self):
        self.k.evaluate("nums = list(range(250))\n", 0)
        result = self.k.inspect("nums")
        self.assertEqual(len(result["children"]), 100)
        self.assertEqual(result["count"], 250)
        self.assertTrue(result["truncated"])

    def test_a_huge_list_is_inspected_without_walking_all_of_it(self):
        self.k.evaluate("big = list(range(5_000_000))\n", 0)
        start = time.monotonic()
        result = self.k.inspect("big")
        elapsed = time.monotonic() - start
        self.assertEqual(len(result["children"]), 100)
        self.assertEqual(result["count"], 5_000_000)
        self.assertTrue(result["truncated"])
        self.assertLess(elapsed, 0.5, f"took {elapsed:.3f}s")

    def test_a_generator_has_nothing_to_show_and_is_not_advanced(self):
        source = "def counter():\n    yield 1\n    yield 2\ngen = counter()\n"
        self.k.evaluate_lines(source, 0, 1, 2, 3)
        result = self.k.inspect("gen")
        self.assertEqual(result["children"], [])
        # If inspecting had advanced it, the first value would be gone.
        self.assertEqual(self.k.evaluate("next(gen)\n", 0)["value"], "1")

    def test_an_unbound_name_is_reported_rather_than_raising(self):
        result = self.k.inspect("nope")
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["type"], "NotFound")

    def test_a_name_that_is_not_an_identifier_is_rejected(self):
        for bad in ["self.x", "d['k']", "a, b", "1abc", ""]:
            result = self.k.inspect(bad)
            self.assertFalse(result["ok"], bad)
            self.assertEqual(result["error"]["type"], "InvalidRequest", bad)

    def test_a_step_that_no_longer_resolves_is_reported_not_raised(self):
        self.k.evaluate("xs = [1, 2, 3]\n", 0)
        stale = {"kind": "item", "index": 9}
        result = self.k.inspect("xs", path=[stale])
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["type"], "NotFound")

    def test_inspecting_never_bumps_the_execution_counter(self):
        # `inspect` must not count as an evaluation for anything that tracks
        # "the last thing the user ran" -- the Jupyter `silent` contract this
        # ticket's discussion calls for. A rebind after inspecting still
        # lands where a plain rebind would.
        self.k.evaluate("x = 1\n", 0)
        self.k.inspect("x")
        self.k.inspect("x")
        source = "x = 2\nx\n"
        self.k.evaluate(source, 0)
        self.assertEqual(self.k.evaluate(source, 1)["value"], "2")


class NoExecution(KernelTest):
    """The proof #68 was proved with, aimed at this ticket's own walk.

    One class announces both calls design rule 3 forbids -- a `@property`
    getter and a mapping's own `__getitem__` -- by appending to a list nothing
    else in this test touches. Driving `inspect` down through it, repeatedly
    and from both the root and a step already handed back, and finding that
    list still empty at the end is the whole of the guarantee: not "no
    exception was raised", but "the call never happened".
    """

    def test_a_property_and_a_custom_getitem_are_never_called(self):
        source = (
            "calls = []\n"
            "class Probe(dict):\n"
            "    def __init__(self):\n"
            "        super().__init__(x=1, y=2)\n"
            "        self.plain = 'ok'\n"
            "    @property\n"
            "    def risky(self):\n"
            "        calls.append('property')\n"
            "        return 'should not run'\n"
            "    def __getitem__(self, key):\n"
            "        calls.append('getitem')\n"
            "        raise AssertionError('should not run')\n"
            "probe = Probe()\n"
        )
        self.k.evaluate_lines(source, *range(13))

        root = self.k.inspect("probe")
        self.assertTrue(root["ok"], root)
        by_name = {child["name"]: child for child in root["children"]}
        self.assertEqual(set(by_name), {"plain", "risky"})
        self.assertEqual(by_name["plain"]["value"], "'ok'")
        self.assertEqual(by_name["risky"]["kind"], "property")

        # Asking for the property's own children -- as a client would if it
        # ever mistakenly tried to expand one -- still must not call it: the
        # kernel answers from the step it has, not from the name in it.
        fabricated = {"kind": "attr", "name": "risky"}
        blocked = self.k.inspect("probe", path=[fabricated])
        self.assertFalse(blocked["ok"])

        self.assertEqual(
            self.k.evaluate("calls\n", 0)["value"], "[]",
            "a property getter or a custom __getitem__ ran during inspect")


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
        self.assertIn("more chars)", value)

    def test_an_unknown_op_is_reported(self):
        self.assertEqual(
            self.k.send(op="nonsense")["error"]["type"], "UnknownOp")


class EvaluateAbove(KernelTest):
    """Everything above the statement the cursor is in (#13).

    `eval_above` is not `eval_file` with a different range: it resets the
    namespace first, unconditionally, and it stops at the first failure
    rather than running through the rest of the file. Both are asserted
    here rather than assumed, because they are exactly the two ways this op
    would be wrong in a way that a naive copy of `eval_file` would not catch.
    """

    #: 0: a = 1  1: b = 2  2-4: def f  5: c = f(a, b)  6: c
    SOURCE = ("a = 1\n"
              "b = 2\n"
              "def f(x, y):\n"
              "    z = x + y\n"
              "    return z\n"
              "c = f(a, b)\n"
              "c\n")

    def above(self, line, source=None):
        return self.k.send(op="eval_above",
                            source=self.SOURCE if source is None else source,
                            line=line, filename="/tmp/above.py")

    def bound(self, name):
        """What the namespace holds for `name`, or the error type instead."""
        result = self.k.evaluate(name + "\n", 0)
        return result["value"] if result["ok"] else result["error"]["type"]

    def test_everything_above_the_cursor_runs_and_binds(self):
        result = self.above(5)  # cursor on `c = f(a, b)`
        self.assertTrue(result["ok"], result)
        # `a`, `b` and `def f` are above line 5; `c = f(a, b)` is the
        # boundary statement itself and is not one of them.
        self.assertEqual((result["statements"], result["ran"]), (3, 3))
        self.assertEqual(self.bound("a"), "1")
        self.assertEqual(self.bound("b"), "2")
        self.assertEqual(self.bound("f"), "def f(x, y)")

    def test_the_statement_the_cursor_is_in_does_not_run(self):
        # Line 5 is `c = f(a, b)`. Above it means `a`, `b` and `f` -- not `c`.
        self.above(5)
        self.assertEqual(self.bound("c"), "NameError",
                         "the statement at the cursor is not this command's job")

    def test_a_cursor_inside_a_multiline_statement_excludes_it_whole(self):
        # Line 3 is `z = x + y`, the middle of `def f`'s body. The whole `def`
        # is the boundary regardless of which of its lines the cursor sits on
        # -- a statement never runs partway.
        result = self.above(3)
        self.assertEqual(result["statements"], 2)
        self.assertEqual(self.bound("a"), "1")
        self.assertEqual(self.bound("b"), "2")
        self.assertEqual(self.bound("f"), "NameError",
                         "the def the cursor is inside must not have run")

    def test_a_cursor_on_a_blank_line_runs_everything_above_it(self):
        source = "a = 1\n\nb = 2\n"
        result = self.above(1, source=source)  # the blank line
        self.assertEqual(result["statements"], 1)
        self.assertEqual(self.bound("a"), "1")
        self.assertEqual(self.bound("b"), "NameError",
                         "below the blank line, not above it")

    def test_a_cursor_on_line_zero_runs_nothing(self):
        result = self.above(0)
        self.assertTrue(result["ok"], "nothing to run is an outcome")
        self.assertEqual(result["statements"], 0)
        self.assertEqual(result["results"], [])
        self.assertNotIn("range", result)

    def test_a_cursor_past_the_last_statement_runs_the_whole_file(self):
        result = self.above(99)
        self.assertEqual((result["statements"], result["ran"]), (5, 5))
        self.assertEqual(self.bound("c"), "3")

    def test_a_failure_stops_the_run_and_nothing_after_it_is_attempted(self):
        source = "a = 1\nundefined_name\nb = 2\nc = 3\n"
        result = self.above(3, source=source)  # cursor on `c = 3`
        self.assertTrue(result["ok"])
        self.assertEqual(result["statements"], 3,
                         "three statements are above the cursor: `a`, the"
                         " failing line, and `b`")
        self.assertEqual(result["ran"], 1)
        self.assertEqual(len(result["results"]), 2,
                         "the failure itself is attempted and reported, but"
                         " `b` after it is not")
        self.assertFalse(result["results"][-1]["ok"])
        self.assertEqual(self.bound("a"), "1")
        self.assertEqual(self.bound("b"), "NameError",
                         "never attempted -- the run stopped before it")

    def test_the_namespace_is_reset_before_the_run(self):
        # Bind something unrelated first, the way an earlier keypress would.
        self.k.evaluate("stale = 'leftover'\n", 0)
        self.assertEqual(self.bound("stale"), "'leftover'")
        self.above(1, source="fresh = 1\n\n")
        self.assertEqual(self.bound("stale"), "NameError",
                         "a partial run's namespace must match the file, not"
                         " whatever an earlier keypress left behind")
        self.assertEqual(self.bound("fresh"), "1")

    def test_a_cursor_below_a_syntax_error_runs_the_valid_prefix(self):
        source = ("a = 1\n"
                   "b = 2\n"
                   's = "half-typed\n'
                   "c = 3\n")
        result = self.above(3, source=source)
        self.assertTrue(result["ok"], result)
        self.assertEqual((result["statements"], result["ran"]), (2, 2))
        self.assertEqual(self.bound("a"), "1")
        self.assertEqual(self.bound("b"), "2")
        self.assertEqual(result["partial"]["truncated_at"], 2)

    def test_a_response_over_a_file_that_parsed_whole_says_nothing_about_partial(
        self
    ):
        self.assertNotIn("partial", self.above(5))

    def test_the_range_covers_what_was_attempted_not_the_whole_boundary(self):
        source = "a = 1\nundefined_name\nb = 2\nc = 3\n"
        result = self.above(3, source=source)
        self.assertEqual(result["range"]["start"], {"line": 0, "character": 0})
        self.assertEqual(result["range"]["end"]["line"], 1)


if __name__ == "__main__":
    unittest.main()
