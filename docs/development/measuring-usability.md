# Measuring usability against a real corpus

> Status: Current
> Audience: AI agents and the maintainer
> Source of truth for: how "is this usable yet" is turned into a number
> Last verified: 2026-09-05

Quality here was being judged from screenshots. That found five real defects
in one session — #68 through #74 all came out of somebody looking at a file —
but a screenshot cannot say whether the tool is getting *better*, and it
cannot catch a regression at all. Design rule 10 says verify against reality;
this is the part of that which can be re-run.

`bin/audit-corpus.js` loads every Python file in a directory through the real
kernel and counts what a reader would see beside each line.

```bash
npm run compile                      # the harness reads out/, not src/
node bin/audit-corpus.js --help
node bin/audit-corpus.js             # the corpus defaults to examples/
```

Nothing in it is a fixture. The kernel is spawned as a subprocess and spoken
to over both its pipes by the same `KernelClient` the extension uses; every
response becomes an annotation by the same rules `evaluate.ts` applies, is
passed through the same `PaintedAbove` repeat rule, is rendered by the same
`resultText`, and is dropped by the same `restatesLine` check the decorator
makes at paint time. A reading taken here is a reading of the code that ships.

## Running it against the course

The corpus is a parameter so the harness runs for anyone who clones the repo.
The reading that matters is taken against the maintainer's own teaching
material, which is **not** committed here:

```bash
node bin/audit-corpus.js \
  --corpus ~/projects/python-walkthrough \
  --include '[0-9]*.py' \
  --listings /tmp/evalens-listings \
  --json /tmp/evalens-reading.json
```

`--include` matters for comparability: the recorded baseline covers the eleven
numbered modules and not the `main.py` beside them.

The harness sets `PYTHONDONTWRITEBYTECODE=1` before it spawns anything, so an
audit never leaves `__pycache__` behind in a corpus it was only asked to read.

## Reading the numbers

| column | what it counts |
|---|---|
| `stmts` / `ran` / `err` | top-level statements attempted, and how they ended |
| `painted` | annotations a reader would actually see |
| `=> None` | annotations whose **whole** text is `=> None` |
| `silent` | ran, and nothing at all appeared on the line |
| `repeat` / `restates` / `no value` | the three reasons a line stayed empty |

Two of these need care.

**`=> None` is split three ways, and only the first is the historical
complaint.** `y = None` paints `y: None`, which is a fact about the namespace;
`None` sitting among other values on a line is not a defect under any reading.
Only "the whole annotation is `=> None`" is the thing 160 lines of the course
used to say. Folding them together would let a fix and a regression move the
same number in the same direction.

**What the harness cannot decide is whether the reader wanted something
else.** `d.get("missing")` really did evaluate to `None` and no other answer
exists; `queue.put(x)` also evaluates to `None` and the reader wanted the
queue. That is a judgement about intent, and a number invented for it would be
worse than none — so the raw count is reported and every bare `=> None` is
listed with the expression that produced it, for a human to read.

**`silent` is not the same as `=> None`, and it is the one that matters
most.** A line that says `=> None` at least says something; a line that says
nothing is indistinguishable from a line that was never evaluated. Two of its
three reasons are deliberate — the value is already painted above (#28), or
the annotation would only restate the line (#50) — and the third, "ran and had
nothing to report", is the bucket worth reading by hand. It is broken down by
statement kind for exactly that.

## What it still does not prove

It knows the string that would be painted and the line it would be painted on.
It does not know that a human found it legible, that the colours separate, or
that the column lands where the eye expects. Design rule 11: say what was not
verified.

`--listings` is the answer to as much of that as can be answered without an
editor. It writes one annotated copy of each file — every source line with the
annotation that would sit beside it, and the reason where there is none.
Reading one end to end is the closest thing to using the tool that does not
require launching one, and it has caught defects that every unit test missed.
Keep the listings out of the repository when the corpus is somebody's course.
