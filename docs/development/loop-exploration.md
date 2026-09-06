# Decision: iteration-linked loop exploration

> Status: Decided — defer production exploration; reject alignment of existing
> sequences. The investigation is complete.
> Issue: #159 loop-exploration
> Evidence date: 2026-09-06
> Baseline: `6f58e7e`

Bounded iteration correlation is feasible for a restricted loop shape, but
the current wire format cannot provide it. **Keep the existing separate
sequences and defer a production iteration explorer until an observed learner
task justifies its extra capture and interface.** Do not zip the sequences,
fill in unobserved values, or infer skipped branches from absent observations.

This is the written decision requested by the investigation ticket, not an
unfinished implementation. No production kernel, protocol or UI changes are
part of this decision. A future build requires its own execution-path ticket
and review of its protocol and trigger semantics.

## What was measured

Run the committed evidence script from the repository root:

```bash
python3 docs/development/loop-exploration-spike.py \
  > /private/tmp/evalens-loop-exploration-evidence.json
```

It executes only eight literal, self-contained fixtures declared in that
script. Each fixture starts a fresh real kernel subprocess and sends ordinary
JSON requests through the existing `kernel/test_kernel.py` harness. It does
not load a learner's files. Bytecode writing is disabled. The captured run is
in [loop-exploration-evidence.json](loop-exploration-evidence.json), with source,
requests' cursor positions, complete responses, hand-worked proposed rows,
Python version and measurements. The proposal is deliberately recorded in a
different section from observations: those rows cannot be reconstructed from
the current response.

Eight fixtures completed on Python 3.11.6, macOS. Assertions check the
specific mismatched counts, watch failures and compressed constants on which
this decision depends. This is kernel evidence, not visual or learner testing.

## What the existing capture can say

`kernel/loops.py` places the target recorder before the body and the binding
recorder after it. `src/kernel/protocol.ts` documents why `BindingTrace`
counts need not match `LoopTrace` counts. A child trace retains its first
observations, not necessarily the first iterations of its parent. Constant
compression retains one string, while failed watches retain only the first
exception and the count of additional failures.

| Fixture | Actual captured sequences | Hand-worked correspondence / limit |
|---|---|---|
| Accumulator | `x: 1,2,3,4`; `total: 1,3,6,10` | Iteration 3 pairs `x=3` at entry with `total=6` after the body. This easy case happens to align. |
| `continue` on odd inputs | `x: 1,2,3,4`; `doubled: 4,8` | Body observations belong to iterations 2 and 4. Pairing by array index incorrectly associates `4` with `x=1`. |
| `break` when `x==3` | `x: 1,2,3`; `doubled: 2,4` | Entry 3 was observed; the trailing hook was not. No observation of `doubled` on iteration 3 exists, even though the namespace still contains 4. |
| Watch `1/x` over `1,0,2,0,3` | Three values, first `ZeroDivisionError`, one additional failure | Values belong to iterations 1,3,5; failures to 2,4. The response does not carry those identities. |
| Constant `c=7` | `c: [7]`, `constant: true`, `count: 4` | The four observed values are equal. One stored string is not one observed iteration. Compression alone cannot establish parent iteration IDs. |
| Nested loops `outer: 10,20`, `inner: 1,2` | The ordinary outer evaluation exposes `outer: 10,20`; no inner binding trace in its response | Inner pairs `(10,1),(10,2),(20,1),(20,2)` need an invocation/parent identity, not just an inner ordinal. They are hand-worked here, not returned observations. |
| Filtered comprehension | Result `[4,8]`; clause draws `x: 1,2,3,4` | The clause hook observes inputs before filtering. It does not observe whether each draw emitted an element, nor map the output elements back to input IDs. |
| Binding assigned only on first iteration | `kept: [7]`, `constant: true`, `count: 3` | Once first observed, `kept` is read at later body ends even when no assignment ran there. Say “observed after the body,” not “assigned on this iteration.” |

The last case is why correlation would not become branch tracing. The
`LoopTrace.bind` identity check also withholds a name while it still holds
its pre-loop object. A missing observation can mean the hook was never
reached, the name was unavailable, or the recorder did not accept it as a
new loop observation. It does not identify which source branch ran.

The ordinary nested response above follows `Kernel._run` in
`kernel/evalens_kernel.py`: the primary loop and its bindings are selected
for display; an explicitly nominated watch has separate selection logic.
There is more instrumentation than the ordinary response exposes. Neither
the hidden recorders nor the displayed sequences provide an invocation tree.

## Candidate protocol if the decision is revisited

This is a concrete proposal for review, **not an implemented protocol**.
The first build would support one directly evaluated synchronous `for`
statement, no nested loop, no comprehension or generator, and at most the
three existing body-name traces plus one explicitly nominated watch. It
would not claim to show per-statement execution inside the body.

An explicit **Capture Loop Sample at Cursor** command would send the existing
`eval` request with `capture_loop_sample: true`; a separately nominated watch
would use `eval_watch` with the same flag. The command description must say
that it runs the enclosing loop once in the existing namespace. It must not
turn an old arbitrary watch into a new execution without nomination.

Ordinary evaluation requests omit the flag and retain their behavior and
cost. `loop_values: 0` disables sampling too: the kernel returns a sample
unavailable reason rather than silently instrumenting an opted-out loop.
Unsupported loop shapes are rejected by the sample command before execution;
they remain evaluable through the ordinary commands. No reset, preparatory
evaluation, or evaluation of neighboring statements is a fallback.

The evaluation response carries its existing fields plus an optional sample:

```json
{
  "loop_sample": {
    "version": 1,
    "site": {"start": {"line": 0, "character": 0}},
    "count": "4",
    "head_limit": 5,
    "fields": ["doubled"],
    "rows": [
      {"iteration": "1", "target": "1", "end_reached": false,
       "observations": {}},
      {"iteration": "2", "target": "2", "end_reached": true,
       "observations": {"doubled": {"value": "4"}}},
      {"iteration": "3", "target": "3", "end_reached": false,
       "observations": {}},
      {"iteration": "4", "target": "4", "end_reached": true,
       "observations": {"doubled": {"value": "8"}}}
    ],
    "omitted": "0"
  }
}
```

The sample is scoped to the existing response/request identity, document and
source snapshot, with `site` identifying the statement in that snapshot.
An iteration ID is a one-based ordinal incremented when the target recorder
is reached. It is unrelated to the target's value and resets per request.
Counts and IDs are decimal strings so the client does not round large Python
integers. The narrow supported shape has only one invocation per request;
nested loops would require a separate, reviewed identity scheme.

The shape's remaining rules are explicit:

- Retain the first five parent iterations and the final parent iteration,
  without duplicating the final row if it is already in the head. A zero-run
  loop has no rows. A rolling final row replaces the previous one at entry,
  so an early exit cannot leave the previous iteration masquerading as final.
- `omitted` counts parent iterations that actually ran but whose rows were
  discarded. For 100 iterations the selectable IDs are 1–5 and 100, with 94
  omitted. No control offers iteration 50 as if its data could be fetched.
- `end_reached` means the trailing capture point was reached. It does not
  mean a particular assignment ran or the whole loop finished successfully.
  An absent field in `observations` means **not observed**, never Python
  `None`, zero, the preceding value, or “skipped branch.”
- A captured watch uses either `{"value":"..."}` or
  `{"error":{"type":"...","message":"..."}}` in its nominated field.
  Per-retained-row errors preserve which sampled attempt failed; the existing
  aggregate failure counts continue separately. Errors on omitted iterations
  do not acquire invented locations. A watch not reached has no observation.
- The target is captured at entry; bindings and watches at their existing
  end-of-body capture points. The view labels those phases separately. It
  must not imply an atomic snapshot: a nominated watch can itself mutate state.
- The added hooks reuse strings produced by existing capture, not a second
  `repr`, property lookup or fresh value read. The existing binding eligibility
  rules remain intact. Marking the trailing point requires a hook even when
  there is no body name to report. Do not wrap the body in `finally` to invent
  a body-end observation after `continue`, `break`, `return` or an exception.
- Reaching a watch's existing success/failure handler updates only the current
  sampled row. Closing or navigating the view never reaches the kernel.
  An interrupted or failed evaluation can display retained observations with
  the existing failure status, but must never label the run complete.
- Captured strings remain frozen. Source edits use the normal stale/source
  correspondence behavior; a deleted or unlocatable statement loses its
  sample link. A new sample replaces the previous sample at that statement.
  Namespace reset/result clear drops samples with their annotations.

The disposable `ProposedRows` implementation in the evidence script uses
simplified observation values to measure row storage; it is not a codec or a
conformance test for this proposed schema. It does not implement AST hooks,
request handling, field caps, failure transport, or edit correspondence.

## Bounds and observed cost

The candidate retains at most six rows, each with one target and at most four
body/watch observations. Reuse the existing 200-character per-item cap
(`kernel/loops.py:ITEM_LIMIT`) and three-body-name cap (`BINDING_LIMIT`).
Cap field labels at 200 characters, error type/message together at 200, and
the serialized optional sample at 64 KiB. On that final guard, omit the sample
with an explicit unavailable reason; never truncate JSON or quietly drop a
field that would then look like an unobserved value.

This gives at most 30 retained value/error cells, approximately 6,000 Unicode
characters plus labels and structure. Worst-case JSON escaping makes the
wire cost larger than the string lengths; the final byte cap covers that.
IDs/counts add O(log N) digits: this is bounded in number of retained rows,
not a claim that arbitrarily large Python integers occupy constant bytes.
Extension storage must share the annotation lifecycle and existing per-load
limits; six rows per annotation is not six rows for the entire application.

The microbenchmark compares two existing `LoopTrace.record` calls per
iteration with those same calls plus the disposable head/tail row collector.
The collector reuses `latest` strings and never formats a value again.
Times are medians of three runs without allocation tracing. Memory is a
separate run with `tracemalloc`, including recorder construction; it excludes
JSON serialization. Payload sizes are compact UTF-8 JSON calculated from the
result, not the production kernel's framed bytes.

| Iterations | Existing capture, seconds | Plus rows, seconds | Retained bytes, existing / plus rows | Compact payload bytes, existing / plus rows |
|---|---:|---:|---:|---:|
| 1,000 | 0.000259 | 0.000516 | 1,701 / 4,860 | 157 / 702 |
| 10,000 | 0.002454 | 0.005099 | 1,703 / 4,831 | 161 / 711 |
| 100,000 | 0.024979 | 0.051213 | 1,705 / 4,794 | 165 / 720 |

The sample adds roughly 3.1 KiB retained storage for this one-binding case,
and about doubles this small recorder microbenchmark's time. Retained rows
do not grow with iteration count. Byte growth mostly comes from growing
decimal counts/values; minor memory variation comes from runtime allocation.
Peak traced bytes are in the JSON evidence as well.

These are not measurements of a full sampled kernel, VS Code, or a learner's
program. Frame reads, AST transformation, actual UI rendering, transport
framing and arbitrary-value formatting costs are outside the benchmark.
No claim about full-program slowdown, support-floor Python, a million-item
run, or an optimized implementation follows from these numbers. Production
instrumentation would need semantic and interrupt regressions checked before
its cost could be assessed against the existing evaluator.

## What a learner would see, and what would justify building it

The interaction sketch for the filter example is a static view of captured
data, reached from the result after an explicitly requested sample:

```text
Loop sample — 4 observed iterations
Select: [1] [2] [3] [4]

Iteration 2
At entry:             x = 2
After body capture:   doubled = 4

Iteration 3
At entry:             x = 3
After body capture:   not observed
```

For a long run, the controls show `1 2 3 4 5 … 100` and say “94 iterations
omitted.” They never offer a slider across unrecorded rows. Keyboard movement
and clicks select cached rows only. “Not observed” deliberately leaves the
reader to inspect the `continue`; there is no claim that the tool recorded
the branch. The existing inline annotation stays the primary answer.

This can answer “which input went with this output?” more directly than
independent histories. For an ordinary accumulator with equal counts, the
existing sequences already answer that question compactly. A new view adds
a second interaction and additional vocabulary, so general learning benefit
does not follow from technical feasibility.

Revisit the defer decision when a learner, using the existing sequences on
the accumulator and filter tasks, cannot reliably associate inputs and
outputs, and a paper or static version of this sample view resolves that
specific difficulty. Also record whether the honest “not observed” wording
helps or merely demands branch tracing. The current corpus audit is useful
for output regressions but does not measure either behavior.

If that evidence favors a build, scope its first ticket to the single-loop
shape and protocol above. Compare actual instrumented execution and capture
cost against the existing kernel; verify `continue`, `break`, watch failures,
zero iterations, interrupt, body exceptions, constant and retained bindings,
namespace reset and edits. A protocol that changes Python semantics, needs
unbounded capture, or still cannot explain gaps honestly is a no-go. If the
existing view answers the learner tasks adequately, retain it and close the
feature question without a build. Nested loops and comprehension output
correlation remain separate decisions, even if the first scope succeeds.
