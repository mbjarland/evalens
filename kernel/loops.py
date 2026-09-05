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

Requires Python 3.9 or later, in line with the rest of the kernel.
"""

from __future__ import annotations

import ast
import copy
import sys
from typing import Any, Callable, Dict, List, Optional, Tuple

#: The name the rewritten code reaches the recorders through. Installed in the
#: namespace for the duration of one execution and removed afterwards, so a
#: loop leaves no trace of the machinery that watched it.
RECORDERS = "__evalens_loops__"

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
                 "varied", "bindings")

    def __init__(self, repr_fn: Callable[[Any], str], limit: int = HEAD_LIMIT,
                 names: Tuple[str, ...] = ()):
        self._repr = repr_fn
        self._limit = limit
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
    """Inserts the recorder calls around every loop body in scope."""

    def __init__(self) -> None:
        #: One entry per instrumented loop, in allocation order, holding the
        #: body names that loop's recorder watches. Its length is the number
        #: of recorders the rewritten tree expects.
        self.plan: List[Tuple[str, ...]] = []

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
        index = None
        if readable is not None:
            # Allocated before descending, so the loop the user pointed at is
            # index 0 however deeply the ones inside it nest. The body names
            # are read from the body as the user wrote it, before the rewrite
            # puts anything of its own in there.
            index = len(self.plan)
            self.plan.append(_body_names(node))

        self.generic_visit(node)

        if index is not None:
            node.body.insert(0, _recorder_call(index, "record", [readable],
                                               node))
            if self.plan[index]:
                # Last, so it sees what the iteration computed -- and appended
                # after the rewrite of any nested loop, which changes nothing
                # about the order it runs in but keeps this statement the last
                # thing in the body it belongs to.
                node.body.append(_recorder_call(index, "bind", [], node))
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
