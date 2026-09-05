"""Tests for a file load reporting each statement as it finishes.

Driven as a real subprocess over real pipes, like `test_kernel`, and for a
reason this file leans on harder than most: the property being tested is
*when* a message is written relative to another one on a different pipe. That
is a property of two OS pipes and a blocked interpreter, and it is not
observable by calling `Kernel.evaluate_file` in process -- an in-process test
would see every frame after the fact and call the ordering proved.

The complaint these exist for, in the maintainer's words: *"when evaling more
than one line and there is input request, the line requesting needs to be more
prominently marked and the lines before that line which were evaled should
already have their inline values displayed"*. The second half is what a kernel
can be held to, and it is what is asserted here -- the outcomes for the
statements above the prompt reach the extension **before** the prompt does.
"""

import unittest

from test_kernel import CAN_OPEN_CONTROL, KernelProcess, KernelTest


def statements(kernel, count):
    """The next ``count`` statement frames, skipping the rest of the chatter.

    Status and stream frames share this channel, so a test that enumerated
    every message would be pinned to the interleaving of two independent
    streams rather than to the order this file is about.
    """
    seen = []
    while len(seen) < count:
        message = kernel.read_control()
        if message.get("op") == "statement":
            seen.append(message)
    return seen


@unittest.skipUnless(CAN_OPEN_CONTROL, "no control channel on this platform")
class StatementFrames(KernelTest):
    def test_each_statement_is_announced_before_the_load_answers(self):
        # The defect, at its smallest: three statements used to produce three
        # values and one message, at the end. Nothing here reads the response
        # until every frame has been taken off the control channel, so the
        # assertion is about arrival and not merely about content.
        request_id = self.k.send_async(
            op="eval_file", allow_stdin=False,
            source="a = 1\nb = a + 1\nc = b + 1\n",
            filename="/tmp/three.py")

        frames = statements(self.k, 3)
        self.assertEqual([f["index"] for f in frames], [0, 1, 2],
                         "announced in file order")
        self.assertEqual([f["id"] for f in frames],
                         [request_id, request_id, request_id],
                         "each says which load it belongs to")
        self.assertEqual([f["outcome"]["value"] for f in frames],
                         ["1", "2", "3"])

        result = self.k.read()
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["ran"], 3)

    def test_a_frame_carries_exactly_what_results_carries(self):
        # Two deliveries of one fact, and they must not be allowed to drift.
        # If a frame were ever a summary of its `results` entry, a load painted
        # from frames would look different from the same load painted from the
        # response -- and which one the user got would depend on a race.
        self.k.send_async(op="eval_file", allow_stdin=False,
                          source="import math\nr = 2\narea = math.pi * r * r\n",
                          filename="/tmp/area.py")

        frames = statements(self.k, 3)
        result = self.k.read()

        self.assertEqual([f["outcome"] for f in frames], result["results"])

    def test_the_lines_above_a_prompt_report_before_the_prompt_does(self):
        # The maintainer's complaint, stated as an ordering. The load stops on
        # line 3; lines 0 to 2 have run, their values are in the kernel, and
        # until now the extension heard about none of them until the whole file
        # was over -- so the box asking for a value opened over an empty file.
        self.k.send_async(
            op="eval_file", allow_stdin=True,
            source=("greeting = 'hello'\n"
                    "count = 3\n"
                    "print(greeting * count)\n"
                    "name = input('who? ')\n"
                    "shouted = name.upper()\n"),
            filename="/tmp/prompted.py")

        # Read the control channel in the order the kernel wrote it, taking
        # nothing on trust: the first three statement frames must be there
        # before the prompt, or this loop reaches the prompt with fewer.
        before = []
        while True:
            prompt = self.k.read_control()
            if prompt.get("op") == "input_request":
                break
            if prompt.get("op") == "statement":
                before.append(prompt)

        self.assertEqual([f["index"] for f in before], [0, 1, 2],
                         "every statement above the prompt reported first")
        self.assertEqual(before[0]["outcome"]["value"], "'hello'")
        self.assertEqual(before[1]["outcome"]["value"], "3")
        self.assertEqual(before[2]["outcome"]["stdout"],
                         "hellohellohello\n")

        self.k.send_control(op="input_reply", seq=prompt["seq"], value="Ada")

        after = statements(self.k, 2)
        self.assertEqual([f["index"] for f in after], [3, 4])
        self.assertEqual(after[0]["outcome"]["value"], "'Ada'")
        self.assertEqual(after[1]["outcome"]["value"], "'ADA'")

        result = self.k.read()
        self.assertEqual(result["ran"], 5)

    def test_the_prompting_statement_reports_after_it_is_answered(self):
        # Which is what lets the extension leave a mark on the blocked line
        # until the statement itself is done, rather than taking it away the
        # moment the box closes. The statement is still running then, and a
        # line that has gone quiet without producing anything is exactly the
        # thing the mark exists to prevent.
        self.k.send_async(op="eval_file", allow_stdin=True,
                          source="before = 1\nname = input('who? ')\n",
                          filename="/tmp/blocked.py")

        first = statements(self.k, 1)[0]
        self.assertEqual(first["index"], 0)

        prompt = self.k.read_control_until("input_request")
        self.assertEqual(prompt["range"]["start"]["line"], 1)

        self.k.send_control(op="input_reply", seq=prompt["seq"], value="Ada")
        second = statements(self.k, 1)[0]
        self.assertEqual(second["index"], 1)
        self.assertEqual(second["outcome"]["value"], "'Ada'")
        self.k.read()

    def test_a_statement_that_raised_is_announced_like_any_other(self):
        # Failures do not stop a load, so they must not stop the reporting of
        # one either -- a file being explored in is expected to contain broken
        # lines, and a gap in the frames would leave the extension unable to
        # tell a failure from a lost message.
        self.k.send_async(op="eval_file", allow_stdin=False,
                          source="a = 1\nnope\nb = 2\n",
                          filename="/tmp/broken.py")

        frames = statements(self.k, 3)
        self.assertEqual([f["index"] for f in frames], [0, 1, 2])
        self.assertTrue(frames[0]["outcome"]["ok"])
        self.assertFalse(frames[1]["outcome"]["ok"])
        self.assertEqual(frames[1]["outcome"]["error"]["type"], "NameError")
        self.assertTrue(frames[2]["outcome"]["ok"])
        self.k.read()

    def test_a_selection_reports_the_statements_it_ran_from_zero(self):
        # The index is a position in `results`, not a line number. A selection
        # runs part of a file and `results` holds only that part, so an index
        # counted from the top of the file would put every frame past the end
        # of the list the response comes back with.
        self.k.send_async(op="eval_file", allow_stdin=False,
                          source="a = 1\nb = 2\nc = 3\nd = 4\n",
                          filename="/tmp/slice.py", start_line=1, end_line=2)

        frames = statements(self.k, 2)
        result = self.k.read()

        self.assertEqual([f["index"] for f in frames], [0, 1])
        self.assertEqual([f["outcome"] for f in frames], result["results"])
        self.assertEqual(result["statements"], 2)

    def test_a_single_evaluation_announces_no_statement(self):
        # The frames belong to a load. `eval` answers about one statement and
        # its response *is* the answer, so a frame there would be the same fact
        # arriving twice with nothing to reconcile it against -- and the cursor
        # path paints unconditionally, so it would paint both.
        self.k.send_async(op="eval", source="x = 1\n", line=0)

        seen = []
        while True:
            message = self.k.read_control()
            seen.append(message.get("op"))
            if message.get("op") == "status" and message.get("state") == "idle":
                break

        self.assertEqual(seen, ["status", "status"],
                         "busy, then idle, and nothing about a statement")
        self.assertTrue(self.k.read()["ok"])


class WithoutTheControlChannel(unittest.TestCase):
    """A kernel spawned with three pipes, which is what it was before #26.

    Streaming has to be an addition rather than a migration: a caller that
    cannot hear the frames must still get the whole load in the response, and
    get it unchanged. Two protocols half-done is the failure mode this guards
    against.
    """

    def setUp(self):
        self.k = KernelProcess(control=False)
        self.addCleanup(self.k.close)

    def test_the_whole_load_still_arrives_in_one_response(self):
        result = self.k.send(op="eval_file", allow_stdin=False,
                             source="a = 1\nb = a + 1\nc = b + 1\n",
                             filename="/tmp/quiet.py")
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["ran"], 3)
        self.assertEqual([r["value"] for r in result["results"]],
                         ["1", "2", "3"])

    def test_announcing_a_statement_does_not_write_on_the_protocol_pipe(self):
        # The failure this would have if `control` were ever made to fall back
        # to stdout: a frame spliced onto the front of a response destroys an
        # answer that was computed correctly. `send` reads exactly one line,
        # so a frame written there makes this fail rather than pass quietly.
        result = self.k.send(op="eval_file", allow_stdin=False,
                             source="a = 1\nb = 2\n",
                             filename="/tmp/clean.py")
        self.assertEqual(result["ok"], True)
        self.assertEqual(len(result["results"]), 2)


if __name__ == "__main__":
    unittest.main()
