#!/usr/bin/env python3
"""Evalens kernel: a persistent Python namespace driven over stdin/stdout.

One process, one namespace dict, alive across requests until told to reset.
That persistence is the whole point -- it is what lets line 40 see what line 3
bound, and it is the difference between this and a fancy `print()`.

This is also the one component that executes arbitrary code from the user's
buffer, which makes it the only genuinely irreversible surface in the project.
Three commitments follow from that and are implemented here rather than merely
written down: nothing runs that was not explicitly asked for, the process can
always be killed and restarted, and user code cannot reach the channel this
protocol runs on.

Protocol
--------
Newline-delimited JSON, one request per line in, one response per line out.
JSON escapes newlines, so line framing is safe for arbitrary source text.

    -> {"id":1,"op":"eval","source":"...","line":3,"character":0,
        "filename":"/abs/path.py"}
    <- {"id":1,"ok":true,"resolved":true,"value":"[1, 2, 3]","display":"lst",
        "kind":"Assign","range":{"start":{"line":3,"character":0},
        "end":{"line":3,"character":15}},"stdout":"","stderr":""}

``value`` is what to show. Usually that is ``repr()``; for the few things
Python reprs by memory address it is a description instead, and an extra
``repr`` field then carries the untouched original -- see ``describe``.

Coordinates are VS Code's: 0-based line, 0-based character.

Ops: ``ping``, ``reset``, ``eval``, ``eval_file``. ``eval_above`` is reserved
and answers with an explicit not-implemented error until #13 lands.

Requires Python 3.9 or later (``ast.unparse``).
"""

from __future__ import annotations

import ast
import contextlib
import inspect
import io
import json
import linecache
import sys
import traceback
from typing import Any, Dict, Iterator, Optional

from resolver import Form, form_at, form_of

#: Hard cap on a repr() put on the wire. This is a transport guard, not a
#: display policy -- the extension knows the editor width and truncates for
#: reading. Without it, one `repr()` of a large frame is a multi-megabyte JSON
#: line.
WIRE_REPR_LIMIT = 8192

#: The real stdout, captured before anything can replace it. Responses are
#: written here rather than through `sys.stdout`, because user code is free to
#: rebind `sys.stdout` permanently and doing so must not silently redirect the
#: protocol into the user's own object.
_PROTOCOL_OUT = sys.stdout


@contextlib.contextmanager
def _user_io() -> Iterator[tuple[io.StringIO, io.StringIO]]:
    """Isolate evaluated code from the protocol channel.

    Two hazards, both silent if unhandled:

    * ``print()`` writes to the same stdout the protocol uses, and one stray
      line of user output desynchronises the framing for the rest of the
      session.
    * ``input()`` reads the same stdin the protocol uses. Left alone it does
      not merely block -- it consumes the *next request* as the user's typed
      answer, so the extension appears to hang while the kernel quietly eats
      its instructions. Handing it an empty stream turns that into an
      immediate EOFError, which is a comprehensible failure.

    Known limitation: this rebinds Python-level streams. A native extension
    writing straight to file descriptor 1 still escapes it.
    """
    out, err = io.StringIO(), io.StringIO()
    stdin = sys.stdin
    sys.stdin = io.StringIO()
    try:
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            yield out, err
    finally:
        sys.stdin = stdin


def _capped(text: str, limit: int) -> str:
    if len(text) > limit:
        return f"{text[:limit]}… <truncated from {len(text)} chars>"
    return text


def safe_repr(value: Any, limit: int = WIRE_REPR_LIMIT) -> str:
    """``repr(value)``, contained.

    A ``__repr__`` that raises is a bug in the user's code, not a reason for
    the kernel to die -- it would take the whole session's namespace with it.
    """
    try:
        text = repr(value)
    except BaseException as exc:  # noqa: BLE001 - user code raises anything
        return f"<repr() raised {type(exc).__name__}: {exc}>"
    return _capped(text, limit)


def _wrote_its_own_repr(value: Any, inherited: Any) -> bool:
    """Did a human write this object's ``__repr__``?

    Answered by comparing ``type(value).__repr__`` against the slot Python
    supplies, by identity -- never by looking at the text it produces. A custom
    ``__repr__`` is free to return anything, including something shaped exactly
    like the default, so matching on ``<... at 0x...>`` would quietly overrule
    deliberate ones while gaining nothing. Inheriting a ``__repr__`` from a
    base class counts as written: somebody wrote it, for this object.

    A metaclass that intercepts attribute access can make even this raise. It
    gets the benefit of the doubt, because leaving a repr alone is the
    recoverable mistake and rewriting one is not.
    """
    try:
        return type(value).__repr__ is not inherited
    except BaseException:  # noqa: BLE001 - attribute access runs user code
        return True


def _readable_name(obj: Any) -> Optional[str]:
    """``__qualname__`` without the closure noise, or ``__name__``, or None."""
    name = getattr(obj, "__qualname__", None) or getattr(obj, "__name__", None)
    if not isinstance(name, str) or not name:
        return None
    # `outer.<locals>.inner` records where a function was written rather than
    # what it is called; only the tail is worth the width.
    return name.rpartition("<locals>.")[2] or name


#: Checked in order, and only the first match is reported.
_CALL_RESULTS = (
    (inspect.isasyncgenfunction, "async generator"),
    (inspect.iscoroutinefunction, "coroutine"),
    (inspect.isgeneratorfunction, "generator"),
)


def _describe_callable(value: Any) -> Optional[str]:
    """``area(w, h)``, or ``area(w: int, h: int) -> int`` when annotated.

    Strictly more information than the address it replaces, in fewer
    characters, and identical on every evaluation. Generator and coroutine
    functions additionally say what *calling* them returns, because that is a
    real trap and the annotation is where it can still be cheap to learn: it
    is the explanation for why iterating the result a second time found it
    empty, and for why awaiting was required.
    """
    name = _readable_name(value)
    if name is None:
        return None
    try:
        signature = inspect.signature(value)
    except BaseException:  # noqa: BLE001 - introspection runs user code too
        # Builtins, C extensions and some descriptors have no signature to
        # find. Their repr carries no address either, so the fallback loses
        # nothing: `min` reads `<built-in function min>` exactly as before.
        return None
    text = f"{name}{signature}"
    produces = next(
        (word for test, word in _CALL_RESULTS if test(value)), None)
    if produces is None:
        return text
    if signature.return_annotation is inspect.Signature.empty:
        return f"{text} -> {produces}"
    # An annotated `async def fetch(u) -> str` declares what awaiting yields,
    # not what calling gives you. Both halves are true, so both are kept.
    return f"{text} ({produces})"


def _describe_class(value: Any) -> Optional[str]:
    """``class Config(name, port=8080)`` -- how to construct one.

    ``<class 'app.config.Config'>`` is stable already, so this is not about
    addresses. It is that the one question asked of a class in an editor is
    what it takes, and the answer is free.
    """
    name = _readable_name(value)
    if name is None:
        return None
    try:
        signature = inspect.signature(value)
    except BaseException:  # noqa: BLE001
        return None
    return f"class {name}{signature}"


def describe(value: Any) -> Optional[str]:
    """A stable description for a value Python reprs by identity, or None.

    ``<function area at 0x10614a610>`` is what this exists for. The address
    changes on every evaluation, so re-running a ``def`` -- the ordinary
    inner-loop move, and the one top-level resolution is designed to make easy
    -- produced a different annotation every time while nothing about the code
    had changed. That teaches the reader to distrust the single signal this
    extension exists to provide.

    ``None`` means "show the real repr", and it is the answer for everything
    that has one. A ``repr()`` someone wrote is a deliberate statement about
    how the object should read, and rewriting it would be the extension
    overruling the user's own code.
    """
    if inspect.isclass(value):
        # A metaclass __repr__ is as deliberate as any other.
        if _wrote_its_own_repr(value, type.__repr__):
            return None
        return _describe_class(value)
    if inspect.isroutine(value):
        # Functions, bound methods, builtins and method descriptors. None of
        # those types can be subclassed, so there is never a hand-written
        # __repr__ here to overrule.
        return _describe_callable(value)
    if _wrote_its_own_repr(value, object.__repr__):
        return None
    name = _readable_name(type(value))
    return None if name is None else f"<{name} instance>"


def wire_value(
    value: Any, limit: int = WIRE_REPR_LIMIT
) -> tuple[str, Optional[str]]:
    """What to show, and the untouched ``repr()`` when it is not the same.

    The description goes into ``value`` rather than into a field of its own so
    that no consumer can paint the address by forgetting to look for one. The
    real repr rides along beside it and is what the hover shows, so the
    substitution hides nothing.
    """
    text = safe_repr(value, limit)
    try:
        description = describe(value)
    except BaseException:  # noqa: BLE001 - introspection runs user code too
        description = None
    if description is None:
        return text, None
    return _capped(description, limit), text


def _position(line: int, character: int) -> Dict[str, int]:
    return {"line": line, "character": character}


def _range_of(form: Form) -> Dict[str, Dict[str, int]]:
    return {
        "start": _position(form.start_line, form.start_char),
        "end": _position(form.end_line, form.end_char),
    }


def _error(exc: BaseException, tb_skip: int = 0) -> Dict[str, Any]:
    """Format an exception for the wire, without the kernel's own frames.

    The user should see their file and their line numbers. Every frame this
    module contributes is noise that makes a NameError look like an
    extension bug.
    """
    tb = exc.__traceback__
    for _ in range(tb_skip):
        if tb is None:
            break
        tb = tb.tb_next
    return {
        "type": type(exc).__name__,
        "message": str(exc),
        "traceback": "".join(traceback.format_exception(type(exc), exc, tb)),
    }


class Kernel:
    """The namespace and the operations that act on it."""

    def __init__(self) -> None:
        self.namespace: Dict[str, Any] = {}
        self.reset()

    def reset(self) -> None:
        self.namespace.clear()
        self.namespace.update(
            {"__name__": "__evalens__", "__builtins__": __builtins__}
        )

    # -- operations ---------------------------------------------------------

    def handle(self, request: Dict[str, Any]) -> Dict[str, Any]:
        op = request.get("op")
        if op == "ping":
            return {"ok": True, "python": sys.version, "pid": __import__("os").getpid()}
        if op == "reset":
            self.reset()
            return {"ok": True}
        if op == "eval":
            return self.evaluate(request)
        if op == "eval_file":
            return self.evaluate_file(request)
        if op == "eval_above":
            # Reserved so the protocol shape is settled; the feature is #13.
            return {
                "ok": False,
                "error": {
                    "type": "NotImplemented",
                    "message": "eval_above is reserved; see issue #13",
                    "traceback": "",
                },
            }
        return {
            "ok": False,
            "error": {
                "type": "UnknownOp",
                "message": f"unknown op {op!r}",
                "traceback": "",
            },
        }

    def evaluate(self, request: Dict[str, Any]) -> Dict[str, Any]:
        source: str = request.get("source", "")
        line: int = request.get("line", 0)
        character: int = request.get("character", 0)
        filename: str = request.get("filename") or "<evalens>"

        # Let tracebacks quote the buffer rather than whatever is on disk. An
        # unsaved edit otherwise makes the reported source line simply wrong,
        # which is worse than showing none.
        linecache.cache[filename] = (
            len(source), None, source.splitlines(keepends=True), filename,
        )

        try:
            tree = ast.parse(source, filename=filename)
        except SyntaxError as exc:
            return self._syntax_error(exc)

        form = form_at(tree, line, character)
        if form is None:
            # A cursor on a blank line. Not an error, and deliberately not a
            # fallback to the nearest statement: that would run code the user
            # did not point at.
            return {"ok": True, "resolved": False}

        return self._run(form, filename)

    def evaluate_file(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """Run a whole module body, reporting what each statement produced.

        This is Calva's Load File. Its Clojure form is safe because a
        namespace is almost all definitions; a Python module body genuinely
        runs, so the translation matters.

        The faithful one is already right. "Load the namespace" in Python
        means *import the module*, and an imported module does not run its
        ``if __name__ == "__main__":`` block. ``__name__`` here is
        ``"__evalens__"``, so that guard is False without anything special
        being done about it. ``test_kernel`` pins it, because it is true as a
        consequence of the namespace setup and would be easy to break by
        making ``__name__`` look more realistic.

        Every statement goes through the same ``_run`` a single evaluation
        uses. That is deliberate rather than incidental: a bare ``exec`` loop
        would reintroduce the double-execution bug across an entire file,
        which is a far worse version of it than the single-statement case.

        Failures do not stop the load. A file being explored in is expected
        to contain broken lines -- that is why you are poking at it -- and
        abandoning everything below the first mistake means the command that
        sets up a session refuses to set one up.
        """
        source: str = request.get("source", "")
        filename: str = request.get("filename") or "<evalens>"

        linecache.cache[filename] = (
            len(source), None, source.splitlines(keepends=True), filename,
        )

        try:
            tree = ast.parse(source, filename=filename)
        except SyntaxError as exc:
            return self._syntax_error(exc)

        results = []
        ran = 0
        for statement in tree.body:
            outcome = self._run(form_of(statement), filename)
            results.append(outcome)
            if outcome["ok"]:
                ran += 1

        return {
            "ok": True,
            "statements": len(tree.body),
            "ran": ran,
            "results": results,
        }

    # -- internals ----------------------------------------------------------

    def _run(self, form: Form, filename: str) -> Dict[str, Any]:
        statement = ast.Module(body=[form.node], type_ignores=[])
        shown: Optional[str] = None
        raw_repr: Optional[str] = None

        with _user_io() as (out, err):
            try:
                # One dict for globals AND locals. Passing two makes
                # comprehensions and nested scopes fail to see module-level
                # names -- the classic exec() trap, and it would surface as
                # NameError on code that is plainly correct.
                #
                # `dont_inherit` on every compile below: without it, compile()
                # applies the future statements in effect in THIS frame, and
                # this module's own `from __future__ import annotations` turns
                # every annotation in the user's buffer into a string. Their
                # code would then behave differently under Evalens than under
                # `python file.py` -- get_type_hints, dataclasses and any
                # runtime validator see 'int' where the file says int.
                if isinstance(form.node, ast.Expr):
                    # An expression statement must be evaluated ONCE, not
                    # exec'd and then re-evaluated for display. Running it
                    # twice appends twice, posts twice, charges twice. This
                    # is the exact side-effect duplication the explicit-
                    # trigger design exists to prevent, and it is invisible
                    # in a test that only evaluates pure expressions.
                    expression = ast.Expression(form.node.value)
                    value = eval(  # noqa: S307 - evaluating user code is the product
                        compile(expression, filename, "eval",
                                dont_inherit=True), self.namespace)
                    shown, raw_repr = wire_value(value)
                else:
                    exec(compile(statement, filename, "exec",
                                 dont_inherit=True), self.namespace)
                    if form.display is not None:
                        # Safe for the remaining statement kinds because every
                        # display expression they produce is a name, or a
                        # subscript/attribute read of one -- not the work the
                        # statement did. A property getter with side effects
                        # is the residual case, and is the user's own.
                        expression = ast.Expression(
                            ast.parse(form.display, mode="eval").body)
                        value = eval(  # noqa: S307
                            compile(expression, filename, "eval",
                                    dont_inherit=True),
                            self.namespace)
                        shown, raw_repr = wire_value(value)
            except BaseException as exc:  # noqa: BLE001
                # BaseException, not Exception: user code calling exit() raises
                # SystemExit, and taking the kernel down over it would discard
                # a whole session's namespace for a line someone ran by
                # accident.
                return {
                    "ok": False,
                    "error": _error(exc, tb_skip=1),
                    "kind": form.kind,
                    "range": _range_of(form),
                    "stdout": out.getvalue(),
                    "stderr": err.getvalue(),
                }

        outcome: Dict[str, Any] = {
            "ok": True,
            "resolved": True,
            "value": shown,
            "display": form.display,
            "kind": form.kind,
            "range": _range_of(form),
            "stdout": out.getvalue(),
            "stderr": err.getvalue(),
        }
        if raw_repr is not None:
            # Only when a description replaced it: sending it unconditionally
            # would double the width of every large value on the wire to say
            # the same thing twice.
            outcome["repr"] = raw_repr
        return outcome

    @staticmethod
    def _syntax_error(exc: SyntaxError) -> Dict[str, Any]:
        line = (exc.lineno or 1) - 1
        character = max((exc.offset or 1) - 1, 0)
        return {
            "ok": False,
            "error": {
                "type": "SyntaxError",
                "message": exc.msg or str(exc),
                "traceback": "".join(
                    traceback.format_exception_only(type(exc), exc)),
            },
            "range": {
                "start": _position(line, character),
                "end": _position(line, character),
            },
        }


def respond(payload: Dict[str, Any]) -> None:
    _PROTOCOL_OUT.write(json.dumps(payload) + "\n")
    _PROTOCOL_OUT.flush()


def main() -> None:
    kernel = Kernel()
    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        try:
            request = json.loads(raw)
        except json.JSONDecodeError as exc:
            respond({
                "id": None,
                "ok": False,
                "error": {"type": "ProtocolError", "message": str(exc),
                          "traceback": ""},
            })
            continue
        response = kernel.handle(request)
        response["id"] = request.get("id")
        respond(response)


if __name__ == "__main__":
    main()
