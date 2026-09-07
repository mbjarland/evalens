"""Make a `for` loop report what it ran through, not just where it stopped.

`for p in lst:` leaves `p` bound to the final element, and annotating that is
true and nearly useless: the reason to run a loop in an exploration file is to
watch what it does, and every iteration but the last is thrown away. This
module rewrites the loop so each iteration announces itself, and the kernel
paints the sequence.

Two things are watched, because the loop binds two kinds of name. The
**target** is what the loop was handed, and the names the **body** binds are
what it computed from it. Both change on every iteration and both used to be
reported the same way -- the target as a history, the body binding as the one
value it happened to end on, which reads as that history's last entry.

**Why an AST rewrite and not `sys.settrace`.** A trace function sees every
line of every frame in the process, so it would tax all evaluation -- the
overwhelmingly common case, a one-line assignment -- to make the rare case
informative. The rewrite costs exactly one call per iteration of exactly the
loops the user pointed at, and nothing at all the rest of the time.

Three properties this module exists to guarantee, each one a bug if dropped.

**`repr()` at capture time.** The recorder stores the *string*, taken as the
iteration begins, never the object. A loop over mutable objects otherwise
reports the same final state N times -- which is worse than showing one value,
because it looks like N observations and reads as "nothing changed".

**Bounded.** The first `HEAD_LIMIT` values, the last one, and a count of what
was skipped. Nothing accumulates: a million-row loop leaves six strings behind,
not a million. It does pay one bounded `repr()` per iteration, which is the
unavoidable price of a *truthful* last value -- deferring that one repr() to
the end would reintroduce exactly the mutable-object lie above, for the value
the eye lands on last.

**The target's recorder goes first in the body.** `continue` then still
records the iteration it skipped out of, and `break` records the value it
broke on -- the value you were looking for, since it is why the loop stopped.
Recording at the bottom would silently drop both.

**The body's recorder goes last, for the mirror-image reason.** A name the
body binds does not exist yet at the top of the first pass: a recorder placed
there would find nothing, or -- worse -- find what a previous evaluation left
in the namespace and report it as this iteration's. It has to run after the
iteration computed something to have anything true to say about it.

**The two sequences are not parallel, and nothing may assume they are.** An
iteration that left the body early -- `continue`, `break`, `return`, an
exception -- computed no result, so its binding has one entry fewer than the
target does. That is not a gap to be filled. Inventing a value for an
iteration that did not produce one is the same lie as reporting a mutable
object's final state N times, and the loop that makes it visible is an
ordinary filter rather than a corner case.

The rewrite is additive: it inserts statements and changes nothing else, so
the namespace a loop leaves behind is identical instrumented or not.
`test_loops` pins that by running both and comparing.

**A nominated expression is a trace, not a watch (#48), and the ticket's own
title is the trap.** "Watch" in this project has one settled meaning --
re-read the current value later, forbidden since #40 because it asserts
something the statement did not produce. That is not what `instrument_watching`
adds. It captures a *second* expression the same way this module already
captures the target and the body's bindings: read at capture time, once per
iteration, as the loop runs -- `p+6`'s value the moment `p` held that
iteration's item, never afterwards. It is the same claim `record` already
makes, about a name the user chose instead of one the loop bound for itself.

**Evaluating it at all is design rule 3's hard case, not an exception to
it.** Reading a bare name is a lookup; `p+6`, `acct.balance`, `f(x)` are not,
and running one once per iteration is code the extension decided to execute
that the statement on screen does not call for -- exactly what #68 was filed
over, one level up. What makes it acceptable here and nowhere else in the
kernel is that the user nominated *this* expression, explicitly, once, by
name -- the same act of pointing that licenses evaluating the statement
itself. It does not license evaluating it more than that one nomination
asked for: a watch is data threaded through a single `eval_watch` request
in `evalens_kernel.py`, attached to the loop it was resolved against and
nowhere else, gone the moment that response is sent. Nothing here keeps a
nomination alive to re-run against a *later* evaluation on its own account --
that would be continuous evaluation by another name, which #5 already ruled
out, and it is why this module has no notion of a watch outliving one
`instrument_watching` call.

**A nominated expression that raises must not cost the loop its answer.**
The user chose the expression, not its behaviour on iteration 300 of 1000 --
`1/p` over a sequence containing one zero is #48's own example. `_watch_call`
wraps the evaluation in a `try`/`except Exception` written into the loop's
own body, so a raise is caught where it happens, in the user's frame, and
recorded once through `LoopTrace.fail` rather than propagated: the loop
keeps running, later iterations keep being attempted, and the reader is told
once rather than shown the same traceback for every remaining zero.

Requires Python 3.9 or later, in line with the rest of the kernel.
"""

from __future__ import annotations

import ast
import copy
import sys
from itertools import islice
from typing import Any, Callable, Dict, List, Optional, Tuple, Union

#: The name the rewritten code reaches the recorders through. Installed in the
#: namespace for the duration of one execution and removed afterwards, so a
#: loop leaves no trace of the machinery that watched it.
RECORDERS = "__evalens_loops__"

#: The name a watch's injected `except` clause binds its exception to. Kept
#: out of reach of the nominated expression the same way `RECORDERS` is kept
#: out of reach of the loop body: a user expression that happens to read a
#: name this ugly would have to go looking for it, and one that assigns to it
#: only shadows a name nothing downstream reads again. See `_watch_call`.
WATCH_EXC = "__evalens_watch_exc__"

#: A loop's own position, as `ast` reports it: 1-based `lineno`, 0-based
#: `col_offset`, both ends. What a nominated watch is filed under in
#: `instrument_watching`'s `watches` mapping, because the loop node itself
#: does not survive the `copy.deepcopy` `instrument` takes before rewriting
#: -- position does, byte for byte, so it is what the copy and the original
#: agree on. See `loop_key`.
LoopKey = Tuple[int, int, int, int]

#: How many leading values a summary keeps before it starts counting. Small on
#: purpose: this ends up on one line beside the code, and the first few values
#: plus the last is what tells you the shape of a run.
#:
#: A preference, not an invariant: this is how much of a line the reader is
#: willing to spend on one loop, and nobody but the reader knows that. It is
#: the default behind `evalens.loopIterations`, which arrives per request --
#: the kernel keeps no configuration of its own, so a setting changed between
#: two keypresses takes effect on the second one without a restart.
HEAD_LIMIT = 5

#: Per-value cap, applied by whoever supplies the `repr()`. The wire has its
#: own, much larger, limit; this one stops a single fat `repr()` from crowding
#: out the other five. This module deliberately holds no `repr()` policy of its
#: own -- taking one would mean importing the kernel, which imports this.
#:
#: Not a setting, and it is the one on this list that looks most like one. The
#: cap is applied at capture time, inside the user's loop, to a string that is
#: kept and an object that is not -- so a display preference has nothing left
#: to apply to afterwards. Raising it would not widen an annotation, it would
#: buy a million-iteration loop a longer `repr()` per iteration for a value
#: that gets elided anyway.
ITEM_LIMIT = 200

#: How many names bound in the body one loop may report, on the same principle
#: as the kernel's cap on names per line: the annotation shares a line with the
#: code it describes, and the target's own sequence is already on it. A body
#: binding five names would bury the loop under five more histories. Naming a
#: specific one is what a watch expression is for.
#:
#: Not a setting, though it is the same kind of number as `HEAD_LIMIT`, which
#: is one. This multiplies rather than adds: three body names at five
#: iterations each is fifteen values on a line that also carries the target's
#: own five, and the number of them the reader can stand is already governed
#: by `evalens.loopIterations` above it. A second dial behind the same off
#: switch would be one nobody finds and everybody has to reason about
#: alongside the first.
BINDING_LIMIT = 3

#: `sys._getframe`, looked up once. See `LoopTrace.bind` for why the body
#: recorder reads the frame rather than being handed its values, and None here
#: for an interpreter that does not offer frames: the loop then runs with no
#: body sequence at all, which is what it did before this existed.
_FRAME = getattr(sys, "_getframe", None)

#: Distinguishes "the iteration did not bind this name" from "it bound None".
_MISSING = object()


class LoopTrace:
    """What one loop held, iteration by iteration, bounded.

    One instance per loop rather than one per target name: nested loops, and
    an inner loop that reuses the outer loop's target name, are otherwise the
    same key and quietly interleave into one nonsensical sequence.

    The same class serves both recorders. A loop's own trace holds the target's
    values and owns one child trace per body name, and each child is an
    ordinary trace of that name's values -- so the bounding, the repr-at-
    capture-time rule and the wire shape are written once and cannot drift
    between the two halves of the answer.
    """

    __slots__ = ("_repr", "_limit", "_before", "head", "last", "count",
                 "varied", "bindings", "watches", "error", "failed",
                 "explorer", "site")

    def __init__(self, repr_fn: Callable[[Any], str], limit: int = HEAD_LIMIT,
                 names: Tuple[str, ...] = (), watches: Tuple[str, ...] = ()):
        self._repr = repr_fn
        self._limit = limit
        self.explorer = None
        self.site = 0
        #: What the watched names held before this loop ran. See `bind`.
        self._before: Dict[str, Any] = {}
        self.head: List[str] = []
        self.last: Optional[str] = None
        self.count = 0
        #: Whether any recorded value differed from the first one. What lets a
        #: name that never changes be reported once instead of as `c: 7, 7, 7`.
        self.varied = False
        #: One trace per name the body binds, in the order they are written.
        self.bindings: Dict[str, "LoopTrace"] = {
            name: LoopTrace(repr_fn, limit) for name in names}
        #: One trace per nominated expression attached to this loop, keyed by
        #: the expression's own source text -- #48. A dict for the same
        #: reason `bindings` is one: an expression is not interchangeable
        #: with the next one, and the key is what the injected call in
        #: `_watch_call` addresses at runtime.
        self.watches: Dict[str, "LoopTrace"] = {
            expr: LoopTrace(repr_fn, limit) for expr in watches}
        #: The first exception a watched expression raised, or None while
        #: every attempt has succeeded. Only ever set on a trace reached
        #: through `watches` -- see `fail`.
        self.error: Optional[Dict[str, str]] = None
        #: How many further iterations raised after the first. Kept apart
        #: from `count`, which `fail` never advances -- see there.
        self.failed = 0

    def record(self, value: Any) -> None:
        """Called once per iteration, from inside the user's loop.

        Deliberately tiny and total. This runs in the user's frame, so an
        exception raised here would surface as a failure of their code at a
        line they cannot see; `repr_fn` is expected to contain its own.
        """
        self.count += 1
        if self.count == 1 and self.bindings and _FRAME is not None:
            # The first call runs before the body ever has, which makes this
            # the one moment the watched names can be seen as the loop found
            # them. `bind` needs that to tell what an iteration computed from
            # what an earlier evaluation left lying in the namespace.
            scope = _FRAME(1).f_locals
            self._before = {name: scope.get(name, _MISSING)
                            for name in self.bindings}
        text = self._repr(value)
        if self.head and text != self.head[0]:
            # Compared against the first rather than the previous value, so
            # `varied` means "this changed at some point" whatever the head
            # limit is -- and costs one string comparison per iteration.
            self.varied = True
        if len(self.head) < self._limit:
            self.head.append(text)
        else:
            # Only the newest survives past the head, so memory is flat no
            # matter how long the loop runs.
            self.last = text
        if self.explorer is not None:
            self.explorer.iteration(self.site, text)

    def begin(self):
        if self.explorer is not None:
            self.explorer.begin(self.site)

    def end_iteration(self):
        if self.explorer is not None:
            self.explorer.end_iteration(self.site)

    def finish(self):
        if self.explorer is not None:
            self.explorer.finish(self.site)

    def fail(self, exc: Exception) -> None:
        """Called once per iteration in place of `record`, when evaluating a
        nominated expression raised instead of producing a value -- #48.

        Runs in the user's frame exactly as `record` does, from inside the
        `except` clause `_watch_call` builds, and is held to the same
        standard: total, never able to raise into the loop that calls it.
        `str(exc)` is itself the user's own code by way of `__str__`, and is
        read defensively for that reason.

        **Never advances `count`.** A raised expression produced nothing to
        show, which is the same "not parallel" fact `record`'s docstring
        already states for a `continue`d iteration -- the sequence beside the
        loop is honestly shorter, not padded with an invented reading, and a
        binding's existing note for "bound on fewer iterations than the loop
        ran" reads correctly here without this module or the renderer
        learning anything new.

        **Only the first exception is kept.** #48's own example is `1/p`
        nominated over a sequence containing one zero: every later zero
        raises the identical `ZeroDivisionError`, and reporting each would
        bury the expression's real values -- the whole reason to nominate it
        -- under one repeated fact instead of adding information. Later
        iterations keep being *attempted*, because a value after the bad one
        is still true and still worth the sequence; only reporting the
        failure is capped, in `failed` rather than repeated in `error`.
        """
        if self.error is not None:
            self.failed += 1
            return
        try:
            message = str(exc)
        except Exception:  # noqa: BLE001 - the exception's own __str__
            message = "<error formatting exception>"
        self.error = {"type": type(exc).__name__, "message": message}

    def trace(self, iterable: Any) -> Any:
        """Yield `iterable` unchanged, recording each item as it is drawn.

        What a comprehension's `for` clause is instrumented with, in place of
        `record` being called from an injected body statement: a comprehension
        compiles to its own tiny function built entirely from expressions, and
        there is no statement position inside it to call anything from. What
        there is instead is the clause's *iterable*, and wrapping it --
        `range(10)` becomes `__evalens_loops__[0].trace(range(10))` -- records
        exactly what the clause drew from it while handing back the very same
        values, unopened and unmodified. A generator that yields what it was
        given is transparent to whatever consumes it, so the comprehension
        still builds precisely the result it would have without this wrapped
        around its source. See `_ComprehensionInstrumenter`.

        Recorded before the value is handed onward, on the rule `record`
        already states: a `repr()` taken here is of the item as the clause
        drew it, before the comprehension's own element expression or a later
        filter can act on anything reachable from it.

        Never installed on a generator expression's clauses -- see
        `_ComprehensionInstrumenter.visit_GeneratorExp` -- because pulling
        even one item through this generator to record it is exactly the
        forced consumption that would destroy the value the user just made.
        """
        for item in iterable:
            self.record(item)
            yield item

    def bind(self) -> None:
        """Record what this iteration bound, read from the calling frame.

        Called as the last statement of the body, so what it reads is what the
        iteration computed. An iteration that left early never reaches it, and
        the name it was watching simply has one entry fewer -- see the module
        docstring for why that is the honest answer rather than a hole.

        **Why the frame and not arguments.** Passing `u` to this call would
        raise `NameError` inside the user's loop on any iteration that did not
        bind it, which is an annotation turning into a crash in their code; a
        first pass that took the other branch is enough to trigger it, and
        Python has no expression for "this name if it has one". Wrapping the
        call in `except NameError` instead would drop every name because one
        was missing. `locals()` in the injected code would read correctly and
        is a *name*: a namespace holding the user's own `locals` would have the
        rewrite calling it. The frame is reached through nothing the user's
        code can rebind, and `f_locals` is the right mapping in every scope.

        Reading each name out of that mapping is a dictionary lookup and
        nothing else, which is what makes doing it unbidden safe -- the same
        rule the kernel follows for the names it reports beside a line.

        **A name still holding what it held before the loop has not been
        bound.** The scope cannot say who put a value there, and a session's
        namespace is long-lived: `u = 99` from ten minutes ago is sitting in it
        when a loop whose `u = ...` never fires runs, and reporting 99 as this
        loop's per-iteration result is precisely the invented observation the
        whole rewrite exists to avoid. So a name is reported only once it
        differs from what the loop found -- after which every iteration counts,
        including the ones that rebind it to the same value, because by then it
        is demonstrably this loop's to report.

        Compared by identity, never by `==`: equality runs the object's own
        code, which can raise, cost real time, or -- for an array -- answer
        with something that is not a boolean at all.
        """
        if not self.bindings or _FRAME is None:
            return
        scope = _FRAME(1).f_locals
        for name, trace in self.bindings.items():
            value = scope.get(name, _MISSING)
            if value is _MISSING:
                continue
            if not trace.count:
                if value is self._before.get(name, _MISSING):
                    continue
                # Proved to be this loop's. Letting go of the pre-loop value
                # here keeps the recorder from holding an object the body has
                # replaced alive for the rest of the run.
                self._before.pop(name, None)
            trace.record(value)

    @property
    def latest(self) -> Optional[str]:
        """The final iteration's value, or None if the loop never ran.

        Read at capture time like every other value here, which is why it is
        not simply `repr()` of the target after the loop: a body that mutates
        what it was handed leaves those two saying different things, and the
        one consistent with the rest of the sequence is this one.
        """
        if self.last is not None:
            return self.last
        return self.head[-1] if self.head else None

    def wire(self) -> Dict[str, Any]:
        """The trace as JSON, for the extension to render.

        Rendering is the extension's job, not this module's: it is the side
        that knows the editor width and the user's settings. What crosses is
        the evidence -- leading values, final value, how many there were.
        """
        return {"values": list(self.head), "last": self.last,
                "count": self.count}

    def bindings_wire(self) -> List[Dict[str, Any]]:
        """What the body bound, one entry per name, in the order written.

        A name no iteration bound is left out entirely rather than sent as an
        empty sequence. The loop's own trace already says whether it ran, and a
        filter that matched nothing would otherwise answer with a row of names
        all saying the same nothing.
        """
        return [trace.named_wire(name)
                for name, trace in self.bindings.items() if trace.count]

    def watches_wire(self) -> List[Dict[str, Any]]:
        """What each nominated expression produced, one entry per watch, in
        the order they were requested -- #48.

        Unlike `bindings_wire`, an expression that never once produced a
        value is not left out. A name nobody's body bound is nothing to
        report; an expression the user explicitly nominated failing on every
        iteration *is* the report -- see `error` on the payload, set by
        `named_wire` below whenever `fail` was ever called.
        """
        return [trace.named_wire(expr) for expr, trace in self.watches.items()]

    def named_wire(self, name: str) -> Dict[str, Any]:
        """This trace as JSON under `name`, collapsed if it never changed.

        `c: 7, 7, 7, 7` is four observations of one fact, and it crowds out
        the sequence beside it that is actually moving. The collapse happens
        here rather than in the renderer because this is the side that knows
        the values were identical -- and it sends one value, so a consumer
        that ignores the flag still paints something true.
        """
        payload: Dict[str, Any] = {"name": name, **self.wire()}
        if self.count > 1 and not self.varied:
            payload["values"] = self.head[:1]
            payload["last"] = None
            payload["constant"] = True
        if self.error is not None:
            # Only ever set through `fail`, so only a watch's own trace ever
            # carries this -- the target's and an ordinary binding's `error`
            # stay None for the life of the object. `evaluate_watch` is what
            # turns this into something the reader actually sees: it prints
            # one line to the statement's own stderr, which is how "reported
            # once" reaches the annotation without this module or the wire
            # format knowing anything about rendering.
            payload["error"] = dict(self.error)
            if self.failed:
                payload["failed"] = self.failed
        return payload


def _load_copy(target: ast.expr) -> Optional[ast.expr]:
    """`target` rebuilt as something readable, or None if it cannot be.

    A loop target is in `Store` context and a `Starred` element inside it
    means "collect the rest into a list". Reusing the node as an expression
    gets both wrong: the contexts are invalid to compile, and `(a, *b)` as an
    expression *unpacks* `b` rather than showing it, so
    `for a, *b in [[1, 2, 3]]` would record `(1, 2, 3)` where the loop bound
    `a = 1, b = [2, 3]`.

    Returning None for anything unrecognised is the safe answer: the loop is
    left alone and annotates its final value as it did before. A rewrite that
    guesses is a rewrite that changes what the user's code does.
    """
    if isinstance(target, ast.Name):
        return ast.Name(id=target.id, ctx=ast.Load())
    if isinstance(target, ast.Starred):
        # The name a star binds holds an ordinary list; show that list.
        return _load_copy(target.value)
    if isinstance(target, (ast.Tuple, ast.List)):
        elements = [_load_copy(element) for element in target.elts]
        if any(element is None for element in elements):
            return None
        return type(target)(elts=elements, ctx=ast.Load())
    if isinstance(target, ast.Attribute):
        value = _load_copy_of_value(target.value)
        return None if value is None else ast.Attribute(
            value=value, attr=target.attr, ctx=ast.Load())
    if isinstance(target, ast.Subscript):
        value = _load_copy_of_value(target.value)
        index = _readable_index(target.slice)
        return None if value is None or index is None else ast.Subscript(
            value=value, slice=index, ctx=ast.Load())
    return None


def _load_copy_of_value(node: ast.expr) -> Optional[ast.expr]:
    """The object half of `obj.attr` / `obj[k]`, which is already a read.

    Only names and further attribute/subscript reads are accepted. `for
    f()[0] in xs:` is legal Python, and reading the target back to display it
    would call `f()` a second time -- the exact side-effect duplication the
    explicit-trigger design exists to prevent.
    """
    if isinstance(node, ast.Name):
        return ast.Name(id=node.id, ctx=ast.Load())
    if isinstance(node, ast.Attribute):
        inner = _load_copy_of_value(node.value)
        return None if inner is None else ast.Attribute(
            value=inner, attr=node.attr, ctx=ast.Load())
    if isinstance(node, ast.Subscript):
        inner = _load_copy_of_value(node.value)
        index = _readable_index(node.slice)
        return None if inner is None or index is None else ast.Subscript(
            value=inner, slice=index, ctx=ast.Load())
    return None


def _readable_index(node: ast.expr) -> Optional[ast.expr]:
    """A subscript index that can be evaluated twice without consequence.

    Constants and names only, and a fresh node rather than the original: `for
    d[next(it)] in xs:` would otherwise advance the iterator once to assign
    and once to read back. Anything more elaborate simply goes uninstrumented,
    which costs a rare loop its sequence and costs nobody a surprise.
    """
    if isinstance(node, ast.Constant):
        return ast.Constant(value=node.value, kind=node.kind)
    if isinstance(node, ast.Name):
        return ast.Name(id=node.id, ctx=ast.Load())
    return None


class _BoundNames(ast.NodeVisitor):
    """The names a loop body binds itself, in the order they are written.

    Bindings only, and only this body's. What is deliberately left out is as
    much of the answer as what is kept, because each exclusion is a way for an
    informative line to become a wall of numbers:

    * **Names merely read.** They are the line's inputs and are already
      wherever they came from; the loop did not do anything to them.
    * **Names bound in a nested loop.** They take a value per inner iteration,
      so reporting them beside the outer sequence puts two different clocks on
      one line. The inner loop annotates its own when someone points at it.
    * **A `def`, `class` or `lambda`.** They bind machinery rather than data,
      and their `repr()` carries an address that changes every iteration --
      which would read as a value that keeps changing when nothing has.
    * **A comprehension's target.** It has its own scope and never reaches the
      namespace, so watching one spends a slot to report nothing.
    * **The `else` clause.** It runs once, after the loop, so it is not a
      per-iteration binding at all; the names on the line already cover it.

    Everything else in the body is descended into, and the `if`/`try`/`with`
    ones matter: a name bound under a branch is the filter loop this feature is
    for, not an edge case to skip.
    """

    def __init__(self) -> None:
        self.names: List[str] = []

    def visit_Name(self, node: ast.Name) -> None:
        if isinstance(node.ctx, ast.Store) and node.id not in self.names:
            self.names.append(node.id)

    def _skip(self, node: ast.AST) -> None:
        """A scope or a clock of its own. See the class docstring."""
        return

    visit_For = _skip
    visit_AsyncFor = _skip
    visit_While = _skip
    visit_FunctionDef = _skip
    visit_AsyncFunctionDef = _skip
    visit_ClassDef = _skip
    visit_Lambda = _skip
    visit_ListComp = _skip
    visit_SetComp = _skip
    visit_DictComp = _skip
    visit_GeneratorExp = _skip


def _body_names(node) -> Tuple[str, ...]:
    """The names this loop's body binds and is worth watching, capped.

    The loop's own targets are dropped: they are the sequence already being
    reported, and `for v in xs:` with `v = v * 2` in the body would otherwise
    put `v` on the line twice saying two different things.
    """
    collector = _BoundNames()
    for statement in node.body:
        collector.visit(statement)
    targets = {name.id for name in ast.walk(node.target)
               if isinstance(name, ast.Name)}
    names = [name for name in collector.names
             if name not in targets and name != RECORDERS]
    return tuple(names[:BINDING_LIMIT])


class _Instrumenter(ast.NodeTransformer):
    """Inserts the recorder calls around every loop body in scope.

    `watches` is empty for every call `instrument` makes and is the whole of
    what `instrument_watching` adds -- see there for why this stays one class
    rather than two. Keyed by `loop_key`, because the loops this class visits
    are on a *copy* of the caller's tree (`instrument` takes one before
    rewriting), and identity does not survive that; position does.
    """

    def __init__(
        self, watches: Optional[Dict[LoopKey, List[Tuple[str, ast.expr]]]] = None,
        explore: bool = False
    ) -> None:
        #: One entry per instrumented loop, in allocation order, holding the
        #: body names that loop's recorder watches. Its length is the number
        #: of recorders the rewritten tree expects.
        self.plan: List[Tuple[str, ...]] = []
        #: One entry per instrumented loop, in the same order and the same
        #: length as `plan`: the source text of every nominated expression
        #: attached to it. Empty for every loop `instrument` visits, since it
        #: never passes `watches` at all -- see `instrument_watching`.
        self.watch_plan: List[Tuple[str, ...]] = []
        self._watches = watches or {}
        self.explore = explore
        self.sites = []
        self.parents = []
        self.unsupported = False

    # A nested `def`, `class` or `lambda` is a different execution scope and,
    # more to the point, a different *time*: its loops run when it is called,
    # which may be long after this evaluation finished and the recorders were
    # uninstalled. Instrumenting them would plant a NameError in the user's
    # function. Not descending is the whole guard, so it is spelled out per
    # node type rather than left to a comment.
    def visit_FunctionDef(self, node: ast.AST) -> ast.AST:
        return node

    def visit_AsyncFunctionDef(self, node: ast.AST) -> ast.AST:
        return node

    def visit_ClassDef(self, node: ast.AST) -> ast.AST:
        return node

    def visit_Lambda(self, node: ast.AST) -> ast.AST:
        return node

    def visit_For(self, node: ast.For) -> ast.For:
        return self._instrument(node)

    def visit_AsyncFor(self, node: ast.AsyncFor) -> ast.AsyncFor:
        # Identical treatment, and reached only through a rewrite of a node
        # already inside a coroutine: `async for` at module level is a syntax
        # error, so the kernel never resolves one as a top-level statement.
        return self._instrument(node)

    # -- internals ---------------------------------------------------------

    def _instrument(self, node):
        readable = _load_copy(node.target)
        if any(isinstance(n, (ast.Attribute, ast.Subscript))
               for n in ast.walk(node.target)):
            # Keep the established trace for these targets, but do not
            # expand the explorer's scope to property/subscript semantics.
            self.unsupported = True
        index = None
        attached: Tuple[Tuple[str, ast.expr], ...] = ()
        if readable is not None:
            # Allocated before descending, so the loop the user pointed at is
            # index 0 however deeply the ones inside it nest. The body names
            # are read from the body as the user wrote it, before the rewrite
            # puts anything of its own in there.
            index = len(self.plan)
            self.plan.append(_body_names(node))
            # Read by this loop's own position rather than anything the
            # caller allocated ahead of time: a watch is filed under the
            # *loop's* key, not this walk's index, precisely so a nested
            # loop can be the one addressed without the caller having to
            # predict where in allocation order it falls.
            attached = tuple(self._watches.get(loop_key(node), ()))
            self.watch_plan.append(tuple(expr for expr, _ in attached))
            self.sites.append(dict(
                id=index, parent=self.parents[-1] if self.parents else None,
                line=node.lineno - 1, target=ast.unparse(node.target),
                source=(('async ' if isinstance(node, ast.AsyncFor) else '')
                        + 'for ' + ast.unparse(node.target) + ' in '
                        + ast.unparse(node.iter)),
                names=list(islice((n.id for n in ast.walk(node.target)
                                   if isinstance(n, ast.Name)), 8))))
            self.parents.append(index)
        else:
            self.unsupported = True

        self.generic_visit(node)
        if index is not None:
            self.parents.pop()

        if index is not None:
            node.body.insert(0, _recorder_call(index, "record", [readable],
                                               node))
            trailing: List[ast.stmt] = []
            if self.plan[index]:
                # Before any watch, and for the same reason it goes last in
                # the body: a nominated expression may read a name this
                # iteration's body just bound, e.g. an accumulator, and
                # needs the recorder for it to have already run.
                trailing.append(_recorder_call(index, "bind", [], node))
            for expr_source, expr_node in attached:
                trailing.append(_watch_call(index, expr_source, expr_node,
                                            node))
            if trailing:
                # Last, so every recorder sees what the iteration computed --
                # and appended after the rewrite of any nested loop, which
                # changes nothing about the order it runs in but keeps this
                # statement the last thing in the body it belongs to.
                node.body.extend(trailing)
            if self.explore:
                # Close the body even on continue/break/raise; iterator and
                # else output stay outside the iteration that preceded them.
                body = ast.Try(body=node.body[1:], handlers=[], orelse=[],
                               finalbody=[_recorder_call(
                                   index, 'end_iteration', [], node)])
                node.body = [node.body[0], ast.copy_location(body, node)]
                wrapped = ast.Try(body=[_recorder_call(
                    index, 'begin', [], node), node], handlers=[], orelse=[],
                    finalbody=[_recorder_call(index, 'finish', [], node)])
                return ast.copy_location(wrapped, node)
        return node


def _recorder_call(index: int, method: str, args: List[ast.expr],
                   at: ast.stmt) -> ast.stmt:
    """`__evalens_loops__[index].<method>(*args)`, positioned at the loop.

    Every synthesised node is given the `for` statement's own position. An AST
    node without one is a hard compile error, and one carrying a plausible but
    wrong line is worse: `linecache` would quote a line the user never wrote
    into the middle of their traceback.

    Both recorders are built here rather than each writing its own tree, so
    "give the injected nodes a real position" is stated once and cannot be
    remembered for one call and forgotten for the other.
    """
    call = ast.Expr(
        value=ast.Call(
            func=ast.Attribute(
                value=ast.Subscript(
                    value=ast.Name(id=RECORDERS, ctx=ast.Load()),
                    slice=ast.Constant(value=index),
                    ctx=ast.Load()),
                attr=method,
                ctx=ast.Load()),
            args=args,
            keywords=[]))
    for node in ast.walk(call):
        ast.copy_location(node, at)
    return ast.fix_missing_locations(call)


def loop_key(node: ast.stmt) -> LoopKey:
    """`node`'s own span, as `instrument_watching`'s `watches` mapping keys
    it under -- see `LoopKey`."""
    return (node.lineno, node.col_offset, node.end_lineno, node.end_col_offset)


def _watch_call(index: int, expr_source: str, expr: ast.expr,
                at: ast.stmt) -> ast.stmt:
    """A nominated expression, evaluated once and never let raise -- #48.

    ::

        try:
            __evalens_loops__[index].watches[expr_source].record(expr)
        except Exception as __evalens_watch_exc__:
            __evalens_loops__[index].watches[expr_source].fail(
                __evalens_watch_exc__)

    **Why this must be a `try`/`except` in the rewritten tree, and cannot be
    handled inside `LoopTrace.record`.** `record`'s argument is evaluated by
    the interpreter *before* the call happens -- Python evaluates `f(x)` by
    evaluating `x` first -- so a raising expression never reaches `record` at
    all; the exception is already propagating out of the user's loop by
    then. Catching it has to sit around the evaluation itself, which is
    exactly what only the rewritten tree, and not the trace object, can do.
    This is design rule 3's hard case: `p+6` is a dictionary lookup and an
    addition and cannot fail in a way worth stopping for, but the user may
    nominate anything -- `1/p`, `acct.balance`, `f(x)` -- and #48 requires
    that a bad one report once and let the loop finish, which only a guard
    written into the loop's own body can guarantee.

    `except Exception`, deliberately narrower than `installed`'s
    `BaseException`. `KeyboardInterrupt` is how Cancel reaches a running
    evaluation (see `_run` in `evalens_kernel.py`), raised asynchronously at
    whatever bytecode happens to be executing -- which could be *this*
    `try`. Catching it here would make nominating a watch capable of
    swallowing Cancel on a slow loop, trading a real stop button for a
    feature nobody asked to affect it. `SystemExit` gets the same
    deliberate miss, for the same reason `installed` does catch it one
    level up: it is the user's own decision to end the process, and a watch
    evaluated as a side detail must not be the thing standing in its way.

    Every synthesised node here takes `at`'s position, `expr` included --
    unlike `_trace_call`'s `iterable`, which keeps the position the parser
    gave it because that position is real: it is where the clause's own
    iterable sits in the file being evaluated. `expr` was parsed from a
    standalone string the user typed into a command, `ast.parse(expr_source,
    mode="eval")`, whose line 1 means nothing about this file -- keeping it
    would misattribute the very expression this call exists to describe.
    Harmless either way, since `fail` catches whatever this raises and
    nothing here is ever allowed to reach a traceback the user sees; done
    for hygiene, and so a future reader is not left wondering why one
    synthesised node disagreed with the rest about where it lives.
    """
    watch_ref = ast.Subscript(
        value=ast.Attribute(
            value=ast.Subscript(
                value=ast.Name(id=RECORDERS, ctx=ast.Load()),
                slice=ast.Constant(value=index),
                ctx=ast.Load()),
            attr="watches",
            ctx=ast.Load()),
        slice=ast.Constant(value=expr_source),
        ctx=ast.Load())
    success = ast.Expr(value=ast.Call(
        func=ast.Attribute(value=watch_ref, attr="record", ctx=ast.Load()),
        args=[expr], keywords=[]))
    failure = ast.Expr(value=ast.Call(
        func=ast.Attribute(value=watch_ref, attr="fail", ctx=ast.Load()),
        args=[ast.Name(id=WATCH_EXC, ctx=ast.Load())], keywords=[]))
    handler = ast.ExceptHandler(
        type=ast.Name(id="Exception", ctx=ast.Load()),
        name=WATCH_EXC, body=[failure])
    guarded = ast.Try(body=[success], handlers=[handler], orelse=[],
                      finalbody=[])
    for node in ast.walk(guarded):
        ast.copy_location(node, at)
    return ast.fix_missing_locations(guarded)


def instrument(node: ast.stmt) -> Tuple[ast.stmt, List[Tuple[str, ...]]]:
    """A rewritten copy of `node`, and what each of its recorders watches.

    The plan is a list rather than a count because a recorder is no longer
    interchangeable with the next one: it also holds the body names of the loop
    it belongs to, and `len(plan)` is still how many there are.

    The original is left untouched. The caller holds the user's parsed tree
    and may still want to read positions off it, and a transformer that
    mutates its input turns "evaluate this twice" into "instrument it twice".
    """
    instrumenter = _Instrumenter()
    rewritten = instrumenter.visit(copy.deepcopy(node))
    return ast.fix_missing_locations(rewritten), instrumenter.plan


def instrument_watching(
    node: ast.stmt, watches: Dict[LoopKey, List[Tuple[str, ast.expr]]]
) -> Tuple[ast.stmt, List[Tuple[str, ...]], List[Tuple[str, ...]]]:
    """Like `instrument`, and additionally attaches nominated expressions to
    the loops `watches` addresses them to -- #48.

    A second function rather than an optional parameter on `instrument`,
    because every existing caller of `instrument` unpacks a two-element
    tuple, and a `watches=None` default would still leave "what is the third
    element when nobody asked for one" with no good answer. Splitting the
    signature is the same call `instrument_comprehensions` already made:
    plain loop instrumentation has one settled shape, and everything
    watch-related is additive, optional, and kept out of its way.

    `watches` is keyed by `loop_key` rather than by an index the caller
    allocates, because the caller -- `evaluate_watch` in `evalens_kernel.py`
    -- resolves the *target loop*, by position, before this rewrite ever
    runs, and does not and should not know the allocation order
    `_Instrumenter`'s traversal is about to produce. Position is the one
    thing both sides agree on: `instrument` deep-copies `node` before
    visiting it, so identity does not survive to the loops this rewrites,
    and position does, byte for byte.
    """
    instrumenter = _Instrumenter(watches)
    rewritten = instrumenter.visit(copy.deepcopy(node))
    return (ast.fix_missing_locations(rewritten), instrumenter.plan,
            instrumenter.watch_plan)


def instrument_exploring(node, watches=None):
    """The existing recorder plan plus its sites, from the SAME traversal.

    Readable for/async-for statements acquire boundary calls at every depth.
    Unsupported targets keep the established flat trace. A second
    rewrite on that uncommon fallback avoids unnecessary per-iteration calls.
    """
    instrumenter = _Instrumenter(watches, explore=True)
    rewritten = instrumenter.visit(copy.deepcopy(node))
    if (not instrumenter.sites or instrumenter.unsupported
            or len(instrumenter.sites) > 64):
        instrumenter = _Instrumenter(watches)
        rewritten = instrumenter.visit(copy.deepcopy(node))
        sites = []
    else:
        sites = instrumenter.sites
        for site in sites:
            for key, cap in (('target', 120), ('source', 240)):
                if len(site[key]) > cap:
                    site[key] = site[key][:cap] + '…'
    return (ast.fix_missing_locations(rewritten), instrumenter.plan,
            instrumenter.watch_plan, sites)


def innermost_loop_at(
    node: ast.stmt, line: int, character: int
) -> Optional[Union[ast.For, ast.AsyncFor]]:
    """The most tightly nested `for`/`async for` inside `node` whose own span
    contains 0-based (`line`, `character`), or None -- #48.

    Where a nominated expression's watch attaches. Innermost, because
    nominating an expression written inside a nested loop is a claim about
    *that* loop's iterations, not the outer one's: an outer loop of 3
    wrapping an inner loop of 1000 would otherwise report the watch's own
    1000-entry sequence as though it belonged to the loop that ran 3 times.

    `node` itself is a candidate -- `ast.walk` yields the root first -- so a
    position inside an unnested loop resolves to the loop itself, which is
    the common case #48's own examples exercise.

    Lines are zero-based and columns are AST UTF-8 byte offsets. The kernel
    converts incoming editor UTF-16 columns before calling this function.
    """
    best: Optional[Union[ast.For, ast.AsyncFor]] = None
    best_span: Optional[int] = None
    for candidate in ast.walk(node):
        if not isinstance(candidate, (ast.For, ast.AsyncFor)):
            continue
        if not _contains(candidate, line, character):
            continue
        span = (candidate.end_lineno or candidate.lineno) - candidate.lineno
        if best is None or span < best_span:  # type: ignore[operator]
            best, best_span = candidate, span
    return best


def _contains(node: ast.stmt, line: int, character: int) -> bool:
    """Whether 0-based (`line`, `character`) falls within `node`'s own span.

    `node.end_lineno`/`end_col_offset` are only ever `None` on a parser that
    predates Python 3.8, below this kernel's floor -- checked defensively
    anyway, on the same rule `_load_copy` follows: declining is always the
    safe answer to an assumption that turns out not to hold.
    """
    start_line, start_col = node.lineno - 1, node.col_offset
    end_line = (node.end_lineno or node.lineno) - 1
    end_col = node.end_col_offset if node.end_col_offset is not None else start_col
    if line < start_line or line > end_line:
        return False
    if line == start_line and character < start_col:
        return False
    if line == end_line and character > end_col:
        return False
    return True


def _trace_call(index: int, iterable: ast.expr, at: ast.expr) -> ast.expr:
    """`__evalens_loops__[index].trace(iterable)`, as an expression.

    `_recorder_call` builds the same shape of call as a *statement*, for a
    `for` body that has somewhere to put one. A comprehension's clause has
    nowhere -- it is built entirely from expressions -- so this hands back
    the call itself, to be substituted in place of `iterable`.

    Only the wrapper's own nodes take `at`'s position. `iterable` is the
    user's own expression and the parser already positioned it; overwriting
    that would misattribute it, quoting the clause's iterable at the line of
    whatever statement happens to contain it rather than its own.
    `fix_missing_locations` is still run over the whole call as a safety net,
    and it is safe to: it fills in only what is missing, so `iterable`'s own
    position -- never missing, since it came from a parse -- is left alone.
    """
    name = ast.Name(id=RECORDERS, ctx=ast.Load())
    index_node = ast.Constant(value=index)
    subscript = ast.Subscript(value=name, slice=index_node, ctx=ast.Load())
    attribute = ast.Attribute(value=subscript, attr="trace", ctx=ast.Load())
    call = ast.Call(func=attribute, args=[iterable], keywords=[])
    for node in (name, index_node, subscript, attribute, call):
        ast.copy_location(node, at)
    return ast.fix_missing_locations(call)


class _ComprehensionInstrumenter(ast.NodeTransformer):
    """Wraps each `for` clause's iterable so it reports what it drew.

    `_Instrumenter` inserts calls into a `for` statement's body; a
    comprehension has no body to insert into, only expressions, so what gets
    rewritten here is each clause's `iter` instead -- see `_trace_call` and
    `LoopTrace.trace`. Everything else about the comprehension, including its
    element expression and every filter, is left exactly as written:
    recording is a property of the iterable, not of what the comprehension
    goes on to do with it, and #75 is explicit that only the first may
    change -- *what it iterated, not what survived the filter*.

    The same three scopes `_Instrumenter` refuses to descend into are refused
    here too, and for the same two reasons: a nested `def`, `class` or
    `lambda` is both a different scope and a different *time*, its body
    running when it is called rather than now, with the recorders long since
    uninstalled by then. A comprehension sitting in a function's default
    argument genuinely does run now and is missed by this rule -- defaults are
    evaluated where the `def` is written -- but `_Instrumenter` already
    accepts the same miss for a `for` loop in that position, nothing else in
    this module opens one argument of a `def` while leaving its body closed,
    and the alternative is a traversal found nowhere else here for a case this
    rare.
    """

    def __init__(self) -> None:
        #: One label per instrumented `for` clause, in allocation order --
        #: the unparsed target pattern, e.g. `"x"` or `"(k, v)"`, which is all
        #: a caller needs to name the trace on the wire. Positional, exactly
        #: as `_Instrumenter.plan` is: a clause's recorder is not
        #: interchangeable with the next one.
        self.plan: List[str] = []

    def visit_FunctionDef(self, node: ast.AST) -> ast.AST:
        return node

    def visit_AsyncFunctionDef(self, node: ast.AST) -> ast.AST:
        return node

    def visit_ClassDef(self, node: ast.AST) -> ast.AST:
        return node

    def visit_Lambda(self, node: ast.AST) -> ast.AST:
        return node

    def visit_GeneratorExp(self, node: ast.GeneratorExp) -> ast.GeneratorExp:
        # Lazy: nothing has been drawn from it by the time the statement that
        # holds it finishes, and the only way to learn what it would draw is
        # to run it -- which is the one thing an annotation may never do to a
        # generator the user kept. Left exactly as parsed, root to leaves, so
        # a list comprehension nested inside one is left alone too rather than
        # instrumented on the chance it turns out to be consumed synchronously
        # here. See #75.
        return node

    def visit_ListComp(self, node: ast.ListComp) -> ast.ListComp:
        return self._instrument(node)

    def visit_SetComp(self, node: ast.SetComp) -> ast.SetComp:
        return self._instrument(node)

    def visit_DictComp(self, node: ast.DictComp) -> ast.DictComp:
        return self._instrument(node)

    def _instrument(self, node):
        for generator in node.generators:
            if generator.is_async:
                # `async for` draws through `__aiter__`; `trace` is an
                # ordinary generator built on `__iter__`, and wrapping one
                # would break the clause outright rather than merely leave it
                # untraced. Unreachable from the cursor today for the same
                # reason `_Instrumenter` gives an `async for` statement: it
                # only appears inside an `async def`, a scope this class has
                # already declined to enter -- kept as an explicit guard
                # rather than an invariant nothing checks.
                continue
            index = len(self.plan)
            self.plan.append(ast.unparse(generator.target))
            generator.iter = _trace_call(index, generator.iter, generator.iter)
        # After wrapping this comprehension's own clauses, so that an iterable,
        # an element expression or a filter which is itself a comprehension is
        # found and given the next indices -- outer clauses first, exactly as
        # `_Instrumenter` allocates the loop the user pointed at before it
        # descends into the ones nested inside it.
        self.generic_visit(node)
        return node


def instrument_comprehensions(node: ast.stmt) -> Tuple[ast.stmt, List[str]]:
    """A rewritten copy of `node`, and the label for each clause traced.

    Mirrors `instrument()`, and for the same reason: the original is left
    untouched, because the caller holds the user's parsed tree and may still
    want its positions, and a transformer that mutates its input turns
    "evaluate this twice" into "instrument it twice".

    A statement with no comprehension in it, or one holding only generator
    expressions, comes back unchanged with an empty list -- which is what
    makes this cost nothing beside the statement kinds #75 was not asked
    about.
    """
    instrumenter = _ComprehensionInstrumenter()
    rewritten = instrumenter.visit(copy.deepcopy(node))
    return ast.fix_missing_locations(rewritten), instrumenter.plan


def comprehension_traces(
    labels: List[str], repr_fn: Callable[[Any], str], limit: int = HEAD_LIMIT
) -> List[Tuple[str, LoopTrace]]:
    """One recorder per instrumented clause, paired with the label it reports
    under.

    A plain `LoopTrace` each, with no watched body names: a comprehension has
    no body statement to bind one in, only the element expression that
    produces the comprehension's own result -- which is already what the
    statement's value shows, and is not this module's to repeat.
    """
    return [(label, LoopTrace(repr_fn, limit)) for label in labels]


def traces(plan: List[Tuple[str, ...]], repr_fn: Callable[[Any], str],
           limit: int = HEAD_LIMIT) -> List[LoopTrace]:
    """One recorder per instrumented loop, in the order they were allocated.

    Two independent things arrive here. The `plan` says *what* each recorder
    watches -- one entry per loop, holding that loop's body names -- and is
    positional because a recorder is no longer interchangeable with the next
    one. `limit` says *how much* of what it watched to keep, and comes from the
    request so that `evalens.loopIterations` applies to the next keypress
    rather than to the next kernel.

    The limit reaches the body's traces too: `LoopTrace` hands it to the child
    it builds per watched name, so a binding and the target beside it are cut
    off at the same iteration instead of drifting apart on one line.
    """
    return [LoopTrace(repr_fn, limit, names) for names in plan]


def watching_traces(
    plan: List[Tuple[str, ...]], watch_plan: List[Tuple[str, ...]],
    repr_fn: Callable[[Any], str], limit: int = HEAD_LIMIT
) -> List[LoopTrace]:
    """Like `traces`, and additionally gives each loop's trace a `watches`
    dict pre-populated for the expressions `instrument_watching` wired into
    it -- #48. Without this, the injected call in `_watch_call` would find
    an empty dict and raise `KeyError` on its very first iteration.

    `plan` and `watch_plan` are `instrument_watching`'s two returned plans,
    always the same length because `_Instrumenter` appends to both in the
    same call to `_instrument`; `zip` is what keeps that pairing rather than
    an index into two lists that could drift apart under a future edit.
    """
    return [LoopTrace(repr_fn, limit, names, watches)
            for names, watches in zip(plan, watch_plan)]


class installed:  # noqa: N801 - reads as a context manager, and is one
    """Make the recorders reachable from the rewritten code, then don't.

    Removed again on the way out, including when the loop raised. Two reasons
    it matters: the namespace is the user's and is inspected with `dir()`, and
    the additive property this module claims would otherwise be false by one
    binding. A name that already existed is put back rather than deleted --
    unlikely, but silently destroying a user's variable is not a way to find
    out how unlikely.

    A class rather than `@contextlib.contextmanager` on purpose. An exception
    raised inside a `with` block is *thrown into* a generator-based manager and
    propagates back out of it, which appends `contextlib`'s frame and this
    module's to the user's traceback. The kernel goes to some trouble to keep
    its own frames out of what the user reads; a decorator would have quietly
    undone that. `__exit__` on a class is called and returns, so it never
    appears.

    An empty recorder list is a no-op: an ordinary statement's namespace stays
    exactly as untouched as it was before loops were instrumented at all.
    """

    __slots__ = ("_namespace", "_recorders", "_previous")

    def __init__(self, namespace: Dict[str, Any],
                 recorders: List[LoopTrace]) -> None:
        self._namespace = namespace
        self._recorders = recorders
        self._previous: Any = _MISSING

    def __enter__(self) -> "installed":
        if self._recorders:
            self._previous = self._namespace.get(RECORDERS, _MISSING)
            self._namespace[RECORDERS] = self._recorders
        return self

    def __exit__(self, *exc_info: Any) -> bool:
        if self._recorders:
            if self._previous is _MISSING:
                self._namespace.pop(RECORDERS, None)
            else:
                self._namespace[RECORDERS] = self._previous
        return False
