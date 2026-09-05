"""Make a `for` loop report every value its target held, not just the last.

`for p in lst:` leaves `p` bound to the final element, and annotating that is
true and nearly useless: the reason to run a loop in an exploration file is to
watch what it does, and every iteration but the last is thrown away. This
module rewrites the loop so each iteration announces itself, and the kernel
paints the sequence.

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

**The injection goes first in the body.** `continue` then still records the
iteration it skipped out of, and `break` records the value it broke on -- the
value you were looking for, since it is why the loop stopped. Recording at the
bottom would silently drop both.

The rewrite is additive: it inserts statements and changes nothing else, so
the namespace a loop leaves behind is identical instrumented or not.
`test_loops` pins that by running both and comparing.

Requires Python 3.9 or later, in line with the rest of the kernel.
"""

from __future__ import annotations

import ast
import copy
from typing import Any, Callable, Dict, List, Optional, Tuple

#: The name the rewritten code reaches the recorders through. Installed in the
#: namespace for the duration of one execution and removed afterwards, so a
#: loop leaves no trace of the machinery that watched it.
RECORDERS = "__evalens_loops__"

#: How many leading values a summary keeps before it starts counting. Small on
#: purpose: this ends up on one line beside the code, and the first few values
#: plus the last is what tells you the shape of a run.
HEAD_LIMIT = 5

#: Per-value cap, applied by whoever supplies the `repr()`. The wire has its
#: own, much larger, limit; this one stops a single fat `repr()` from crowding
#: out the other five. This module deliberately holds no `repr()` policy of its
#: own -- taking one would mean importing the kernel, which imports this.
ITEM_LIMIT = 200


class LoopTrace:
    """What one loop's target held, iteration by iteration, bounded.

    One instance per loop rather than one per target name: nested loops, and
    an inner loop that reuses the outer loop's target name, are otherwise the
    same key and quietly interleave into one nonsensical sequence.
    """

    __slots__ = ("_repr", "_limit", "head", "last", "count")

    def __init__(self, repr_fn: Callable[[Any], str], limit: int = HEAD_LIMIT):
        self._repr = repr_fn
        self._limit = limit
        self.head: List[str] = []
        self.last: Optional[str] = None
        self.count = 0

    def record(self, value: Any) -> None:
        """Called once per iteration, from inside the user's loop.

        Deliberately tiny and total. This runs in the user's frame, so an
        exception raised here would surface as a failure of their code at a
        line they cannot see; `repr_fn` is expected to contain its own.
        """
        self.count += 1
        text = self._repr(value)
        if len(self.head) < self._limit:
            self.head.append(text)
        else:
            # Only the newest survives past the head, so memory is flat no
            # matter how long the loop runs.
            self.last = text

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


class _Instrumenter(ast.NodeTransformer):
    """Inserts one recorder call at the top of every loop body in scope."""

    def __init__(self) -> None:
        self.loops = 0

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
            # index 0 however deeply the ones inside it nest.
            index = self.loops
            self.loops += 1

        self.generic_visit(node)

        if index is not None:
            node.body.insert(0, _record_call(index, readable, node))
        return node


def _record_call(index: int, readable: ast.expr, at: ast.stmt) -> ast.stmt:
    """`__evalens_loops__[index].record(<target>)`, positioned at the loop.

    Every synthesised node is given the `for` statement's own position. An AST
    node without one is a hard compile error, and one carrying a plausible but
    wrong line is worse: `linecache` would quote a line the user never wrote
    into the middle of their traceback.
    """
    call = ast.Expr(
        value=ast.Call(
            func=ast.Attribute(
                value=ast.Subscript(
                    value=ast.Name(id=RECORDERS, ctx=ast.Load()),
                    slice=ast.Constant(value=index),
                    ctx=ast.Load()),
                attr="record",
                ctx=ast.Load()),
            args=[readable],
            keywords=[]))
    for node in ast.walk(call):
        ast.copy_location(node, at)
    return ast.fix_missing_locations(call)


def instrument(node: ast.stmt) -> Tuple[ast.stmt, int]:
    """A rewritten copy of `node`, and how many recorders it expects.

    The original is left untouched. The caller holds the user's parsed tree
    and may still want to read positions off it, and a transformer that
    mutates its input turns "evaluate this twice" into "instrument it twice".
    """
    instrumenter = _Instrumenter()
    rewritten = instrumenter.visit(copy.deepcopy(node))
    return ast.fix_missing_locations(rewritten), instrumenter.loops


def traces(count: int, repr_fn: Callable[[Any], str]) -> List[LoopTrace]:
    """One recorder per instrumented loop, in the order they were allocated."""
    return [LoopTrace(repr_fn) for _ in range(count)]


_MISSING = object()


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
