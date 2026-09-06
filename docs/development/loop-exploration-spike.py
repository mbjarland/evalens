"""Reproduce #159's capture evidence; not extension or kernel production code.

Run from any directory with Python 3.9+. Only the literal fixtures below run.
The real-kernel fixture results are separate from the hand-worked proposed
rows and the deliberately limited recorder microbenchmark.
"""

import gc
import json
import os
from pathlib import Path
import platform
import statistics
import sys
import time
import tracemalloc

sys.dont_write_bytecode = True
os.environ["PYTHONDONTWRITEBYTECODE"] = "1"
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "kernel"))
from loops import LoopTrace  # noqa: E402
from test_kernel import KernelProcess  # noqa: E402


FIXTURES = [
    ("accumulator", "total = 0\nfor x in [1, 2, 3, 4]:\n    total += x\n",
     [0], 1, None),
    ("continue", "for x in [1, 2, 3, 4]:\n    if x % 2:\n"
     "        continue\n    doubled = x * 2\n", [], 0, None),
    ("break", "for x in [1, 2, 3, 4]:\n    if x == 3:\n"
     "        break\n    doubled = x * 2\n", [], 0, None),
    ("failing_watch", "for x in [1, 0, 2, 0, 3]:\n    pass\n",
     [], 0, "1/x"),
    ("constant", "for x in [1, 2, 3, 4]:\n    c = 7\n", [], 0, None),
    ("nested", "for outer in [10, 20]:\n    for inner in [1, 2]:\n"
     "        pair = (outer, inner)\n", [], 0, None),
    ("comprehension", "kept = [x * 2 for x in [1, 2, 3, 4] if x % 2 == 0]\n",
     [], 0, None),
    ("retained_binding", "for x in [1, 2, 3]:\n    if x == 1:\n"
     "        kept = 7\n", [], 0, None),
]


def compact_bytes(value):
    return len(json.dumps(value, separators=(",", ":")).encode("utf-8"))


def observations():
    results = []
    for name, source, setup, line, watch in FIXTURES:
        kernel = KernelProcess(control=False)
        try:
            for first in setup:
                assert kernel.evaluate(source, first)["ok"]
            response = (kernel.watch(source, line, watch) if watch
                        else kernel.evaluate(source, line))
            assert response["ok"], response
            response.pop("id", None)
            results.append({"case": name, "source": source, "line": line,
                            "watch": watch, "response": response,
                            "response_compact_bytes": compact_bytes(response)})
        finally:
            kernel.close()
    # These are substantive checks on the claimed information loss, not a
    # test of the proposed representation against its own constructor.
    cases = {result["case"]: result["response"] for result in results}
    binding = lambda case, name: next(
        b for b in cases[case]["bindings"] if b["name"] == name)
    assert cases["continue"]["loop"]["count"] == 4
    assert binding("continue", "doubled")["values"] == ["4", "8"]
    assert cases["break"]["loop"]["count"] == 3
    assert binding("break", "doubled")["count"] == 2
    assert binding("failing_watch", "1/x")["count"] == 3
    assert binding("failing_watch", "1/x")["failed"] == 1
    assert binding("constant", "c")["constant"] is True
    assert binding("constant", "c")["values"] == ["7"]
    assert binding("retained_binding", "kept")["count"] == 3
    assert binding("retained_binding", "kept")["constant"] is True
    return results


class ProposedRows:
    """Disposable fixed head+tail sample; already-captured strings only.

    This does not instrument Python, infer branches, or provide an API.
    An omitted middle row has no retained object. One tail row is replaced
    on each begin, including an iteration whose end hook never happens.
    """

    def __init__(self, limit=5):
        self.limit = limit
        self.head = []
        self.tail = None
        self.current = None
        self.count = 0

    def begin(self, text):
        self.count += 1
        self.current = {"iteration": str(self.count), "target": text,
                        "end_reached": False, "observations": {}}
        if len(self.head) < self.limit:
            self.head.append(self.current)
        else:
            self.tail = self.current

    def end(self, captured):
        self.current["end_reached"] = True
        self.current["observations"] = captured

    def wire(self):
        rows = self.head + ([self.tail] if self.tail is not None else [])
        return {"count": str(self.count), "rows": rows,
                "omitted": str(self.count - len(rows))}


def proposed_examples():
    # Hand-worked from these literal fixtures, NOT reconstructed from the
    # kernel response. Existing messages cannot yield these identities.
    specifications = {
        "accumulator": [(1, {"total": "1"}), (2, {"total": "3"}),
                        (3, {"total": "6"}), (4, {"total": "10"})],
        "continue": [(1, None), (2, {"doubled": "4"}),
                     (3, None), (4, {"doubled": "8"})],
        "break": [(1, {"doubled": "2"}), (2, {"doubled": "4"}),
                  (3, None)],
        "failing_watch": [(1, {"1/x": "1.0"}),
                          (0, {"1/x": {"error": "ZeroDivisionError"}}),
                          (2, {"1/x": "0.5"}),
                          (0, {"1/x": {"error": "ZeroDivisionError"}}),
                          (3, {"1/x": "0.3333333333333333"})],
        "constant": [(x, {"c": "7"}) for x in [1, 2, 3, 4]],
    }
    output = {}
    for name, events in specifications.items():
        rows = ProposedRows()
        for target, at_end in events:
            rows.begin(repr(target))
            if at_end is not None:
                rows.end(at_end)
        output[name] = rows.wire()
    output["nested"] = {
        "supported_in_first_build": False,
        "hand_worked_inner_samples": [
            {"outer_iteration": str(outer), "inner_iteration": str(inner),
             "pair": repr((value, inner))}
            for outer, value in enumerate([10, 20], 1)
            for inner in [1, 2]],
        "missing_protocol_identity": "loop site plus invocation/parent path",
    }
    output["comprehension"] = {
        "supported_in_first_build": False,
        "clause_draws": [{"iteration": str(i), "target": repr(i)}
                         for i in [1, 2, 3, 4]],
        "result": "[4, 8]",
        "element_correspondence": "not observed by the current clause hook",
    }
    return output


def capture(size, proposed):
    # Existing repr work remains identical: two production record() calls.
    # The proposal reuses those strings, not values or a second repr().
    target, body = LoopTrace(repr), LoopTrace(repr)
    rows = ProposedRows() if proposed else None
    for i in range(size):
        target.record(i)
        if rows is not None:
            rows.begin(target.latest)
        body.record(i * 2)
        if rows is not None:
            rows.end({"doubled": body.latest})
    return target, body, rows


def measure(size, proposed):
    samples = []
    for _ in range(3):
        gc.collect()
        start = time.perf_counter()
        capture(size, proposed)
        samples.append(time.perf_counter() - start)
    gc.collect()
    tracemalloc.start()
    target, body, rows = capture(size, proposed)
    retained, peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    wire = {"loop": target.wire(), "bindings": [body.named_wire("doubled")]}
    if rows is not None:
        wire["sample"] = rows.wire()
    return {"iterations": size, "proposal_added": proposed,
            "median_seconds": round(statistics.median(samples), 6),
            "retained_traced_bytes": retained, "peak_traced_bytes": peak,
            "compact_payload_bytes": compact_bytes(wire)}


if __name__ == "__main__":
    print(json.dumps({
        "python": platform.python_version(), "platform": platform.system(),
        "fixture_transport": "real kernel subprocess, JSON request/response",
        "observations": observations(),
        "proposed_hand_worked": proposed_examples(),
        "recorder_microbenchmark": [measure(n, proposed)
                                   for n in [1000, 10000, 100000]
                                   for proposed in [False, True]],
        "limitations": [
            "Microbenchmark excludes AST rewrite, frame reads and UI.",
            "Memory is Python traced allocations, not process RSS.",
            "Compact JSON bytes are calculated, not actual framing bytes.",
            "Proposed examples are manually correlated, never decoded from legacy traces.",
            "No timing or memory thresholds; numbers vary by interpreter and machine.",
        ],
    }, indent=2))
