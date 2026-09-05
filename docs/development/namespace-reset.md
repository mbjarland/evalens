# Loading a file and the namespace: what resets, and when

> Status: Current
> Audience: AI agents and the maintainer
> Source of truth for: what "load a file" does to the kernel's namespace,
> and the semantics `Evaluate File`, `Run File as Script`, and the input
> replay store must agree on
> Last verified: 2026-09-05

This is the decision #56 asked for. It is a written call, not a build — see
`docs/development/issue-tracking.md` for what a decision/spike ticket owes a
reader. Everything under "What happens today" was run against the real
`Kernel` class in `kernel/evalens_kernel.py`, not inferred from reading it —
design rule 10.

## The question

`Kernel.evaluate_file` runs every top-level statement in a file into
`self.namespace` and never calls `self.reset()`. Two files, or two loads of
one file, can therefore see each other's leftovers. Whether that is the
right behaviour, the wrong one, or half of a decision that needs a second
command has never been settled — the current behaviour is what the code
happened to do the day `eval_file` was written, not a choice.

## What happens today, verified against the running kernel

Verified by instantiating `Kernel` directly from `kernel/evalens_kernel.py`
and calling `evaluate_file`/`reset` exactly as `Kernel.handle` dispatches
them — the wire protocol and the extension add no logic between a request
and these two methods (`handle` calls `self.evaluate_file(request)` and
`self.reset()` with nothing in between; `src/evaluate.ts` and
`src/kernel/client.ts` add no reset of their own). What follows is not
inferred; it is three runs and their actual output. Not verified: the
rendering side, i.e. what a human sees painted in a real editor for the same
sequence — that is a `render` question, not this one, and #96/#51/#8 already
own it (see below).

**1. Deleting a binding and reloading the same file does not delete it from
the namespace.**

```python
k = Kernel()
k.evaluate_file({"op": "eval_file", "source": "x = 42\n",
                  "filename": "/tmp/f1.py"})
# k.namespace["x"] == 42

k.evaluate_file({"op": "eval_file", "source": "y = 1\n",
                  "filename": "/tmp/f1.py"})   # same file, x deleted
# k.namespace["x"] == 42   -- still there. k.namespace["y"] == 1
```

This is the exact scenario the ticket describes: a line is deleted, the file
is reloaded, and the binding it made survives regardless. `x` is not in
`f1.py` any more in any form, and the namespace still answers `42` for it.

**2. The residue is not scoped to the file that made it.** Loading an
unrelated second file reads straight through to the first file's leftovers:

```python
k.evaluate_file({"op": "eval_file", "source": "x = 100\n",
                  "filename": "/tmp/a.py"})

k.evaluate_file({"op": "eval_file", "source": "z = 7\nprint(x)\n",
                  "filename": "/tmp/b.py"})
# ok: True, ran: 2 -- print(x) succeeds and prints 100
# `x` appears nowhere in b.py
```

`b.py` has no `x` anywhere in its text and its load reports success and
prints `100`. This is a sharper case than the one in the ticket: the
namespace is a property of the kernel process, not of the file being
loaded, so the failure mode is not "this file's edits are stale" but "any
file loaded into a kernel that has ever loaded anything else inherits
whatever that was." A student who closes `a.py` and opens an unrelated
`b.py` in the same window gets `a.py`'s state for free and has no way to
know it.

**3. The `reset` op already exists, is fully correct, and is unreachable
from the UI except by paying for a full process restart.**

```python
k.reset()
# k.namespace == {"__builtins__": ..., "__name__": "__evalens__"}
```

`Kernel.reset()` clears the namespace correctly — confirmed above. But
nothing in the extension ever sends `op: "reset"`: `src/kernel/protocol.ts`
declares the request shape and no caller constructs one (`grep` across
`src/**/*.ts` for `op: 'reset'` and for `"reset"` finds only that type
declaration). The only UI path to a clean namespace is
`evalens.restartKernel`, which does not send `reset` either — it kills the
kernel subprocess and spawns a new one (`client.restart()` then
`client.dispose()` in `src/extension.ts`), which also re-probes the
interpreter. A feature that already exists in the kernel and costs nothing
to wire up is being paid for as a process restart instead.

**4. `Evaluate File`'s one-keystroke path is the non-resetting one.**
`package.json` binds `evalens.evaluateFile` to `Cmd/Ctrl+Alt+Enter` with no
default binding on `evalens.restartKernel`. Whatever `Evaluate File` does
today is what a user gets from a single, unmodified keystroke — which
matters below, because a two-command fix that leaves the fast path pointed
at the wrong one has not actually fixed the default.

**5. `Evaluate File` already means "run a selection" when there is one.**
`evaluateFile` in `src/evaluate.ts` sends `start_line`/`end_line` when the
editor has a selection, narrowing the load to the statements it touches —
this is Calva's `eval-region` riding the same command. Any change to
`Evaluate File`'s reset behaviour has to say what a selection does to it,
because "the whole namespace resets, then only three lines run" is a
confusing state nobody asked for.

## What #51/#8/#96 already solve, and what they do not

The ticket asks specifically whether the stale-marking machinery is already
the middle path. It is not, and the reason is precise enough to state
exactly: **#51, #8, and #96 all operate on the annotation layer, keyed to a
source range. The moment a statement's range is gone from the file — deleted,
commented out — its annotation is dropped, not marked stale (#96 pins
exactly this: dropping is correct, marking stale is not, "there is no
statement here to have run").** That is the right answer to "is what's
painted on screen still true," and it means a deleted line leaves nothing
false on screen.

It says nothing about the kernel. Delete `x = 5` from a file, reload, and the
annotation beside where that line used to be is correctly gone — and `x` is
still sitting in `self.namespace`, reachable by anything else in the file
that names it, exactly as demonstrated above. The two failure modes look
identical from a debugger's perspective (both are "old state hanging
around") and are handled by completely different layers: one is "does the
picture on screen match reality," fixed; the other is "does reality itself
still hold something nothing points at any more," open. #59 (an annotation
whose *inputs* changed) is the same story one level up — still a rendering
question about a surviving annotation, not about the namespace holding a
name no surviving statement produced.

So the answer to "is this already handled" is no, but the finding is useful:
whatever ships for #56 does not need to touch the stale-marking machinery,
and the stale-marking machinery does not need to touch this. They compose.

## The options

**1. Two commands: `Evaluate File` (as today) and a resetting variant —
recommended, with one change from how #56 originally proposed it.**
`Kernel.reset()` already exists and is already correct; wiring `op: reset`
in front of an `eval_file` request is the entire kernel-side cost. This is
JupyterLab's actual pair (`Run All` / `Restart Kernel and Run All`) and
Emacs' underlying principle — load should be idempotent, deliberate
re-evaluation is allowed to be destructive — bought without rewriting a
single user statement, exactly as #56 argues.

Where this decision goes further than the ticket's own phrasing: **the
resetting command should own the existing keybinding
(`Cmd/Ctrl+Alt+Enter`), not the non-resetting one.** #56 says "make the
resetting one the obvious default in the palette," which fixes what a user
sees when they open the command palette and reads nothing about what a
single keystroke does. `IDEA.md` names the exact failure this decision
exists to avoid: *"'Restart and run all' is the discipline notebook users
are supposed to remember and mostly do not."* A default that requires
remembering to reach for a second, differently-named command is the same
discipline by another name. The one-key path has to be the correct one; the
non-resetting command is the one that should require deliberately reaching
for the palette (or a second modifier), because it is the power-user
shortcut ("I don't want to pay for the slow setup at the top again"), not
the default expectation.

**Selection carve-out, made explicit because #56 did not address it:** the
resetting command must always target the *whole file*, regardless of any
active selection. Resetting the namespace and then running only a selected
range would leave everything above the selection unbound — worse than doing
nothing, because it looks like a normal partial run and silently is not one.
`Evaluate File` on a selection keeps meaning exactly what it means today
("run this part of my file," Calva's `eval-region`), and is one of the two
commands the two-command split does not change.

Honest weakness, unchanged from the ticket: a user who reaches for the
non-resetting command (now the deliberate one) still accumulates residue if
they use it as their only load command. That is an argument for a visible
signal when they do — see the middle path below — not an argument against
the split.

**2. Always reset on load — rejected as the single behaviour, but see #78
below.** Simplest to explain, and always correct in the narrow sense that a
loaded namespace never lies. Rejected for `Evaluate File` for the reason #56
gives: it makes the command unusable on any file whose setup is slow, and
that is not a hypothetical — it is Spyder's own users' stated reason for
wanting cells at all (`https://github.com/spyder-ide/spyder/issues/117`:
*"what if func1 and/or func2 do some heavy stuff I don't want to repeat
every time I modify func3?"*). Forcing a reset on every load punishes
exactly the iterate-on-the-bottom-of-a-file workflow this project is built
to support.

**3. Leave it, document it — rejected.** Cheapest, and the option under
which the failure mode keeps recurring silently, which is precisely what
`IDEA.md`'s "Three obligations" section commits this project against:
*"Load-versus-re-evaluate semantics have to be decided rather than
defaulted."* A comment in a docstring does not stop a first-year student
from hitting the exact bug the ticket opens with.

**The middle path — recommended as an addition to option 1, not a
replacement for it.** #56 asks for "a middle path (reset on demand, with a
visible indication of staleness)" to be weighed. Options 1 and this are not
alternatives: option 1 answers "what does pressing the key do," and a
residue indicator answers "how do you know the non-resetting choice cost you
anything." The kernel already has everything needed to compute it —
`outline` reports every top-level statement's bindings, and a diff against
`self.namespace`'s keys says which names in the namespace are not produced
by anything currently in the file. That is a distinct, cheap feature and it
is filed as its own follow-up rather than folded into #56 doing more than a
decision should.

## The decision

**Adopt option 1.** `Evaluate File` keeps today's behaviour and its
selection carve-out. A new command resets the namespace first and then runs
the whole file; it takes over the existing default keybinding
(`Cmd/Ctrl+Alt+Enter`). `Evaluate File` moves to the command palette only,
or a keybinding with an extra modifier, for the case that motivates keeping
it at all: expensive setup code you do not want to re-pay.

This is the load-time half of the answer `IDEA.md` says a reader would
otherwise have to re-derive (`IDEA.md`, "What is not decided": *"letting it
default silently is the notebook mistake in miniature"*) — the default no
longer defaults silently; it resets, and the non-resetting choice has to be
reached for on purpose.

### #78 — Run File as Script

#78 explicitly deferred a sub-question to this ticket: *"whether a script
run resets the namespace first."* **Yes, unconditionally, no second
variant.** `Run File as Script` exists to answer "does this behave the way
`python3 file.py` would," and that comparison is void the moment the
namespace is not what a fresh interpreter would have. Unlike `Evaluate
File`, there is no legitimate "keep the old namespace" reading of "run this
as a script" — running a script twice from a shell does not remember the
first run's variables, and a command whose entire selling point is fidelity
to that model cannot quietly stop matching it. If someone wants to reuse
expensive setup while poking at a `__main__` block, the existing workaround
#78 names — evaluating the guard's body directly — is the right tool for
that, not a second flavour of "run as script."

### #86 — canned input() answers

#86 asks whether the replay store (mechanism 1: reuse what was typed last
time) should follow the same rule. **Yes, for the replay store; no, for the
`# evalens:` comment.** The comment is source text — it is part of the file,
survives a reset because a reset clears the namespace, not the file, and
`python file.py` still asks a real human exactly as #86 requires. The
replay store is a second kind of state that is not visible in the source at
all, and #86 already commits to marking a replayed answer visibly on the
line for exactly the design-rule-1 reason this decision keeps returning to.
An answer that is invisible about *which run it came from* is worse: a
"fresh" script run that quietly reuses a stale typed answer is a second,
harder-to-see version of the same failure mode #56 opens with — the
program's actual behaviour, not just a displayed value, would depend on
state the reader cannot see. The replay store should clear on every action
that clears the namespace: `Reset and Evaluate File`, `Run File as Script`,
and `Restart Kernel`.

## What this settles for the protocol and the commands

- `Kernel.reset()` is unchanged and needs no new code.
- `evaluate_file` is unchanged: it still never resets on its own, which
  keeps it the "keep going from here" command it already is.
- Whether the eventual `eval_file` request that means "run as a script"
  (#78's request flag) carries its own reset, or the extension sends `reset`
  as a separate request first, is an implementation detail for #78's ticket
  — the requirement this decision fixes is only the outcome: a script run
  always starts from empty.
- `evalens.restartKernel` is unchanged; it remains the heavier operation
  (new interpreter, new process) that a namespace reset does not need to be.

## Follow-up work

This ticket is a decision, and per the project's rules a decision does not
carry code — the implied changes are filed rather than built here:

- The `Evaluate File` / reset split and the keybinding swap described above.
- The residue-visibility indicator (the middle path), as its own, lower
  priority feature.

Both are referenced from the #56 comment recording this decision.
