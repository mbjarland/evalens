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

Two channels
------------
The request pipe (file descriptors 0 and 1) carries requests and their
id-correlated responses, and **exactly one piece of code reads descriptor 0**:
the protocol loop in ``main``. That is not a style preference, it is the
invariant the whole design rests on. The moment a second reader exists --
anything servicing a message *during* an evaluation -- the two race for lines
on one stream, and whichever happens to be blocked wins. A request arriving
while user code is busy would be swallowed by the wrong reader, its response
never written, and the extension left waiting on a promise that cannot settle.

So everything that must be dealt with while an evaluation is running lives on
a second pipe, descriptors 3 and 4 (``--control-in`` / ``--control-out`` to
move them). A daemon thread reads descriptor 3 and is never blocked by
whatever the main thread is doing, which is the entire point.

    fd 0 -> requests    fd 3 -> interrupt, input_reply
    fd 1 <- responses   fd 4 <- interrupt_ack, status, input_request, stream

**Nothing on the control channel is a reply to anything on the request
channel.** That is what makes a server-initiated message unmistakable: it is
not told apart from a stale response by some rule applied to a shared stream,
it arrives somewhere a response never can. Jupyter splits its channels the
same way and for the same reason.

Protocol
--------
Newline-delimited JSON, one request per line in, one response per line out.
JSON escapes newlines, so line framing is safe for arbitrary source text.

    -> {"id":1,"op":"eval","source":"...","line":3,"character":0,
        "filename":"/abs/path.py"}
    <- {"id":1,"ok":true,"resolved":true,"value":"[1, 2, 3]","display":"lst",
        "kind":"Assign","range":{"start":{"line":3,"character":0},
        "end":{"line":3,"character":15}},"stdout":"","stderr":""}

``value`` is what the statement itself produced. Usually that is ``repr()``;
for the few things Python reprs by memory address it is a description instead,
and an extra ``repr`` field then carries the untouched original -- see
``describe``.

``names`` is what the names on the line hold, which for most lines is the
answer the reader wanted and ``value`` is not::

    -> {"id":2,"op":"eval","source":"print('y:', y)\\n","line":0,...}
    <- {"id":2,...,"display":"print('y:', y)","value":"None",
        "names":[{"name":"y","value":"[1, 2, 3, 4]"}]}

Each entry may carry its own ``repr`` on the same terms as the one above.
Present only when there is something to report; see ``_named_values``. A line
naming more than the cap allows also carries ``more_names``, how many were
left out, so that the extension can say the cap bit rather than let a name
vanish without a trace.

A ``for`` loop answers with one extra field, ``loop``, holding the sequence
its target ran through rather than only the value it stopped on::

    <- {..., "display":"p", "value":"4",
        "loop":{"values":["1","2","3","4"],"last":null,"count":4}}

``values`` are leading iterations, ``last`` is the final one when it is not
already among them, and ``count`` is how many there were. The extension turns
the three into one line; see ``loops`` for why the shape is bounded.

``bindings`` carries the same shape once per name the loop's *body* bound,
which is usually the result the reader came for -- the target is the input
being iterated::

    <- {..., "display":"v", "loop":{"values":["1","2","3"],...},
        "bindings":[{"name":"u","values":["4","8","12"],"last":null,
                     "count":3}]}

Each entry is bounded exactly as ``loop`` is and may add ``"constant":true``,
which says every iteration bound the same value and one reading is the whole
story. **A binding's ``count`` need not match the loop's.** An iteration that
hit ``continue`` or ``break`` computed no result, so it contributes nothing;
consumers must render the two sequences independently rather than as columns
of one table. Present only when there is something to report.

A compound statement -- a ``def``, a loop, an ``if`` -- answers with an
``anchor``, the line its value belongs beside::

    <- {..., "display":"greet", "kind":"FunctionDef", "anchor":3,
        "range":{"start":{"line":3,...},"end":{"line":4,...}}}

``range`` still covers the whole statement, because that is what shows how
much code ran; ``anchor`` is where the answer is written. The field is absent
whenever the two agree, which is every statement that is not compound.

``binds`` and ``reads`` are the module-level names the statement wrote and the
ones it consulted, and they are the only fields on the wire that say nothing
about this statement's own answer::

    -> {"id":3,"op":"eval","source":"x = 1\\ny = x + 1\\n","line":1,...}
    <- {"id":3,...,"display":"y","value":"2","reads":["x"],"binds":["y"]}

They exist so the extension can decide which *other* annotations this
evaluation has just put out of date -- an annotation that reads ``x`` and sits
below one that binds it. Nothing is re-run on the strength of them; see
``defs_and_uses``. Either is absent when empty.

Coordinates are VS Code's: 0-based line, 0-based character.

``eval_file`` takes the whole buffer and, optionally, ``start_line`` and
``end_line`` -- a 0-based inclusive range narrowing the load to the statements
those lines touch, which is how a selection is run::

    -> {"id":3,"op":"eval_file","source":"...","start_line":9,"end_line":12,
        "filename":"/abs/path.py","allow_stdin":true}
    <- {"id":3,"ok":true,"statements":2,"ran":2,"results":[...],
        "range":{"start":{"line":8,...},"end":{"line":13,...}}}

The range is over the whole source, never a slice of it: line numbers in
tracebacks and in every range on the wire have to keep pointing at the file
the user is looking at. ``statements`` counts what the request covered, and
the response's ``range`` is what actually ran -- wider than the selection
whenever a statement was only partly inside it, and absent when nothing was.

``outline`` answers with the same ranges and anchors for every top-level
statement in a file, and runs none of them::

    -> {"id":4,"op":"outline","source":"...","filename":"/abs/path.py"}
    <- {"id":4,"ok":true,"statements":[
        {"kind":"Assign","range":{...}},
        {"kind":"FunctionDef","anchor":3,"range":{...}}]}

It exists so that Evaluate and Advance can step by statements rather than by
lines without a second parser on the extension side -- and it is a separate op
precisely so that asking where the next statement is cannot run anything.

Ops: ``ping``, ``reset``, ``eval``, ``eval_file``, ``outline``.
``eval_above`` is reserved and answers with an explicit not-implemented
error until #13 lands.

Interrupting
------------
An interrupt raises ``KeyboardInterrupt`` in the running code, and is
deliberately not a kill. ``_run`` catches it exactly as it catches any other
failure, so the evaluation comes back annotated like a ``NameError`` would --
**with the namespace still holding everything the session had built up**.
Killing the process would stop the loop just as well and throw that away,
which is the thing the user was protecting when they reached for Cancel.

The request arrives on the control channel and is delivered by
``_raise_in_main_thread``. Two consequences are implemented rather than hoped
for: an interrupt arriving while the kernel is idle (the race Cancel loses
when the evaluation finishes first) must not take the process down, and an
interrupt during ``eval_file`` must stop the load rather than fail one
statement and carry on into the next.

Known limit, worth stating rather than discovering: a tight loop inside a C
extension does not check for signals, so it will not stop promptly. Ordinary
Python loops and ``time.sleep`` will. User code that installs its own
``SIGINT`` handler likewise takes precedence -- the kernel does not overrule
it, because a handler someone wrote is as deliberate as any other code they
asked to run.

Asking the user something
-------------------------
Evaluated code gets a ``sys.stdin`` that asks the extension for a line rather
than one that is empty. **The interception point is stdin and nothing else**:
``input()``, ``sys.stdin.readline()`` and ``sys.stdin.read()`` all pass
through the one object, and nothing that needs a real terminal is wrapped or
pretended at. ``_AskingStdin`` says where that boundary is and why.

Both ``eval`` and ``eval_file`` may set ``allow_stdin`` to be asked. A load
refused to for a while, on the grounds that Jupyter's ``nbconvert`` and
``papermill`` set the same flag false -- but those are *unattended*, a batch
conversion with nobody watching, and the key that loads a file is a person
pressing it and waiting for the result. The reason for the flag does not
apply to them. Refusing produced a red ``EOFError`` on the prompt line and a
cascade of ``NameError`` beneath it, on exactly the teaching files the command
exists to set up. Whether twenty prompts is too many is a question for the
extension, which is where the person is.

An ``input_request`` carries the range of the statement that reached the read,
because only the kernel knows it: the extension sent a cursor position or a
whole file, and neither of those is the statement now blocked.

Cancelling a prompt sends a null answer, which reads as end-of-file and
raises ``EOFError`` -- today's behaviour, kept deliberately, because a student
who cannot get out of a prompt is worse off than one whose program errors.

Requires Python 3.9 or later (``ast.unparse``).
"""

from __future__ import annotations

import _thread
import ast
import contextlib
import inspect
import io
import json
import linecache
import os
import queue
import signal
import sys
import threading
import traceback
from typing import Any, Dict, Iterable, Iterator, Optional, TextIO, Tuple

import loops
from resolver import Form, form_at, forms_in

#: Hard cap on a repr() put on the wire. This is a transport guard, not a
#: display policy -- the extension knows the editor width and truncates for
#: reading. Without it, one `repr()` of a large frame is a multi-megabyte JSON
#: line.
WIRE_REPR_LIMIT = 8192

#: How many `name: value` pairs one line may carry. A line that reports every
#: name it mentions stops being an annotation and becomes a second copy of the
#: namespace, and the code it is written beside disappears under it.
NAME_LIMIT = 4

#: The real stdout, captured before anything can replace it. Responses are
#: written here rather than through `sys.stdout`, because user code is free to
#: rebind `sys.stdout` permanently and doing so must not silently redirect the
#: protocol into the user's own object.
_PROTOCOL_OUT = sys.stdout

#: The real stdin, captured for the same reason and read by the protocol loop
#: and by nothing else. `sys.stdin` is replaced for the duration of every
#: evaluation, and user code is free to rebind it for good; the channel
#: requests arrive on must not follow it. One reader, forever -- see the module
#: docstring for what a second one costs.
_PROTOCOL_IN = sys.stdin

#: Default file descriptors for the control channel. 3 and 4 because that is
#: what `stdio: ['pipe','pipe','pipe','pipe','pipe']` hands a Node child, in
#: declaration order.
_CONTROL_IN_FD = 3
_CONTROL_OUT_FD = 4

#: Guards writes to the control channel. Two threads write it: the control
#: thread acknowledging an interrupt, and the main thread announcing status.
_CONTROL_LOCK = threading.Lock()

#: Set by `_open_control`; None when the kernel was started without the extra
#: descriptors, in which case it behaves exactly as it did before the channel
#: existed.
_CONTROL_OUT: Optional[TextIO] = None

#: Hard cap on prompt text put on the wire. A prompt is a sentence someone
#: typed into `input()`; a megabyte of it is a bug, and a dialog is not where
#: to discover that.
PROMPT_LIMIT = 500

#: Answers to `input_request`, put here by the control thread and taken by
#: whichever evaluation is blocked waiting. A queue rather than a variable
#: because the two ends are different threads.
_INPUT_REPLIES: "queue.Queue" = queue.Queue()

#: Which question is outstanding. Only ever touched by the main thread, and
#: what lets a late answer to an abandoned prompt be discarded rather than
#: land in an unrelated variable.
_INPUT_SEQ = 0

#: Whether the evaluation currently running may ask for input. Set per
#: evaluation by `_user_io` from the request, and false by default: a caller
#: that forgot the flag gets today's EOFError, not a kernel that stops and
#: waits for a human nobody told to look.
_ALLOW_STDIN = False

#: Where the statement currently running is, so a prompt can say which line is
#: asking. Set per evaluation by `_user_io`. Only the kernel can supply it: the
#: extension sent a cursor position or a whole file, and during a load neither
#: of those is the statement that reached `input()`.
_RUNNING_AT: Optional[Dict[str, Any]] = None


def _open_control(argv: list) -> Tuple[Optional[TextIO], Optional[TextIO]]:
    """Open the control channel, or answer ``(None, None)``.

    The descriptors are addressed by number because a number is what a parent
    process can actually hand a child: Node's ``stdio`` array puts extra pipes
    at 3 and 4, in order. They are overridable on the command line because
    Python's own ``subprocess`` inherits descriptors as they are and cannot
    renumber them, so a test harness has to be able to say where it put them --
    and a channel no harness can open is a channel no test can cover.

    A missing descriptor is not an error. A kernel started with the three
    standard streams still evaluates code; it simply has no way to be
    interrupted or to ask a question, which is what it was before this channel
    existed and is what every existing three-pipe caller expects.
    """
    control_in, control_out = _CONTROL_IN_FD, _CONTROL_OUT_FD
    for flag, value in zip(argv, argv[1:]):
        try:
            if flag == "--control-in":
                control_in = int(value)
            elif flag == "--control-out":
                control_out = int(value)
        except ValueError:
            return None, None

    try:
        reader = os.fdopen(control_in, "r")
    except OSError:
        return None, None
    try:
        writer = os.fdopen(control_out, "w")
    except OSError:
        # Half a channel is no channel, and a file object left unreferenced
        # would close the descriptor from under whoever else holds it.
        reader.close()
        return None, None
    return reader, writer


def control(payload: Dict[str, Any]) -> None:
    """Write one message on the control channel, if there is one.

    Silent when there is not. Every caller is announcing something rather than
    asking for something, so a kernel running without the channel loses the
    announcement and nothing else.
    """
    if _CONTROL_OUT is None:
        return
    with _CONTROL_LOCK:
        _CONTROL_OUT.write(json.dumps(payload) + "\n")
        _CONTROL_OUT.flush()


def _raise_in_main_thread() -> None:
    """Raise ``KeyboardInterrupt`` in the main thread, wherever it is.

    Two mechanisms, because neither covers the ground alone.

    ``_thread.interrupt_main`` sets a flag the interpreter notices at its next
    bytecode boundary. That stops a Python loop within milliseconds and does
    nothing whatsoever for a main thread parked inside a blocking C call:
    measured here, ``time.sleep(5)`` interrupted this way sleeps the full five
    seconds. A real ``SIGINT`` does break that call, because the syscall
    returns ``EINTR``. So on any platform that can deliver a signal to itself,
    that is what is sent.

    Windows cannot -- ``os.kill`` there only speaks console control events to
    a process group -- and is also where ``interrupt_main`` happens to cover
    the sleeping case anyway, because CPython waits on a SIGINT event object
    on that platform. Between them the behaviour is the same everywhere, which
    is why there is no "Windows cannot be interrupted, so we restart and lose
    your namespace" branch anywhere in this project.
    """
    if os.name == "nt":
        _thread.interrupt_main()
    else:
        os.kill(os.getpid(), signal.SIGINT)


def _control_loop(stream: TextIO) -> None:
    """Service the control channel while the main thread is busy.

    A thread, and it has to be one: the reason this channel exists is that the
    main thread is occupied -- running a loop, or blocked waiting for someone
    to answer a prompt -- at exactly the moments something needs saying to it.

    Nothing here touches the namespace or writes a response. It hands work to
    the main thread and gets out of the way, which is what keeps a second
    thread from being a second way for user code to be run.
    """
    for line in stream:
        line = line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except ValueError:
            continue
        if not isinstance(message, dict):
            continue
        if message.get("op") == "interrupt":
            # Acknowledged before it is delivered, and deliberately so: the
            # acknowledgement says the kernel heard the request, which is a
            # weaker and more honest claim than "the loop has stopped". This
            # thread cannot make the stronger one -- a C extension spinning in
            # the main thread will not take the interrupt for as long as it
            # cares to run.
            control({"op": "interrupt_ack"})
            _raise_in_main_thread()
        elif message.get("op") == "input_reply":
            # Handed to whoever is blocked in `_AskingStdin.readline`. Nothing
            # is checked here: the sequence number decides whose answer this
            # is, and only the reader knows what it is waiting for.
            _INPUT_REPLIES.put((message.get("seq"), message.get("value")))


class _Tee(io.TextIOBase):
    """Captured for the response, and echoed as it is written.

    Both, not one or the other. The response still carries everything a
    statement printed, because that is the field every consumer already reads.
    And each write also goes out on the control channel as it happens, which
    is the only way a loop that prints its progress reads as progress rather
    than as a report delivered once it is over -- and it is what puts the
    prompt on screen before the box asking for an answer to it.
    """

    def __init__(self, name: str) -> None:
        self._name = name
        self._captured = io.StringIO()

    def write(self, text: str) -> int:
        if not text:
            return 0
        self._captured.write(text)
        control({"op": "stream", "name": self._name, "text": text})
        return len(text)

    def writable(self) -> bool:
        return True

    def getvalue(self) -> str:
        return self._captured.getvalue()

    def tail(self) -> str:
        """Whatever has been written since the last newline.

        This is the prompt. ``input("Name? ")`` writes its argument to stdout
        and *then* calls ``readline()`` -- the prompt is not a parameter of the
        read, it is output that has not been terminated yet, which is exactly
        why a terminal shows it on the line you type on. Reading it back here
        is what lets the stub carry a prompt without hooking ``input`` itself.
        """
        return self._captured.getvalue().rpartition("\n")[2]


class _AskingStdin(io.TextIOBase):
    """Stdin for evaluated code: asks the extension for a line.

    **The scope of this feature is stdin, and nothing else.** One object, one
    interception point, and ``input()``, ``sys.stdin.readline()`` and
    ``sys.stdin.read()`` all pass through it. The alternative -- wrapping each
    function that might want to talk to a human -- is the version of this that
    never stops growing.

    What stays out, deliberately, and keeps failing the way it does today:

    * ``getpass.getpass()`` opens ``/dev/tty`` and reads the terminal
      directly. Where there is no controlling terminal it falls back to
      ``sys.stdin`` and lands here like anything else, and the request is
      marked as a password so the answer is not echoed; where there *is* one,
      it bypasses this object entirely and blocks. Interrupting is the way out
      of that, which is why the two features are siblings.
    * ``curses`` wants a terminal, and GUI toolkits open real windows. Neither
      is reachable from here and neither should be half-supported.

    The failure mode to avoid was never "too many functions to hook". It was
    hooking something that needs a terminal and half-succeeding.
    """

    def __init__(self, out: "_Tee", err: "_Tee") -> None:
        self._out = out
        self._err = err

    def readable(self) -> bool:
        return True

    def isatty(self) -> bool:
        # Truthfully. Code that asks is usually deciding whether a human is
        # there, and answering yes would invite the terminal handling this
        # object cannot provide.
        return False

    def readline(self, size: int = -1) -> str:  # noqa: ARG002 - size ignored
        """Ask for one line, and block until it arrives.

        Blocking is correct and is what a REPL does. It is also why this
        feature could not ship without a way to interrupt: while this waits,
        a prompt the user dismissed and a genuinely hung kernel look identical
        from the outside.
        """
        if _CONTROL_OUT is None or not _ALLOW_STDIN:
            # No channel to ask on, or a caller that said not to ask. Empty is
            # what `input()` turns into EOFError, which is the behaviour this
            # had before there was anywhere to ask, kept deliberately.
            raise EOFError(_no_input_message())
        global _INPUT_SEQ
        _INPUT_SEQ += 1
        wanted = _INPUT_SEQ
        # The prompt is whatever user code has written and not terminated:
        # stdout for `input()`, stderr for the one thing that prompts there.
        prompt = self._out.tail() or self._err.tail()
        control({
            "op": "input_request",
            "seq": wanted,
            "prompt": _capped(prompt, PROMPT_LIMIT),
            "password": _reading_a_password(),
            # Which line is asking. The extension marks and reveals it, so a
            # prompt from a statement scrolled off screen brings the reader to
            # it rather than opening a box about code they cannot see.
            **(_RUNNING_AT or {}),
        })
        while True:
            try:
                seq, value = _INPUT_REPLIES.get(timeout=0.1)
            except queue.Empty:
                # The poll is not politeness. A bare `get()` is a lock
                # acquisition, and on Windows that is not reliably
                # interruptible -- the timeout is what gives the interpreter a
                # bytecode boundary at which to run a pending KeyboardInterrupt,
                # which is the only way out of a prompt nobody answers.
                continue
            if seq != wanted:
                # An answer to a question that was already abandoned, most
                # likely because the evaluation asking it was interrupted.
                # Letting it stand as this answer would put someone's earlier
                # typing into an unrelated variable.
                continue
            if value is None:
                # Cancel. `input()` turns an empty read into EOFError, which
                # is preserved on purpose as the escape hatch: a student who
                # cannot get out of a prompt is worse off than one whose
                # program raises.
                return ""
            return value if value.endswith("\n") else value + "\n"

    def read(self, size: int = -1) -> str:  # noqa: ARG002 - size ignored
        """Everything, which means asking until the answer is EOF."""
        chunks = []
        while True:
            line = self.readline()
            if not line:
                return "".join(chunks)
            chunks.append(line)


def _no_input_message() -> str:
    """Why a read failed, in the terms of what the user just did."""
    if _CONTROL_OUT is None:
        return ("EOF when reading a line (this kernel has no channel to ask "
                "for input on)")
    return "EOF when reading a line (this evaluation was asked not to prompt)"


def _reading_a_password() -> bool:
    """Is the code that asked for this line inside ``getpass``?

    Noticed rather than hooked, which is the whole difference. The boundary
    this feature keeps is that it intercepts ``sys.stdin`` and nothing else, so
    ``getpass`` is not wrapped -- but when it falls back to ``sys.stdin``, as
    it does wherever there is no controlling terminal, the read arrives here
    like any other and echoing it into a visible box would leak the one thing
    that function exists to hide. Walking the stack is how a stream can tell
    without reaching into the module that called it.
    """
    frame = sys._getframe(1)
    while frame is not None:
        if frame.f_globals.get("__name__") == "getpass":
            return True
        frame = frame.f_back
    return False


@contextlib.contextmanager
def _user_io(allow_stdin: bool = False,
             at: Optional[Dict[str, Any]] = None
             ) -> Iterator[tuple[_Tee, _Tee]]:
    """Isolate evaluated code from the protocol channel.

    Two hazards, both silent if unhandled:

    * ``print()`` writes to the same stdout the protocol uses, and one stray
      line of user output desynchronises the framing for the rest of the
      session.
    * ``input()`` reads the same stdin the protocol uses. Left alone it does
      not merely block -- it consumes the *next request* as the user's typed
      answer, so the extension appears to hang while the kernel quietly eats
      its instructions.

    The isolation is kept and given somewhere to go. Evaluated code still
    never touches the request channel; what it gets instead is a stream that
    asks the extension, on the control channel, and blocks for the reply.

    ``allow_stdin`` is the caller's decision and defaults to no, so that a
    caller which forgot the flag gets an ``EOFError`` rather than a kernel
    stopped and waiting for a human nobody told to look. Both commands say yes:
    a single evaluation because someone pressed a key and is sitting there, and
    a file load for the same reason. Jupyter's flag is false in ``nbconvert``
    and ``papermill`` because those run *unattended*, which a keypress is not.

    ``at`` is where the statement being run is, carried on any prompt it
    raises. Only this side knows: during a load the extension sent a whole
    file and has no idea which statement stopped.

    Known limitation: this rebinds Python-level streams. A native extension
    writing straight to file descriptor 1 still escapes it, and so does
    anything reading ``sys.__stdin__``.
    """
    global _ALLOW_STDIN, _RUNNING_AT
    out, err = _Tee("stdout"), _Tee("stderr")
    stdin, allowed, was_at = sys.stdin, _ALLOW_STDIN, _RUNNING_AT
    _ALLOW_STDIN, _RUNNING_AT = allow_stdin, at
    sys.stdin = _AskingStdin(out, err)
    try:
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            yield out, err
    finally:
        sys.stdin, _ALLOW_STDIN, _RUNNING_AT = stdin, allowed, was_at


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


def _documented_signature(value: Any, name: str) -> Optional[str]:
    """The signature a builtin states in the opening line of its ``__doc__``.

    Reading a docstring for this is convention, not a trick. A CPython builtin
    whose arguments cannot be expressed in the machine-readable form
    ``inspect.signature`` reads -- ``min`` with its ``*[, default=obj]``,
    ``range`` and ``dict`` with their overloads, ``int``, ``str``, ``type`` --
    writes one into the first line of its docstring *so that tooling can find
    it*. That is what ``help()`` prints and what every IDE has read for as long
    as builtins have been documented that way. We already had the string and
    were throwing it away.

    The line counts only when it opens with the object's own name followed by
    ``(``, and that guard is the whole safety of it: ``len.__doc__`` opens
    "Return the number of items in a container.", and a sentence rendered where
    a call belongs is worse than the repr it replaced, because the reader
    cannot tell it is wrong. Anything failing the test answers None and keeps
    its repr exactly as before.

    Only the first line is taken. ``dict`` documents four overloads and ``int``
    two; a one-line annotation has room for one, and the rest are a hover's
    problem.
    """
    doc = getattr(value, "__doc__", None)
    if not isinstance(doc, str):
        return None
    first = doc.lstrip().partition("\n")[0].rstrip()
    return first if first.startswith(f"{name}(") else None


#: Checked in order, and only the first match is reported.
_CALL_RESULTS = (
    (inspect.isasyncgenfunction, "async generator"),
    (inspect.iscoroutinefunction, "coroutine"),
    (inspect.isgeneratorfunction, "generator"),
)


def _describe_callable(value: Any) -> Optional[str]:
    """``def area(w, h)``, or ``def area(w: int, h: int) -> int`` when
    annotated.

    Strictly more information than the address it replaces, in fewer
    characters, and identical on every evaluation. Generator and coroutine
    functions additionally say what *calling* them returns, because that is a
    real trap and the annotation is where it can still be cheap to learn: it
    is the explanation for why iterating the result a second time found it
    empty, and for why awaiting was required.

    The ``def`` carries the one word the signature dropped. Replacing
    ``<function area at 0x…>`` with ``area(w, h)`` removed the noise and the
    only thing that said what kind of value this was, while ``_describe_class``
    next door kept Python's own keyword -- so a class read as a class and a
    function read as a call to one. It matters most where the line does not
    already say it: ``f = area`` annotates ``f: def area(w, h)``, which is what
    tells the reader what ``f`` now is.
    """
    name = _readable_name(value)
    if name is None:
        return None
    try:
        signature = inspect.signature(value)
    except BaseException:  # noqa: BLE001 - introspection runs user code too
        # Builtins, C extensions and some descriptors have no machine-readable
        # signature. The ones people meet first say it in their docstring
        # instead, which is where `min` keeps `min(iterable, *[, default=obj,
        # key=func]) -> value`. That line already states what calling returns,
        # so the generator/coroutine suffix below would have nothing to add to
        # it; anything without such a line keeps its repr, as before.
        documented = _documented_signature(value, name)
        return None if documented is None else f"def {documented}"
    text = f"def {name}{signature}"
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

    ``range``, ``dict``, ``int``, ``str`` and ``type`` are the ones where it
    was not free, because ``inspect.signature`` refuses all five. Their
    docstrings answer instead, and the ``class`` prefix stays on that answer so
    that a builtin type reads the same way a hand-written one does.
    """
    name = _readable_name(value)
    if name is None:
        return None
    try:
        signature = inspect.signature(value)
    except BaseException:  # noqa: BLE001
        documented = _documented_signature(value, name)
        return None if documented is None else f"class {documented}"
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


def _worth_a_pair(value: Any) -> bool:
    """Is this a value, or is it the machinery the line is written with?

    `print`, `type` and `isinstance` are noise beside the code that calls
    them, and so is `<module 'os'>` beside a line that happens to name `os`.
    Neither tells the reader anything about what just happened, and both cost
    the width that the values do use.

    A user's own function is skipped by the same rule. Its signature is worth
    showing when the `def` runs -- which is where the `def` already shows it --
    and not on every line that calls it afterwards.
    """
    return not inspect.ismodule(value) and not callable(value)


def _named_values(
    namespace: Dict[str, Any], names: Iterable[str], limit: int = NAME_LIMIT
) -> Tuple[list, int]:
    """What the names on a line hold, and how many the cap left out.

    A dictionary lookup and nothing else. Reading a bare name out of the
    namespace cannot run user code, which is what makes doing it unbidden
    safe; #40 settles that an annotation is a trace, so these are read once,
    here, and never refreshed afterwards.

    A name the namespace does not hold is simply not reported. That is how
    builtins drop out without a list of them -- `print` and `len` live in
    `__builtins__`, not here -- and it also covers a comprehension target that
    never escaped its scope and an `except ... as` name Python has already
    deleted.

    Past the cap a name is counted rather than dropped in silence. The
    silence is what made the cap read as a bug rather than as a limit: on
    `print(type(lst), type(tup), type(d), type(s), type(empty_set))` the fifth
    name simply vanished, and a reader who counts five names on the line and
    four values beside it cannot tell whether it was omitted, unreadable, or
    somehow not a name.
    """
    pairs = []
    more = 0
    for name in names:
        if name not in namespace:
            continue
        value = namespace[name]
        if not _worth_a_pair(value):
            continue
        if len(pairs) >= limit:
            # Counted, never `repr()`-ed. The cap is what keeps a line from
            # disappearing under a second copy of the namespace, and rendering
            # the values it exists to leave out would defeat it.
            more += 1
            continue
        shown, raw_repr = wire_value(value)
        pair = {"name": name, "value": shown}
        if raw_repr is not None:
            pair["repr"] = raw_repr
        pairs.append(pair)
    return pairs, more


def _unwatched(names: Iterable[str], recorders: list) -> list:
    """`names`, minus the ones a loop's body recorder already reports.

    Split out because the reason is easy to lose: this is not a tidy-up, it is
    what stops one name appearing twice on a line saying two different things.
    `u` recorded as `4, 8, 12` and read back out of the namespace as `12` are
    both true, and side by side one of them reads as a correction of the other.
    """
    if not recorders:
        return list(names)
    watched = recorders[0].bindings
    return [name for name in names if name not in watched]


def _instrumented(node: ast.stmt) -> tuple[ast.stmt, list]:
    """`node` rewritten to announce each iteration, plus its recorders.

    Only a loop is touched, and only the loop the user pointed at -- the
    rewrite descends into loops nested directly inside it, but never into a
    `def` or `class` in the body, whose loops run at a time this evaluation
    knows nothing about.

    Anything else comes back unchanged with no recorders, which is what makes
    the loop support cost the other statement kinds nothing at all.
    """
    if not isinstance(node, (ast.For, ast.AsyncFor)):
        return node, []
    rewritten, plan = loops.instrument(node)
    return rewritten, loops.traces(
        plan, lambda value: safe_repr(value, loops.ITEM_LIMIT))


def _position(line: int, character: int) -> Dict[str, int]:
    return {"line": line, "character": character}


def _range_of(form: Form) -> Dict[str, Dict[str, int]]:
    return {
        "start": _position(form.start_line, form.start_char),
        "end": _position(form.end_line, form.end_char),
    }


def _anchor_of(form: Form) -> Dict[str, Any]:
    """The `anchor` field, present only when it is not the end of the range.

    A compound statement's value belongs beside the line that introduces it,
    not beside the last line of its body, so the annotation and the region
    highlight stop sharing one position. Everything else anchors where it
    always did, and says nothing extra on the wire to say so.
    """
    if form.anchor_line == form.end_line:
        return {}
    return {"anchor": form.anchor_line}


def _located(form: Form) -> Dict[str, Any]:
    """Where a statement is, in the shape a prompt puts on the wire.

    The same two fields an outcome carries, so a prompt and the value that
    eventually replaces it land on the same line rather than one on the header
    and one on the last line of the body.
    """
    return {"range": _range_of(form), **_anchor_of(form)}


def _dependencies_of(form: Form) -> Dict[str, Any]:
    """The `binds` and `reads` fields, each present only when it has content.

    What the extension does with them is mark, never run: re-evaluating a
    statement that binds `x` puts every *later* annotation that reads `x` out
    of date, and saying so is the whole of it. Sent on the failure path too --
    a statement that raised may have bound something before it did, and a
    marker that is wrong costs a grey pixel where a missing one costs the thing
    this is for.
    """
    fields: Dict[str, Any] = {}
    if form.binds:
        fields["binds"] = list(form.binds)
    if form.reads:
        fields["reads"] = list(form.reads)
    return fields


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


def _selected_lines(request: Dict[str, Any]) -> Optional[Tuple[int, int]]:
    """The 0-based inclusive line range a load was narrowed to, or None.

    None means the whole file, which is what an ``eval_file`` with neither
    bound has always meant and still does.

    A request that asks to narrow and does not say how narrows to *nothing*.
    Reading a half-stated range as "then run everything" would answer a
    malformed request by executing every line in someone's buffer, which is
    the one outcome this command must never arrive at by accident.
    """
    start = request.get("start_line")
    end = request.get("end_line")
    if start is None and end is None:
        return None
    if not isinstance(start, int) or not isinstance(end, int):
        return (0, -1)
    return (max(start, 0), end)


def _was_interrupted(outcome: Dict[str, Any]) -> bool:
    """Did this outcome fail because someone pressed Cancel?

    The error type on the wire is the record of it. ``_run`` reports an
    interrupt through the same path as every other failure on purpose -- that
    is what makes the namespace survive -- so the only thing left to tell the
    two apart is the name the exception already carries.
    """
    return outcome.get("error", {}).get("type") == "KeyboardInterrupt"


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
            return {"ok": True, "python": sys.version, "pid": os.getpid()}
        if op == "reset":
            self.reset()
            return {"ok": True}
        if op == "eval":
            return self.evaluate(request)
        if op == "eval_file":
            return self.evaluate_file(request)
        if op == "outline":
            return self.outline(request)
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

        # A single evaluation may prompt: someone pressed a key and is
        # sitting in front of the editor waiting for this line to answer.
        return self._run(form, filename,
                         allow_stdin=bool(request.get("allow_stdin")))

    def evaluate_file(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """Run a module body, reporting what each statement produced.

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

        ``start_line`` and ``end_line`` narrow the load to the statements a
        selection touches, and are a *range over the whole source* rather than
        a slice of it for reasons the rest of this method depends on. The
        buffer is parsed and cached entire, so a traceback quotes the line the
        user is looking at and every range on the wire is a real file
        position; a pre-sliced source would renumber both, and an annotation
        painted three lines from the statement it describes is worse than no
        annotation. Slicing also throws away what the snap needs -- the
        statement boundaries around the selection -- and what docstring
        suppression needs, which is whether a string opens the module or
        merely opens the selection.

        A load prompts, if the caller allows it. It used to refuse on
        Jupyter's precedent, and the precedent was misread: ``nbconvert`` sets
        that flag false because nobody is watching it, and somebody is
        watching this. Refusing turned a teaching file into a red ``EOFError``
        and a cascade of ``NameError`` under it -- the command that exists to
        set up a session refusing to, on the files it was built for. How many
        prompts is too many is a question for whoever is looking at the
        screen, and this is not that layer.
        """
        source: str = request.get("source", "")
        filename: str = request.get("filename") or "<evalens>"
        allow_stdin = bool(request.get("allow_stdin"))

        linecache.cache[filename] = (
            len(source), None, source.splitlines(keepends=True), filename,
        )

        try:
            tree = ast.parse(source, filename=filename)
        except SyntaxError as exc:
            return self._syntax_error(exc)

        selection = _selected_lines(request)
        forms = forms_in(tree, selection)

        results = []
        ran = 0
        for form in forms:
            # Prompts if the caller allowed it, exactly as a single evaluation
            # does. The flag is the caller's decision either way; nothing about
            # running many statements makes the person watching them go away.
            outcome = self._run(form, filename, allow_stdin=allow_stdin)
            results.append(outcome)
            if outcome["ok"]:
                ran += 1
            elif _was_interrupted(outcome):
                # Cancel means stop. Failures do not otherwise end a load --
                # that is the point of the paragraph above -- but an interrupt
                # is not the file being broken, it is the user asking for the
                # load to end, and carrying on into the next statement would
                # answer a request to stop by running more of their code.
                break

        response: Dict[str, Any] = {
            "ok": True,
            "statements": len(forms),
            "ran": ran,
            "results": results,
        }
        if selection is not None and forms:
            # What actually ran, which is not what was asked for whenever the
            # snap widened it. The extension has the selection and cannot work
            # this out from it, so the side that did the widening says so.
            response["range"] = {
                "start": _position(forms[0].start_line, forms[0].start_char),
                "end": _position(forms[-1].end_line, forms[-1].end_char),
            }
        return response

    def outline(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """Where every top-level statement is, without running any of them.

        The parser already works this out on the way to evaluating anything:
        a statement's range covers the whole of it, decorators included, and
        its anchor is the line its value belongs beside. Answering "where does
        the next statement start" from that is one lookup; deriving it from
        line text on the extension side would be a second, worse parser -- one
        that reads a comment inside a list literal as a gap between
        statements, and a ``def`` body as ten separate steps.

        **Nothing here executes.** That is why this is a separate op rather
        than another field on an evaluation: Evaluate and Advance asks where
        to go next on every keypress, and a question about the shape of a file
        must never be a reason to run part of it.
        """
        source: str = request.get("source", "")
        filename: str = request.get("filename") or "<evalens>"

        try:
            tree = ast.parse(source, filename=filename)
        except SyntaxError as exc:
            return self._syntax_error(exc)

        # The same `forms_in` a load walks, so an outline cannot disagree with
        # an evaluation about where a statement begins and ends.
        return {
            "ok": True,
            "statements": [
                {
                    "kind": form.kind,
                    "range": _range_of(form),
                    **_anchor_of(form),
                }
                for form in forms_in(tree)
            ],
        }

    # -- internals ----------------------------------------------------------

    def _run(self, form: Form, filename: str,
             allow_stdin: bool = False) -> Dict[str, Any]:
        node, recorders = _instrumented(form.node)
        statement = ast.Module(body=[node], type_ignores=[])
        shown: Optional[str] = None
        raw_repr: Optional[str] = None
        loop: Optional[Dict[str, Any]] = None
        bindings: list = []
        names: list = []
        more_names = 0

        with _user_io(allow_stdin, _located(form)) as (out, err):
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
                    if form.display is not None:
                        shown, raw_repr = wire_value(value)
                    # A docstring is the one expression statement the resolver
                    # declines to display. It still runs, and the region
                    # highlight still says so; what it must not do is restate
                    # a module's opening paragraph back at its author with the
                    # newlines escaped.
                else:
                    with loops.installed(self.namespace, recorders):
                        exec(compile(statement, filename, "exec",
                                     dont_inherit=True), self.namespace)
                    if recorders:
                        # A loop reports what it saw, not what its target
                        # happens to hold once it is over. Those differ
                        # whenever the body mutates what it was handed, and
                        # the sequence is only coherent if its last entry was
                        # taken the same way as the rest of it -- as that
                        # iteration began.
                        #
                        # Already text, recorded through `safe_repr` as each
                        # iteration began, so there is nothing left to
                        # describe and no untouched repr to send beside it.
                        loop = recorders[0].wire()
                        shown = recorders[0].latest
                        # What the body computed, on the same terms. The
                        # target is usually the input being iterated and this
                        # is usually the result, which is the half the reader
                        # came for.
                        bindings = recorders[0].bindings_wire()
                    elif form.display is not None:
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

                # After the statement and before anything else can touch the
                # namespace: these are what the names held at the moment this
                # line ran, which is the only thing an annotation ever claims.
                # Nothing is read on the failure path -- a statement that
                # raised leaves the namespace half-updated, and reporting a
                # name out of it would put a value beside code that did not
                # finish producing it.
                #
                # A name the loop's body recorder watched is left out, whether
                # or not any iteration bound it. Reporting it here as well
                # would say the same name twice on one line -- once as the
                # sequence it took, once as where it stopped -- and for a name
                # no iteration reached, the value in the namespace is whatever
                # an earlier evaluation left there rather than anything this
                # statement did.
                names, more_names = _named_values(
                    self.namespace, _unwatched(form.names, recorders))
            except BaseException as exc:  # noqa: BLE001
                # BaseException, not Exception, and this catch carries more
                # weight than it looks like it does.
                #
                # SystemExit is the obvious one: user code calling exit()
                # would otherwise take the kernel down and discard a whole
                # session's namespace for a line someone ran by accident.
                #
                # KeyboardInterrupt is the other, and it is how Cancel works.
                # An interrupt asked for on the control channel is raised right
                # here, in the middle of the user's loop; reporting it this way
                # rather than letting it escape is what makes an interrupted
                # evaluation fail like any other failure -- annotated, on its
                # own line, with everything the session had bound still bound.
                # It is tested rather than assumed, because nothing about the
                # line above says "and this is the stop button".
                return {
                    "ok": False,
                    "error": _error(exc, tb_skip=1),
                    "kind": form.kind,
                    "range": _range_of(form),
                    **_anchor_of(form),
                    **_dependencies_of(form),
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
            **_anchor_of(form),
            **_dependencies_of(form),
            "stdout": out.getvalue(),
            "stderr": err.getvalue(),
        }
        if raw_repr is not None:
            # Only when a description replaced it: sending it unconditionally
            # would double the width of every large value on the wire to say
            # the same thing twice.
            outcome["repr"] = raw_repr
        if loop is not None:
            # Present only for a loop, so a reader of the wire can tell "this
            # ran once" from "this ran and the sequence is elsewhere".
            outcome["loop"] = loop
        if bindings:
            # Absent for a loop whose body bound nothing worth watching, and
            # never parallel to `loop`: an iteration that left early computed
            # no result, so a binding legitimately has fewer entries than the
            # target has. See `loops` for why filling that in would be a lie.
            outcome["bindings"] = bindings
        if names:
            # Absent rather than empty, in line with the two above: a line
            # with nothing else to say about it costs no field.
            outcome["names"] = names
            if more_names:
                # Only alongside the names it is a footnote to, and only when
                # the cap actually bit -- which is nearly no line at all.
                outcome["more_names"] = more_names
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
    """Read one request per line and answer it, until the channel closes.

    Written as an explicit ``readline`` loop rather than ``for raw in
    sys.stdin`` for two reasons that both come from interrupts. It reads
    ``_PROTOCOL_IN`` -- the stream captured at import -- so that user code
    rebinding ``sys.stdin`` cannot redirect the request channel. And a
    ``KeyboardInterrupt`` raised while this loop is waiting has somewhere to be
    caught, which an iterator holding the loop does not offer.
    """
    global _CONTROL_OUT
    control_in, _CONTROL_OUT = _open_control(sys.argv)
    if control_in is not None:
        threading.Thread(target=_control_loop, args=(control_in,),
                         name="evalens-control", daemon=True).start()

    kernel = Kernel()
    while True:
        try:
            raw = _PROTOCOL_IN.readline()
        except KeyboardInterrupt:
            # An interrupt that arrived with nothing running. Cancel loses
            # this race whenever the evaluation finishes first, and it would
            # be a poor trade to answer it by taking down the process holding
            # the namespace that interrupting rather than killing exists to
            # preserve.
            continue
        if not raw:
            # The extension closed the pipe: the window went away, or the
            # kernel was restarted. Exit rather than spin.
            return
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
        if not isinstance(request, dict):
            # `42` and `"hello"` are valid JSON and not requests. Left
            # unchecked, `request.get("op")` raises AttributeError out of the
            # protocol loop and takes the whole namespace with it -- which is
            # a spectacular cost for someone else's stray line.
            respond({
                "id": None,
                "ok": False,
                "error": {"type": "ProtocolError",
                          "message": f"expected a request object, got "
                                     f"{type(request).__name__}",
                          "traceback": ""},
            })
            continue

        request_id = request.get("id")
        try:
            control({"op": "status", "state": "busy", "id": request_id})
            response = kernel.handle(request)
            response["id"] = request_id
            # Idle before the answer, so that a client which reads the answer
            # and immediately asks "is anything running?" cannot be told yes.
            control({"op": "status", "state": "idle", "id": request_id})
            respond(response)
        except KeyboardInterrupt as exc:
            # `_run` catches an interrupt raised inside user code, so getting
            # here means it landed between the statements of a file load, or
            # in the microseconds spent writing the answer. Either way the
            # request still gets one: a request with no response is a spinner
            # that never stops, and a duplicate response is harmless because
            # the extension drops a reply whose id it has already settled.
            control({"op": "status", "state": "idle", "id": request_id})
            respond({"id": request_id, "ok": False, "error": _error(exc)})


if __name__ == "__main__":
    main()
