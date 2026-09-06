import json
import unittest

from capture import OutputCapture, OUTPUT_LIMIT
from test_kernel import CAN_OPEN_CONTROL, KernelProcess


class BoundedCapture(unittest.TestCase):
    def test_small_output_is_unchanged_and_omissions_are_counted(self):
        capture = OutputCapture(limit=10)
        self.assertEqual(capture.write("hello"), 5)
        self.assertEqual(capture.getvalue(), "hello")
        capture.write(" world" * 10000)
        self.assertEqual(capture.getvalue(),
                         "hello worl\n… <59,995 characters omitted from trace>\n")

    def test_prompt_tail_is_independent_of_full_output_capture(self):
        capture = OutputCapture(limit=10, prompt_limit=5)
        capture.write("x" * 100000)
        self.assertEqual(capture.tail(), "xxxxxx")
        capture.write("\nAsk")
        capture.write("? ")
        self.assertEqual(capture.tail(), "Ask? ")
        capture.write("\n")
        self.assertEqual(capture.tail(), "")

    def test_wire_stdout_and_stderr_stay_bounded_without_control(self):
        kernel = KernelProcess(control=False)
        self.addCleanup(kernel.close)
        kernel.evaluate("import sys", 0)
        for name in ("stdout", "stderr"):
            result = kernel.evaluate(f"sys.{name}.write('x' * 200000)", 0)
            self.assertTrue(result["ok"], result)
            self.assertLess(len(result[name]), OUTPUT_LIMIT + 100)
            self.assertIn("134,464 characters omitted", result[name])
            self.assertLess(len(json.dumps(result)), OUTPUT_LIMIT + 3000)

    @unittest.skipUnless(CAN_OPEN_CONTROL, "no control channel")
    def test_full_live_output_survives_and_prompt_after_cap_is_correct(self):
        kernel = KernelProcess()
        self.addCleanup(kernel.close)
        kernel.send(op="eval_file", source=(
            "def noisy():\n"
            "    print('x' * 200000)\n"
            "    return input('Continue? ')\n"))
        kernel.send_async(op="eval", source="noisy()", line=0, allow_stdin=True)
        streamed = []
        while True:
            frame = kernel.read_control()
            if frame.get("op") == "stream" and frame["name"] == "stdout":
                streamed.append(frame["text"])
            if frame.get("op") == "input_request":
                break
        self.assertEqual("".join(streamed), "x" * 200000 + "\nContinue? ")
        self.assertEqual(frame["prompt"], "Continue? ")
        kernel.send_control(op="input_reply", seq=frame["seq"], value="yes")
        result = kernel.read()
        self.assertTrue(result["ok"], result)
        self.assertLess(len(result["stdout"]), OUTPUT_LIMIT + 100)
        self.assertIn("characters omitted from trace", result["stdout"])
