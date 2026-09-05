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

Everything user code prints leaves on the control channel, and it does so for
the life of the process rather than for the life of a statement. ``sys.stdout``
and ``sys.stderr`` are replaced once, at startup, and never restored -- see
``_UserStream``. A redirection that ends when a statement ends leaves a thread
started on line 4 still writing on line 40, straight onto the pipe the protocol
runs on, where a trailing newline gets the user's own ``print`` reported back to
them as a kernel fault and the absence of one splices their text onto the front
of the next response and destroys it. Output that arrives with no statement
running is sent marked ``unattributed``: it cannot be blamed on a line, and the
reader needs to see it more than they need it labelled.

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

Where it comes from is the annotation's whole safety, and there are three
sources rather than one. Most statements have their ``display`` read back out
of the namespace afterwards, which is allowed only because the resolver
guarantees that display is a bare name. An expression statement is evaluated
once and reported, never re-run. And an assignment whose target is an
attribute or a subscript reports **what it stored**, captured as it stored it
-- because reading ``acct.balance`` back would call a property getter the
assignment never called, and an annotation may not execute user code the
statement did not. ``resolver._value_source`` decides which of the three
applies, and it decides for every statement kind.

One statement has no ``display`` and a ``value`` all the same. ``from pkg
import *`` binds a set of names rather than one, so there is nothing to write
beside it, and what it answers with is how many names it brought in -- read
out of the exporting module's own dictionary, which is stable across
evaluations and cannot run anything. See ``_star_import``.

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

A buffer that does not parse whole is answered from the part that does, and
both ``eval`` and ``eval_file`` then carry ``partial``::

    <- {"id":4,"ok":true,"statements":92,"ran":92,"results":[...],
        "partial":{"truncated_at":18,"error":{"type":"SyntaxError",...},
                   "range":{"start":{"line":18,...},"end":{"line":18,...}}}}

``truncated_at`` is the 0-based line where the part that does not parse
begins, and its ``range`` is where the break itself is, so the cause can be
painted on the line that caused it. The field is **absent** rather than false
when nothing was left out: its presence is the claim that this answer was
computed with less than the whole file, and a flag that is always there saying
``false`` cannot be told apart from one nobody filled in.

``partial`` and ``range`` are independent and both may appear. ``range`` is
what ran; ``truncated_at`` is where parsing stopped. A selection is applied
*inside* the part that parsed, so one lying entirely below ``truncated_at``
answers ``statements: 0`` with ``partial`` set and no ``range`` -- nothing ran,
and the reason is on the wire. It is emphatically not answered by running the
prefix instead, which would execute code nobody selected.

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

How much to show
----------------
An ``eval`` or ``eval_file`` request may carry ``limits``: ``loop_values``,
how many of a loop's iterations to keep, and ``names``, how many of a line's
names to read. Both are user preferences and both are sent per request rather
than configured into the kernel, because a preference changed between two
keypresses has to apply to the second one, and the only way to reconfigure a
kernel that remembered them would be to restart it -- which discards the
namespace, the one thing a session cannot get back. Zero means off, and it
turns the *work* off rather than the display: an uninstrumented loop costs
nothing per iteration, and a line whose names nobody wants is a line the
namespace is never read for. Absent limits mean this module's defaults, so a
caller that says nothing gets what it always got.

Requires Python 3.9 or later (``ast.unparse``).
"""

from __future__ import annotations

import _thread
import ast
import builtins
import collections
import contextlib
import inspect
import io
import json
import linecache
import os
import queue
import reprlib
import signal
import sys
import threading
import traceback
import types
from typing import Any, Dict, Iterable, Iterator, Optional, TextIO, Tuple

import loops
from resolver import Form, Parsed, form_at, forms_in, parse_prefix

#: Where this kernel's own modules live, resolved once. At startup it is also
#: `sys.path[0]`, because that is what Python does for the script it was asked
#: to run -- see `_seal_kernel_directory` for why it does not stay there, and
#: `_script_path` for what belongs there instead.
_KERNEL_DIR = os.path.realpath(os.path.dirname(os.path.abspath(__file__)))

#: The kernel's own modules, held here after `_seal_kernel_directory` takes
#: them out of `sys.modules`. A plain list because the only thing it has to do
#: is exist: the references keep the module objects alive for the code that
#: already imported them, while the names they were registered under stop
#: resolving for anybody else.
_SEALED_MODULES: list = []

#: `__name__` for a source that names no file at all -- an unsaved buffer, or
#: a request that sent none. Every file gets its own name instead; see
#: `_module_name`. Kept as a dunder because it is a module name and reads like
#: one wherever it does surface, and kept as this one because it is what
#: Evalens has always called the namespace it has no better name for.
NO_MODULE_NAME = "__evalens__"

#: Hard cap on a repr() put on the wire. This is a transport guard, not a
#: display policy -- the extension knows the editor width and truncates for
#: reading. Without it, one `repr()` of a large frame is a multi-megabyte JSON
#: line.
#:
#: Not a setting. Nobody has a preference about how large a JSON line may be;
#: what a reader might want is a longer annotation, and this is not the number
#: that decides that. A cap the far end is allowed to raise is not a guard, it
#: is a suggestion -- and what it guards against is an editor hanging on a
#: value nobody asked to see whole.
WIRE_REPR_LIMIT = 8192

#: How many `name: value` pairs one line may carry. A line that reports every
#: name it mentions stops being an annotation and becomes a second copy of the
#: namespace, and the code it is written beside disappears under it.
#:
#: A preference, and the default behind `evalens.readNamesPerLine`. How much
#: of a line to spend on names depends on the file being read and the width of
#: the window reading it, neither of which this end knows. The number arrives
#: on the request instead -- see `_limits` -- so changing the setting takes
#: effect on the next keypress rather than the next kernel.
NAME_LIMIT = 4

#: How many names a star import may name before it settles for counting them.
#: It shares `NAME_LIMIT`'s starting point -- the annotation shares its line
#: with the code it describes, and `from math import *` binds sixty -- and
#: stops being the same question there, which is why one became a setting and
#: this did not.
#:
#: `NAME_LIMIT` is a cap: past it, names are dropped and counted, so raising it
#: buys more of the same kind of information for more width. This is a
#: threshold between two different annotations. Under it the line names every
#: name; over it the line says `20 names` and no more, because the first four
#: of sixty are wherever the module happened to define them rather than a
#: sample of anything. There is no setting to be had in between, and a number
#: in the settings UI that flips the annotation's whole shape at some value
#: would read as a cap and behave as something else.
STAR_NAME_LIMIT = 4

#: The name a captured assignment stores its value through. Installed in the
#: namespace for the duration of one statement and removed afterwards, exactly
#: as the loop recorders are: the namespace is the user's, and it is inspected
#: with `dir()`.
ASSIGNED = "__evalens_assigned__"

#: Distinguishes "nothing was captured" from "the statement assigned None".
_NOTHING = object()

#: The real stdout, captured before anything can replace it. Responses are
#: written here rather than through `sys.stdout`, because user code is free to
#: rebind `sys.stdout` permanently and doing so must not silently redirect the
#: protocol into the user's own object.
#:
#: This is also what makes the permanent redirection in `_install_user_streams`
#: possible rather than circular: by the time `sys.stdout` becomes something
#: that writes to the control channel, the protocol already holds the real one.
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
#:
#: Not a setting, for the same reason as `WIRE_REPR_LIMIT` and one more: the
#: box this text ends up in is VS Code's, and it stops showing the prompt long
#: before 500 characters whatever this says. A preference here would configure
#: something the user cannot see.
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


class _UserStream(io.TextIOBase):
    """``sys.stdout`` (or ``sys.stderr``) for the whole life of the kernel.

    Installed once by ``_install_user_streams`` and never taken away again,
    and that is the point rather than an implementation detail. A redirection
    scoped to a statement leaves whatever the user started -- a thread, a
    timer, an executor -- writing to the real descriptor 1 the moment the
    statement it was started by has returned, which is the pipe the protocol
    travels on. A line of user output landing there is at best reported to
    them as a kernel fault and at worst splices onto the front of the next
    response, destroying an answer that was computed correctly.

    So every write goes out on the control channel as a ``stream`` frame,
    whenever it happens. Two shapes, and the difference is the only thing
    ``_user_io`` still decides:

    * **While a statement is running** the text is also captured, so the
      response still carries everything the statement printed -- the field
      every consumer already reads -- and the frame is attributed to the
      evaluation in flight. Output written by a thread the statement itself
      started and joined belongs to that statement and lands here, which is
      what a terminal would show.
    * **With nothing running** there is no statement to attribute it to, and
      saying so is more honest than guessing. The frame carries
      ``unattributed``; the extension can still show it, which is what the
      user needs, and cannot claim it came from a line it did not come from.

    Writing is best-effort. A failed announcement must never surface as an
    exception in the middle of somebody's ``print()``, and there is nowhere
    else to put the text: the descriptor it would otherwise fall back to is
    the one this class exists to keep clean.
    """

    def __init__(self, name: str) -> None:
        self._name = name
        #: Where a running statement's output is accumulating, or None when
        #: nothing is running. Rebound by `_user_io`, read by every thread.
        self._captured: Optional[io.StringIO] = None

    def capture(self, buffer: Optional[io.StringIO]) -> Optional[io.StringIO]:
        """Start (or stop) collecting into ``buffer``; answer the old one."""
        previous, self._captured = self._captured, buffer
        return previous

    def write(self, text: str) -> int:
        if not text:
            return 0
        # Read once. A statement can finish between these two lines, and a
        # write that lands in a buffer nobody will read again is a far smaller
        # problem than one that raises AttributeError inside user code.
        captured = self._captured
        message = {"op": "stream", "name": self._name, "text": text}
        if captured is not None:
            captured.write(text)
        else:
            message["unattributed"] = True
        try:
            control(message)
        except Exception:  # noqa: BLE001 - see the class docstring
            pass
        return len(text)

    def writable(self) -> bool:
        return True

    def tail(self) -> str:
        """Whatever the running statement has written since the last newline.

        This is the prompt. ``input("Name? ")`` writes its argument to stdout
        and *then* calls ``readline()`` -- the prompt is not a parameter of the
        read, it is output that has not been terminated yet, which is exactly
        why a terminal shows it on the line you type on. Reading it back here
        is what lets the stub carry a prompt without hooking ``input`` itself.
        """
        captured = self._captured
        if captured is None:
            return ""
        return captured.getvalue().rpartition("\n")[2]


#: The two objects user code sees as its standard streams. Module-level and
#: shared, because they have to be reachable from a thread that outlives the
#: statement which started it -- that is the whole fix.
_USER_OUT = _UserStream("stdout")
_USER_ERR = _UserStream("stderr")


def _install_user_streams() -> None:
    """Put the capturing streams in place, for good.

    Called from ``main`` rather than at import, so that importing this module
    -- which a diagnostic or another test does -- does not silently take a
    process's stdout away from it. ``_PROTOCOL_OUT`` was captured at import,
    before this runs, which is what lets ``respond`` keep writing to the real
    descriptor while everything user code writes goes elsewhere.
    """
    sys.stdout = _USER_OUT
    sys.stderr = _USER_ERR


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

    def __init__(self, out: "_UserStream", err: "_UserStream") -> None:
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
             ) -> Iterator[tuple[io.StringIO, io.StringIO]]:
    """Attribute this statement's output to it, and let it ask questions.

    Two hazards, both silent if unhandled:

    * ``print()`` writes to the same stdout the protocol uses, and one stray
      line of user output desynchronises the framing for the rest of the
      session.
    * ``input()`` reads the same stdin the protocol uses. Left alone it does
      not merely block -- it consumes the *next request* as the user's typed
      answer, so the extension appears to hang while the kernel quietly eats
      its instructions.

    **Only the second of those is this function's job.** The output half is
    settled once and for all by ``_install_user_streams``: ``sys.stdout`` and
    ``sys.stderr`` are replaced for the life of the process, so there is no
    window -- not between statements, not after one has returned -- in which
    anything the user started can reach the protocol channel. What is left
    here is attribution, which is genuinely per statement: a buffer is put in
    front of the stream while this one runs, so its output comes back in the
    response, and taken away afterwards so a thread that outlives it is
    reported as unattributed rather than blamed on the next line the user
    evaluates.

    The stdin half stays scoped, because it is a question about *this*
    request. Evaluated code never touches the request channel; what it gets
    instead is a stream that asks the extension, on the control channel, and
    blocks for the reply.

    ``allow_stdin`` is the caller's decision and defaults to no, so that a
    caller which forgot the flag gets an ``EOFError`` rather than a kernel
    stopped and waiting for a human nobody told to look. Both commands say yes:
    a single evaluation because someone pressed a key and is sitting there, and
    a file load for the same reason. Jupyter's flag is false in ``nbconvert``
    and ``papermill`` because those run *unattended*, which a keypress is not.

    ``at`` is where the statement being run is, carried on any prompt it
    raises. Only this side knows: during a load the extension sent a whole
    file and has no idea which statement stopped.

    Known limitation, unchanged and worth restating because the permanent
    redirection above can read as more than it is: this rebinds *Python-level*
    streams. A native extension writing straight to file descriptor 1 still
    escapes it -- so does a subprocess or a multiprocessing worker, which
    inherits the descriptor itself -- and so does anything reading
    ``sys.__stdin__`` or writing ``sys.__stdout__``. Closing that would mean
    replacing descriptor 1 in the child rather than an attribute in it, which
    is a different design and a different ticket; the client is written to
    survive it rather than to assume it cannot happen.
    """
    global _ALLOW_STDIN, _RUNNING_AT
    out, err = io.StringIO(), io.StringIO()
    previous_out = _USER_OUT.capture(out)
    previous_err = _USER_ERR.capture(err)
    stdin, allowed, was_at = sys.stdin, _ALLOW_STDIN, _RUNNING_AT
    _ALLOW_STDIN, _RUNNING_AT = allow_stdin, at
    sys.stdin = _AskingStdin(_USER_OUT, _USER_ERR)
    try:
        yield out, err
    finally:
        _USER_OUT.capture(previous_out)
        _USER_ERR.capture(previous_err)
        sys.stdin, _ALLOW_STDIN, _RUNNING_AT = stdin, allowed, was_at


def _capped(text: str, limit: int) -> str:
    if len(text) > limit:
        return f"{text[:limit]}… <truncated from {len(text)} chars>"
    return text


#: How many items one collection shows before it starts eliding. IPython's
#: ``PlainTextFormatter.max_seq_length`` and numpy's print ``threshold`` are
#: both 1000, so the number is the ecosystem's rather than one picked here.
#: ``reprlib``'s own default of six is right for a *summary* of a value; this
#: is the value, and it has the whole wire limit to spend.
REPR_ITEM_LIMIT = 1000

#: How many items from the *end* of an elided collection survive -- numpy's
#: ``edgeitems``, for numpy's reason. The end of a sequence is where its length
#: is written: ``[0, 1, 2, … (+4,999,000 more) … 4999999]`` says which range
#: built it, while a prefix of the same list says only that it starts at zero.
REPR_EDGE_ITEMS = 3

#: How deep the walk goes before a nested value is replaced by the marker.
#: ``reprlib``'s own default, and the reason ``reprlib`` is fast: bounding by
#: shape rather than by output length means the discarded part is never built.
REPR_LEVEL_LIMIT = 6

#: How much of a string nested inside a collection is kept. The same reasoning
#: as the loop recorder's per-item cap: one fat element must not crowd out the
#: structure it sits in. A string evaluated on its own keeps the whole wire
#: limit, because there it *is* the value rather than one part of one.
REPR_NESTED_STRING_LIMIT = 200

#: Room the budget keeps back for the markers that say a value was cut. They
#: are written after the walk that spent the budget has already finished, and
#: the element that spends the last of it overshoots by its own width, so a
#: value aimed at exactly the wire limit lands just past it and is cut a second
#: time -- losing the tail the first cut went out of its way to fetch.
_MARKER_ROOM = 160

#: The least a single value is allowed, however little budget is left. Below
#: about this much an element is all marker and no value, which is worse than
#: not showing it.
_LEAST_ROOM = 32

#: The types this knows how to build to a budget, paired with the method that
#: does it. Order matters only in that the first match wins.
_BOUNDED_TYPES = (
    (list, "repr_list"),
    (tuple, "repr_tuple"),
    (dict, "repr_dict"),
    (set, "repr_set"),
    (frozenset, "repr_frozenset"),
    (collections.deque, "repr_deque"),
    (str, "repr_str"),
    (bytes, "repr_bytes"),
    (bytearray, "repr_bytes"),
)

#: The same table keyed for the case that is almost always the one: an exact
#: builtin, answered by a dict lookup rather than nine `issubclass` calls, and
#: this runs once per element of every collection rendered.
_BOUNDED_EXACTLY = {kind: method for kind, method in _BOUNDED_TYPES}


def _elision(count: int, noun: str = "") -> str:
    """``… (+9,994 more)`` -- the marker the extension already paints.

    Deliberately not ``...``, which is ``Ellipsis`` and therefore a value a
    list can genuinely contain; ``…`` is not Python at all, so an elided
    collection cannot be read as a short one holding a real element. The count
    is what stops it reading as a short one *at all*: it says how much is not
    being shown, which is the same contract ``sequenceText`` states for a
    loop's history, in the same shape, so a reader meets one convention.
    """
    return f"… (+{count:,} more{noun})"


def _repr_failed(value: Any, exc: BaseException) -> str:
    """What to show when the object's own ``__repr__`` raised.

    Names the type first, because that is the durable fact about the value and
    the thing ``<repr() raised RecursionError>`` on its own never said -- a
    ``__repr__`` that recurses is the case where the old message told the
    reader everything except which object they were looking at. The failure
    stays on the end, because a ``__repr__`` that raises is a bug in the user's
    code and swallowing it would make the annotation the last place they would
    think to look.
    """
    try:
        name = _readable_name(type(value)) or type(value).__name__
    except BaseException:  # noqa: BLE001 - a metaclass can break even this
        name = "?"
    try:
        detail = f"{type(exc).__name__}: {exc}"[:120]
    except BaseException:  # noqa: BLE001 - so can a custom exception's str()
        detail = type(exc).__name__
    return f"<{name} instance: repr() raised {detail}>"


def _last(x: Any, count: int) -> list:
    """The final ``count`` items, cheaply, or nothing when there is no cheap
    way.

    ``reversed()`` is O(1) to start on a list, tuple, deque or dict, so the end
    of a five-million-element sequence costs three steps rather than five
    million -- which is the whole reason the ends are affordable at all. A set
    raises ``TypeError`` here because it has no end to speak of, and that is
    the honest answer: its elision simply has no tail.
    """
    if count <= 0:
        return []
    try:
        items = []
        for item in reversed(x):
            items.append(item)
            if len(items) >= count:
                break
    except BaseException:  # noqa: BLE001 - __reversed__ is user code too
        return []
    items.reverse()
    return items


class _BoundedRepr(reprlib.Repr):
    """``repr()`` built to fit, rather than built whole and then cut.

    The defect this exists for is that ``repr(list(range(5_000_000)))`` spends
    a second and forty-five megabytes producing forty-four million characters
    of which the wire keeps eight thousand. The cap was applied to a string
    that had already been paid for, so it could not help with any of the cost
    -- and the kernel is single threaded, so nothing else is serviced while
    that runs. It looks exactly like a wedged kernel and it is reached by one
    ordinary keystroke.

    ``reprlib`` is the standard library's answer and the one IPython builds
    on. It bounds by element count and nesting depth rather than by output
    length, which is why it is fast: the discarded part is never built. Three
    things here are deliberately not ``reprlib``'s:

    **The ends are kept.** ``reprlib`` keeps a prefix. numpy and pandas both
    keep both ends, and for a value read beside the code that made it the end
    is the more informative half -- ``[0, 1, 2, … (+4,999,000 more) …
    4999999]`` says which range built the list, where a prefix says only that
    it starts at zero. It is also already this project's convention, because
    it is what a loop's history renders as.

    **Dispatch is by type identity, not by type name.** ``reprlib`` looks for
    ``repr_`` plus ``type(x).__name__``, which misroutes in both directions:
    ``class Stack(list)`` is not called ``list`` and so falls back to the full
    ``repr()`` this exists to avoid, and on Python before 3.14 a class the user
    happened to call ``list`` is formatted as one. Matching the type instead,
    and only while it still uses the ``__repr__`` its base supplies, bounds the
    subclass and leaves a hand-written ``__repr__`` alone -- the rule
    ``describe`` already follows, for the same reason.

    **Order is left as it is.** ``reprlib`` sorts dict keys and set elements to
    make its truncation deterministic. A dict's order is insertion order and is
    part of what the value *is*; showing it sorted would show something that
    never existed, next to the code that built it.

    What is not fixed: a type that wrote its own ``__repr__`` still pays for
    it in full. That is deliberate for one somebody wrote, and the cost of it
    for ``defaultdict`` and ``Counter``, which write their own to say what they
    are. The wire limit still bounds what such a repr *sends*; nothing can
    bound what it costs to produce without overruling it.

    **An element gets the same substitution the top level gets.** ``repr1``
    is the one place every value in a walked container passes through, so it
    is also the one place ``describe`` needed calling from -- see
    ``_describe_element`` -- rather than a second walk over the finished
    string or the finished structure. A function, a plain instance or a
    generator found three levels into a list is exactly as address-shaped as
    one bound to a name at the top, and was reaching the wire that way until
    this hook existed.
    """

    def __init__(self, budget: int) -> None:
        # `reprlib.Repr.__init__` takes no arguments before 3.12, so the caps
        # are set afterwards rather than passed in. Everything left untouched
        # -- `maxlist`, `maxdict` and the rest -- keeps reprlib's own default
        # and applies one level down, so a big structure shows its shape at
        # every level instead of spending the whole budget on its first
        # branch. That is numpy's `edgeitems` idea, reached from the top.
        super().__init__()
        self.maxlevel = REPR_LEVEL_LIMIT
        # Aimed a marker's width short of the limit, because the marker saying
        # a value was cut is itself written after the budget it was cut to fit
        # has been spent. Without the headroom every elided value lands a few
        # characters over the wire limit and gets cut a second time, by the
        # transport guard, which throws away the tail this went to fetch.
        self._budget = max(16, budget - _MARKER_ROOM)
        self.maxstring = self._budget
        self._left = self._budget
        self._active: set = set()

    def repr(self, x: Any) -> str:
        self._left = self._budget
        self._active = set()
        return self.repr1(x, self.maxlevel)

    def repr1(self, x: Any, level: int) -> str:
        if level < self.maxlevel:
            # Only below the top: `safe_repr`'s caller, `wire_value`, already
            # asks `describe()` about the value it was handed and keeps this
            # method's answer as the untouched repr the hover shows. Asking
            # again here for that same top-level call would substitute the
            # description into the very string that promise depends on being
            # left alone. Every element `repr_list` and friends recurse into
            # is reached at `level - 1`, which is always less than
            # `self.maxlevel`, so this reliably means "not the root value".
            described = self._describe_element(x)
            if described is not None:
                return described
        method = self._method(type(x))
        if method is None:
            return self.repr_instance(x, level)
        try:
            return method(x, level)
        except Exception:  # noqa: BLE001 - a broken __len__ or __iter__
            # A container that cannot be walked is still a value, and its own
            # `repr()` is the one thing that definitely knows how to say it.
            return self.repr_instance(x, level)

    def _describe_element(self, x: Any) -> Optional[str]:
        """``describe(x)``, billed to what is left of the budget, for a value
        found *inside* a container.

        The same dispatch `describe` uses at the top -- type identity and
        whether ``__repr__`` is inherited, never the type's name -- decides
        here too, because it is the one already-settled answer to "is this
        thing safe to replace", and a container holding a `Stack(list)` or a
        user class called ``list`` needs the identical rule the top level
        uses or it misroutes the same way `_method` would.

        Nothing here is bounded by element count or depth beyond what
        `describe` itself costs -- a handful of `isinstance`-shaped checks
        and an attribute read -- so this adds no walk of its own. It only
        ever runs on an element `repr_list` / `repr_dict` / `_repr_iterable`
        already decided to visit, and those are the calls `REPR_ITEM_LIMIT`
        and `REPR_LEVEL_LIMIT` bound; a five-million-element list still only
        ever offers up the same one thousand-odd elements this looks at
        whether or not they turn out to be describable.
        """
        try:
            text = describe(x)
        except BaseException:  # noqa: BLE001 - introspection runs user code
            return None
        if text is None:
            return None
        return self._charged(_capped(text, max(self._left, _LEAST_ROOM * 2)))

    def _method(self, kind: type) -> Any:
        """The bounded formatter for `kind`, or None to leave it alone."""
        name = _BOUNDED_EXACTLY.get(kind)
        if name is not None:
            return getattr(self, name)
        try:
            for base, name in _BOUNDED_TYPES:
                if issubclass(kind, base) and kind.__repr__ is base.__repr__:
                    return getattr(self, name)
        except BaseException:  # noqa: BLE001 - a metaclass can raise here
            return None
        return None

    def _charged(self, text: str) -> str:
        """Bill `text` to the budget, then hand it back.

        Only leaves are billed for their characters; a collection is billed
        for the punctuation it adds around them, two per element and four for
        a dict pair. Between them that is the output length, counted exactly
        once, which is what makes the budget stop the walk rather than merely
        trim its result -- and why a structure of ten thousand empty lists
        cannot spin, since an element costs something whatever it holds.
        """
        self._left -= len(text)
        return text

    def _cap(self, level: int, nested: int) -> int:
        return REPR_ITEM_LIMIT if level == self.maxlevel else nested

    def _cycle(self, x: Any, left: str, right: str) -> Optional[str]:
        """``[...]`` when this container is already being rendered above.

        Python's own containers carry this guard and print exactly this, so a
        list holding itself reads the same here as it does from ``print()``.
        Without it the walk would merely run out of depth and paint six levels
        of brackets, which says "deeply nested" about a value whose actual
        shape is "it is inside itself" -- and aliasing is a thing this project
        exists to make visible rather than to disguise.
        """
        if id(x) in self._active:
            return self._charged(f"{left}...{right}")
        return None

    def _repr_iterable(self, x: Any, level: int, left: str, right: str,
                       maxiter: int, trail: str = "") -> str:
        n = len(x)
        if n == 0:
            return self._charged(f"{left}{right}")
        seen = self._cycle(x, left, right)
        if seen is not None:
            return seen
        if level <= 0:
            return self._charged(f"{left}…{right}")
        self._left -= len(left) + len(right)
        cap = self._cap(level, maxiter)
        inner = level - 1
        self._active.add(id(x))
        try:
            tail = []
            # Built from the far end inwards, so that a budget which runs out
            # part way through costs the tail its inner items rather than the
            # last one -- the last one being the whole reason for having a
            # tail at all.
            for item in reversed(_last(x, min(REPR_EDGE_ITEMS, n - 1,
                                              cap // 2))):
                if self._left <= 0:
                    break
                self._left -= 2
                tail.append(self.repr1(item, inner))
            tail.reverse()
            head = []
            room = min(cap, n) - len(tail)
            for item in x:
                if len(head) >= room or self._left <= 0:
                    break
                self._left -= 2
                head.append(self.repr1(item, inner))
        finally:
            self._active.discard(id(x))
        if len(head) + len(tail) >= n:
            body = ", ".join(head + tail)
            # `(1,)` -- the comma is the tuple, so it is not decoration.
            return f"{left}{body}{trail if n == 1 else ''}{right}"
        return f"{left}{self._elided(head, tail, n)}{right}"

    def _elided(self, head: list, tail: list, n: int) -> str:
        """``0, 1, 2, … (+4,999,000 more) … 4999999`` -- what was kept, what
        was not, and where it ended.

        The count sits between the two ends rather than at the end, so the
        elision cannot be read as the value trailing off; and a tail keeps its
        own ``…`` on the left of it for the same reason the extension's loop
        summary does, so the number never looks like an element.
        """
        marker = _elision(n - len(head) - len(tail))
        # Charged after the fact, because until the walk stops there is no
        # count to write. `_budget` keeps a marker's width in reserve for it.
        self._left -= len(marker) + 5
        body = ", ".join(head + [marker])
        return f"{body} … {', '.join(tail)}" if tail else body

    def repr_list(self, x: Any, level: int) -> str:
        return self._repr_iterable(x, level, "[", "]", self.maxlist)

    def repr_tuple(self, x: Any, level: int) -> str:
        return self._repr_iterable(x, level, "(", ")", self.maxtuple, ",")

    def repr_deque(self, x: Any, level: int) -> str:
        return self._repr_iterable(x, level, "deque([", "])", self.maxdeque)

    def repr_set(self, x: Any, level: int) -> str:
        if not x:
            return self._charged("set()")
        return self._repr_iterable(x, level, "{", "}", self.maxset)

    def repr_frozenset(self, x: Any, level: int) -> str:
        if not x:
            return self._charged("frozenset()")
        return self._repr_iterable(x, level, "frozenset({", "})",
                                   self.maxfrozenset)

    def repr_dict(self, x: Any, level: int) -> str:
        n = len(x)
        if n == 0:
            return self._charged("{}")
        seen = self._cycle(x, "{", "}")
        if seen is not None:
            return seen
        if level <= 0:
            return self._charged("{…}")
        self._left -= 2
        cap = self._cap(level, self.maxdict)
        inner = level - 1
        self._active.add(id(x))
        try:
            tail = []
            # Four rather than two: a pair pays for the `, ` between entries
            # and the `: ` inside itself, and undercounting either is how a
            # dict lands over the wire limit and is cut a second time, losing
            # the tail this went to fetch. Taken from the far end inwards, for
            # the reason `_repr_iterable` gives.
            for key in reversed(_last(x, min(REPR_EDGE_ITEMS, n - 1,
                                             cap // 2))):
                if self._left <= 0:
                    break
                self._left -= 4
                tail.append(self._pair(key, x, inner))
            tail.reverse()
            head = []
            room = min(cap, n) - len(tail)
            for key in x:
                if len(head) >= room or self._left <= 0:
                    break
                self._left -= 4
                head.append(self._pair(key, x, inner))
        finally:
            self._active.discard(id(x))
        if len(head) + len(tail) >= n:
            return "{%s}" % ", ".join(head + tail)
        return "{%s}" % self._elided(head, tail, n)

    def _pair(self, key: Any, mapping: Any, level: int) -> str:
        return f"{self.repr1(key, level)}: {self.repr1(mapping[key], level)}"

    def repr_str(self, x: Any, level: int) -> str:
        return self._charged(self._cut(x, level, " chars"))

    def repr_bytes(self, x: Any, level: int) -> str:
        return self._charged(self._cut(x, level, " bytes"))

    def _cut(self, x: Any, level: int, noun: str) -> str:
        """A string or bytes kept whole, or its opening plus what it dropped.

        Sliced *before* it is repr'd, which is the entire point: ``repr()`` of
        a ten-megabyte string builds ten megabytes in order to keep eight
        thousand characters of it.

        A slice taken by length can still repr longer than the room it was cut
        to fit, because an escape is one character in the string and two or
        four in its repr -- fifty thousand newlines being the case that shows
        it. The second cut scales the slice by what the first one actually
        cost, which converges immediately and leaves the work bounded either
        way.
        """
        keep = min(self.maxstring if level == self.maxlevel
                   else REPR_NESTED_STRING_LIMIT,
                   max(self._left, _LEAST_ROOM))
        if len(x) <= keep:
            text = builtins.repr(x)
            if len(text) <= keep:
                return text
        text = builtins.repr(x[:keep])
        if len(text) > keep:
            keep = max(1, keep * keep // len(text))
            text = builtins.repr(x[:keep])
        if keep >= len(x):
            return text
        return f"{text} {_elision(len(x) - keep, noun)}"

    def repr_instance(self, x: Any, level: int) -> str:
        """Whatever the object itself says, kept as it said it.

        Deliberately not bounded by element count. A ``__repr__`` somebody
        wrote is a statement about how the object should read, and rewriting it
        would be the extension overruling the user's own code; the libraries
        where size is a real risk have all bounded themselves already, which is
        why a five-million-element ``ndarray`` reprs in ninety characters. What
        it *is* bounded by is what is left of the budget, so that one fat
        element cannot crowd out the structure it sits in.
        """
        try:
            text = builtins.repr(x)
        except Exception as exc:  # noqa: BLE001 - user code raises anything
            return self._charged(_repr_failed(x, exc))
        return self._charged(_capped(text, max(self._left, _LEAST_ROOM * 2)))


def safe_repr(value: Any, limit: int = WIRE_REPR_LIMIT) -> str:
    """``repr(value)``, built to fit and contained.

    Two guarantees, in this order. The value is rendered *to* ``limit`` rather
    than rendered and then cut down to it, so a large one costs what its
    annotation costs rather than what the whole object would have cost --
    ``_BoundedRepr`` has the argument. And a ``__repr__`` that raises is a bug
    in the user's code, not a reason for the kernel to die, which it otherwise
    would: it would take the whole session's namespace with it.

    ``_capped`` stays underneath as the transport guard it was always described
    as. It is now the last line of defence rather than the mechanism, and what
    reaches it is a ``__repr__`` somebody wrote that ran long, or a string
    whose escapes outgrew the slice it was cut to.
    """
    try:
        text = _BoundedRepr(limit).repr(value)
    except BaseException as exc:  # noqa: BLE001 - user code raises anything
        return _repr_failed(value, exc)
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


def _without_locals(name: str) -> str:
    """`outer.<locals>.inner` with the closure prefix dropped.

    That prefix records where a name was written rather than what it is
    called; only the tail is worth the width. Shared by `_readable_name`,
    which reads it off a function or class, and `_describe_iterator` below,
    which reads the same qualifier off a code object instead.
    """
    return name.rpartition("<locals>.")[2] or name


def _readable_name(obj: Any) -> Optional[str]:
    """``__qualname__`` without the closure noise, or ``__name__``, or None."""
    name = getattr(obj, "__qualname__", None) or getattr(obj, "__name__", None)
    if not isinstance(name, str) or not name:
        return None
    return _without_locals(name)


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


#: A generator, coroutine or async-generator *object* -- not the function
#: that produces one, which `_describe_callable` already names by way of
#: `_CALL_RESULTS`. Paired with the attribute that names the frame it is
#: running and the word `describe` should call it. Checked in order, though
#: the three tests are mutually exclusive.
_ITERATOR_KINDS = (
    (inspect.isasyncgen, "ag_code", "async generator"),
    (inspect.iscoroutine, "cr_code", "coroutine"),
    (inspect.isgenerator, "gi_code", "generator"),
)


def _describe_iterator(value: Any) -> Optional[str]:
    """``<generator greet_all>``, or None for anything that is not one of
    the three kinds `_ITERATOR_KINDS` lists.

    None of the three writes ``object.__repr__`` -- each carries its own,
    implemented in C -- so the test `describe` uses everywhere else,
    "does this still use the ``__repr__`` its base supplies", answers "no"
    for all three and would leave them alone as if a human had written that
    repr. Nobody did; it is still ``<generator object <genexpr> at
    0x...>`` underneath, address and all, which is exactly the shape this
    module exists to replace. This function runs first and catches them
    before that question is even asked.

    ``gi_code`` / ``cr_code`` / ``ag_code`` name the code the frame is
    running -- captured once, at creation, and read here the same way a
    function's own ``__name__`` is read to describe *it*. Reading an
    attribute off a generator cannot advance it; the sharp case this ticket
    is about is a generator consumed in order to be described, and this
    never iterates or resumes anything.
    """
    for test, attr, kind in _ITERATOR_KINDS:
        if not test(value):
            continue
        code = getattr(value, attr, None)
        name = getattr(code, "co_qualname", None) or getattr(code, "co_name",
                                                              None)
        if isinstance(name, str) and name:
            return f"<{kind} {_without_locals(name)}>"
        return f"<{kind}>"
    return None


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
    iterator = _describe_iterator(value)
    if iterator is not None:
        return iterator
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


#: Statement kinds where a module or a callable IS the value the line means to
#: report, rather than machinery the line happens to mention.
#:
#: `import os` and `from math import floor` exist to bind exactly those
#: things -- there is no other value an import could ever produce -- so the
#: rule that hides `<module 'os'>` beside a line that merely *names* `os` is
#: exactly backwards on the one line whose entire effect is creating it.
_BINDS_MODULES_AND_CALLABLES = ("Import", "ImportFrom")


def _worth_a_pair(value: Any, kind: str = "") -> bool:
    """Is this a value, or is it the machinery the line is written with?

    `print`, `type` and `isinstance` are noise beside the code that calls
    them, and so is `<module 'os'>` beside a line that happens to name `os`.
    Neither tells the reader anything about what just happened, and both cost
    the width that the values do use.

    A user's own function is skipped by the same rule. Its signature is worth
    showing when the `def` runs -- which is where the `def` already shows it --
    and not on every line that calls it afterwards.

    `kind` is `form.kind`, the statement this value was read for. An import is
    the exception to all of the above: `os` beside `import os, sys` is not the
    machinery the line is written with, it is the line's whole subject, and
    the rule cannot tell the two situations apart without being told which
    statement it is looking at.
    """
    if kind in _BINDS_MODULES_AND_CALLABLES:
        return True
    return not inspect.ismodule(value) and not callable(value)


def _named_values(
    namespace: Dict[str, Any], names: Iterable[str], limit: int = NAME_LIMIT,
    kind: str = ""
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

    A `limit` of zero is the off switch for `evalens.readNames`. Nothing is
    read: every name goes to the count, which is the honest thing for a line
    that was asked to report none of them to say.

    `kind` is `form.kind`, threaded through to `_worth_a_pair` unchanged: it is
    the one thing this function knows that the value alone does not say, and
    it is what lets an import report the module or function it just bound
    instead of having `_worth_a_pair` mistake it for the line's machinery.
    """
    pairs = []
    more = 0
    for name in names:
        if name not in namespace:
            continue
        value = namespace[name]
        if not _worth_a_pair(value, kind):
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

    A loop with no recorders subtracts nothing, which is the right answer for
    `evalens.loopValues` turned off as well as for the statement kinds that
    were never instrumented: with no sequence being painted there is nothing
    for the namespace reading to contradict, and suppressing it too would take
    away the last thing left that can say what the body bound.
    """
    if not recorders:
        return list(names)
    watched = recorders[0].bindings
    return [name for name in names if name not in watched]


def _instrumented(
    node: ast.stmt, head_limit: int = loops.HEAD_LIMIT
) -> tuple[ast.stmt, list]:
    """`node` rewritten to announce each iteration, plus its recorders.

    Only a loop is touched, and only the loop the user pointed at -- the
    rewrite descends into loops nested directly inside it, but never into a
    `def` or `class` in the body, whose loops run at a time this evaluation
    knows nothing about.

    Anything else comes back unchanged with no recorders, which is what makes
    the loop support cost the other statement kinds nothing at all.

    A `head_limit` of zero is the off switch for `evalens.loopValues`, and it
    turns the rewrite off rather than the display: an off switch that still
    instrumented the loop would stop showing the sequence and keep charging
    one `repr()` per iteration for it.
    """
    if head_limit <= 0 or not isinstance(node, (ast.For, ast.AsyncFor)):
        return node, []
    rewritten, plan = loops.instrument(node)
    return rewritten, loops.traces(
        plan, lambda value: safe_repr(value, loops.ITEM_LIMIT), head_limit)


#: What one request asks its annotations to look like. The kernel holds no
#: configuration of its own and deliberately learns none: a preference changed
#: between two keypresses has to apply to the second one, and a kernel that
#: remembered it would need restarting -- which throws away the namespace, the
#: one thing a session cannot get back.
_DEFAULT_LIMITS = {"loop_values": loops.HEAD_LIMIT, "names": NAME_LIMIT}


def _limits(request: Dict[str, Any]) -> Dict[str, int]:
    """The display limits on `request`, with this module's defaults behind them.

    Anything missing, non-integral or negative falls back to the default. A
    malformed limit must not be able to silence an annotation: a settings file
    with a typo in it would then look exactly like a broken extension, and the
    user has no reason to connect the two.
    """
    resolved = dict(_DEFAULT_LIMITS)
    given = request.get("limits")
    if not isinstance(given, dict):
        return resolved
    for key in resolved:
        value = given.get(key)
        # `isinstance(True, int)` is True, and a boolean here means the far
        # end sent a flag where a count belongs -- a bug worth ignoring rather
        # than reading as 0 or 1.
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            continue
        resolved[key] = value
    return resolved


def _capturing(node: ast.Assign) -> ast.Assign:
    """`node` with one more target, so the value it stores is kept.

    `acct.balance = 100` becomes `__evalens_assigned__ = acct.balance = 100`.
    Python evaluates a chained assignment's right-hand side **once** and then
    stores that one object into each target from left to right, so this keeps
    what the statement assigned without evaluating anything a second time.
    That is the whole point of it: reading `acct.balance` back afterwards
    calls a property getter the assignment never called, which is user code
    the extension decided to run rather than the user.

    Storing into a plain name runs nothing itself -- it is a dictionary write
    -- and it happens before the target's own store, so the value is kept even
    when a setter goes on to raise.

    A new node rather than a mutated one. The caller holds the user's parsed
    tree, and `loops.instrument` states the same rule for the same reason: a
    transformer that edits its input turns "evaluate this twice" into
    "instrument it twice".
    """
    capture = ast.copy_location(ast.Name(id=ASSIGNED, ctx=ast.Store()), node)
    rewritten = ast.copy_location(
        ast.Assign(targets=[capture, *node.targets], value=node.value), node)
    return ast.fix_missing_locations(rewritten)


class _Capture:
    """Somewhere for a captured assignment to put its value, briefly.

    The rewrite above stores through a name, so the name has to be in the
    namespace while the statement runs and gone once it has -- the discipline
    `loops.installed` keeps for the recorders, and for the same two reasons:
    the namespace is the user's and gets inspected, and a name that already
    existed is put back rather than destroyed.

    Not a `@contextlib.contextmanager`, again following `loops.installed`: an
    exception thrown into a generator-based manager propagates back out
    through `contextlib`'s frame and this module's, and the kernel goes to
    some trouble to keep its own frames out of the traceback the user reads.

    `value` stays `_NOTHING` unless the statement got as far as storing one,
    which is what tells "assigned None" from "raised before assigning".
    """

    __slots__ = ("_namespace", "_active", "_previous", "value")

    def __init__(self, namespace: Dict[str, Any], active: bool) -> None:
        self._namespace = namespace
        self._active = active
        self._previous: Any = _NOTHING
        self.value: Any = _NOTHING

    def __enter__(self) -> "_Capture":
        if self._active:
            self._previous = self._namespace.get(ASSIGNED, _NOTHING)
        return self

    def __exit__(self, *exc_info: Any) -> bool:
        if self._active:
            self.value = self._namespace.pop(ASSIGNED, _NOTHING)
            if self._previous is not _NOTHING:
                self._namespace[ASSIGNED] = self._previous
        return False


def _star_exports(namespace: Dict[str, Any]) -> list:
    """The names `import *` takes from a module, given the module's own dict.

    CPython's rule, which is worth stating because it is the whole of the
    answer: `__all__` when the module defines one, otherwise every key that
    does not begin with an underscore.

    Read out of `__dict__` rather than off the module, and that is the point
    of the function. `getattr(module, "__all__")` and `dir(module)` both go
    through attribute access, and a module may define `__getattr__` and
    `__dir__` of its own since PEP 562 -- so the obvious way to ask what an
    import brought in is a call into somebody's code, which is exactly the
    hazard the annotation must not be. A dictionary is a dictionary.
    """
    exported = namespace.get("__all__")
    if isinstance(exported, (list, tuple)):
        return [name for name in exported if isinstance(name, str)]
    return [name for name in namespace if not name.startswith("_")]


def _star_import(node: ast.stmt, limit: int = STAR_NAME_LIMIT) -> Optional[str]:
    """What `from x import *` brought in, as a phrase, or None.

    A star import has no display: it binds a set of names decided at runtime
    rather than one name the parser can find, and the resolver says so by
    answering `None` (before which it answered `"*"`, and the kernel compiled
    that as an expression and painted the SyntaxError). Painting nothing at
    all would be defensible and dull -- the line reads as though it did
    nothing -- so this says how many names it bound, and names them where
    there are few enough to name.

    Two other ways to find that out were rejected rather than not thought of.
    `dir()` before and after runs the module's own `__dir__` where it has one;
    diffing the namespace's keys is safe but says `3 names` the first time a
    line is evaluated and `0 names` the second, and an annotation that changes
    while the code has not is the thing `describe` exists to prevent. The
    module's own dictionary is stable across evaluations and cannot run
    anything, which leaves it the only source that is both.

    `type(...) is ModuleType` rather than `isinstance`: a lazy-loading stand-in
    parked in `sys.modules` can define `__getattribute__`, and then even
    reading `__dict__` off it is a call into user code. Those answer None and
    the line simply stays quiet.
    """
    if not isinstance(node, ast.ImportFrom) or node.level:
        # A relative star import needs `__package__` to resolve, which this
        # namespace has not got; it fails on its own terms before reaching
        # here, and if it ever stops failing, silence is the safe answer.
        return None
    if not any(alias.name == "*" for alias in node.names):
        return None
    module = sys.modules.get(node.module)
    if type(module) is not types.ModuleType:
        return None
    names = _star_exports(module.__dict__)
    if not names:
        return "no names"
    counted = f"{len(names)} name{'' if len(names) == 1 else 's'}"
    if len(names) > limit:
        # All of them or none of them, and never the first four of sixty:
        # those are wherever the module happened to define them rather than a
        # sample of anything, and a list that trails off invites the reader to
        # believe it is the important end of one.
        return counted
    return f"{counted}: {', '.join(names)}"


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


def _resolves_to_kernel_dir(entry: str) -> bool:
    """Does this ``sys.path`` entry name the kernel's own directory?

    Compared as a resolved path rather than as a string, because the same
    directory has several spellings on that list: ``''`` means the working
    directory, a relative entry is relative to it, and a symlinked checkout
    reaches the same files by two names.
    """
    try:
        return os.path.realpath(entry or os.getcwd()) == _KERNEL_DIR
    except (OSError, ValueError):
        return False


def _lives_in_kernel_dir(module: Any) -> bool:
    """Was this module loaded from a file in the kernel's own directory?

    Asked of the module rather than of a list of names, so that a third module
    added beside ``loops`` and ``resolver`` is covered by the same rule the day
    it lands instead of the day somebody remembers this function exists.
    """
    path = getattr(module, "__file__", None)
    return bool(path) and _resolves_to_kernel_dir(os.path.dirname(path))


def _seal_kernel_directory() -> None:
    """Put Evalens' own modules out of reach of the code it evaluates.

    Python gives a script's directory ``sys.path[0]``, and the script here is
    the kernel. Left alone, every file the user evaluates runs with the
    extension's internals first on the import path, so ``import resolver`` in
    their buffer finds ``kernel/resolver.py`` and *succeeds* -- with a module
    they have never seen, in place of the one sitting next to their file.
    Nothing about that looks like a failure, which is what makes it worth
    closing rather than documenting.

    Dropping the directory is not enough by itself. An import consults
    ``sys.modules`` before it consults the path, and ``loops`` and ``resolver``
    are already in there under exactly the names a user might pick. So both
    come out, and the module objects are held in `_SEALED_MODULES` instead:
    everything that already imported them keeps working through the references
    it holds, and user code asking for either name gets the
    ``ModuleNotFoundError`` it would get from any other interpreter.

    ``__main__`` stays, deliberately. It is this module, and unregistering it
    would break machinery that expects a program to have one -- multiprocessing
    spawning a worker, above all -- in order to shut a door narrower than the
    one this is about.

    Called from ``main`` rather than at import, because sealing is something a
    kernel *process* does. A test that imports this module for its functions
    should not find its own imports rearranged underneath it.
    """
    ours = [
        name for name, module in list(sys.modules.items())
        if name != "__main__" and _lives_in_kernel_dir(module)
    ]
    _SEALED_MODULES.extend(sys.modules.pop(name) for name in ours)
    sys.path[:] = [entry for entry in sys.path
                   if not _resolves_to_kernel_dir(entry)]


def _module_name(filename: str) -> str:
    """What Python would call this file's module.

    Python has two answers and the kernel used to give a third. A file you run
    is ``__main__``; a file you import is named after itself, so
    ``01_basics.py`` is ``01_basics``. ``__evalens__`` was neither, and being
    neither is what made it visible: it reached annotations as
    ``welcome(x: __evalens__.Named)`` where the source says ``Named``, and
    reprs as ``<__evalens__.Version object at 0x…>`` -- on the file whose
    lesson is what module names are. A student comparing the inline value
    against what ``python3 file.py`` prints found a module that exists nowhere
    in their program.

    The file's own name is the right one of the two, because Load File means
    *import this module* -- it is what the command has always claimed, and it
    is why an ``if __name__ == "__main__":`` block does not run on a load.
    Under this name the leaked text becomes ``01_basics.Named``, which is not a
    placeholder: it is exactly what importing that file produces. Naming the
    module ``__main__`` instead would have fixed the same two leaks and made
    every load run the guarded block -- code the author marked as "only when
    run directly", executed because someone asked to load a file. Running it
    deliberately is a separate command; see issue #78 run-file-as-script.

    ``__init__.py`` is named after its directory, because that is a package's
    name and the file is only how it opens. Anything with no name to take --
    the ``<evalens>`` placeholder a source with no path gets -- keeps
    ``__evalens__``, which is now the honest answer rather than the universal
    one: there is no module, so there is no name for it.
    """
    stem = os.path.splitext(os.path.basename(filename or ""))[0]
    if stem == "__init__":
        stem = os.path.basename(os.path.dirname(os.path.abspath(filename)))
    if not stem or stem.startswith("<"):
        return NO_MODULE_NAME
    return stem


def _script_directory(filename: str) -> Optional[str]:
    """The directory ``python3 <filename>`` would put at ``sys.path[0]``.

    ``None`` when the request does not name a file on disk -- ``<evalens>`` for
    a source with no path, or an unsaved buffer, whose name is a title rather
    than a location. Falling back to the working directory there would import
    from wherever the editor happened to be launched, which is nobody's intent
    and differs between two windows opened the same way.
    """
    if not filename or not os.path.isabs(filename):
        return None
    directory = os.path.dirname(os.path.abspath(filename))
    return directory if os.path.isdir(directory) else None


@contextlib.contextmanager
def _script_path(filename: str) -> Iterator[None]:
    """Run with the evaluated file's own directory first on ``sys.path``.

    This is the half of the import path the user is entitled to. ``python3
    myfile.py`` puts ``myfile.py``'s directory at ``sys.path[0]``, and that is
    how a file imports the package sitting beside it; the kernel is a different
    script in a different directory, so without this an ``import demo_pkg``
    fails with ``demo_pkg/`` in the same folder as the file being loaded, and
    every statement that names anything from it fails after it.

    Scoped to the request rather than left in place. One session evaluates many
    files, and a path that grows an entry per file makes each file's imports
    depend on which files happened to be opened before it -- the same
    accidental shadowing the kernel's own directory caused, only harder to see
    and unbounded. Between requests ``sys.path`` is what the interpreter
    started with.

    The entry is removed by identity rather than by value or position. User
    code may add to ``sys.path`` while it runs and is entitled to keep what it
    added; deleting index 0 would take theirs, and removing by equality would
    take a duplicate they inserted deliberately.
    """
    directory = _script_directory(filename)
    if directory is None:
        yield
        return
    sys.path.insert(0, directory)
    try:
        yield
    finally:
        for index, entry in enumerate(sys.path):
            if entry is directory:
                del sys.path[index]
                break


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


def _syntax_wire(exc: SyntaxError) -> Dict[str, Any]:
    """A `SyntaxError` as the wire's error object.

    No traceback frames: nothing ran, so the stack would be this module's own
    and would describe the extension rather than the file.
    """
    return {
        "type": "SyntaxError",
        "message": exc.msg or str(exc),
        "traceback": "".join(traceback.format_exception_only(type(exc), exc)),
    }


def _syntax_position(exc: SyntaxError) -> Dict[str, Dict[str, int]]:
    """Where the break is, so the report lands on the line that caused it.

    This is the half of the complaint that costs the most: a break on line 19
    used to be answered as a failure of whatever line the cursor was on, which
    sends the reader to the wrong end of the file with a message about a line
    they were not looking at.
    """
    line = (exc.lineno or 1) - 1
    character = max((exc.offset or 1) - 1, 0)
    return {
        "start": _position(line, character),
        "end": _position(line, character),
    }


def _partial_of(parsed: Parsed) -> Dict[str, Any]:
    """The `partial` field: what the answer was computed without, and why.

    Present only when the file did not parse whole. Its absence is the claim
    that nothing was left out, which is why this is a field that appears rather
    than a flag that is always there saying `false` -- a reader of the wire
    cannot mistake "full context" for "nobody filled this in".
    """
    return {
        "truncated_at": parsed.truncated_at,
        "error": _syntax_wire(parsed.error),
        "range": _syntax_position(parsed.error),
    }


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
            # Replaced per request by `_as_module`, which knows which file is
            # being evaluated and can therefore say what the module is called.
            # This is what an empty session is called before anything has been
            # evaluated into it.
            {"__name__": NO_MODULE_NAME, "__builtins__": __builtins__}
        )

    @contextlib.contextmanager
    def _as_module(self, filename: str) -> Iterator[None]:
        """Set the namespace up the way Python sets a module up.

        Two things, and they are the same thing: the module's name, and the
        import path a module of that name would have. Both were the kernel's
        rather than the user's, and each was visible in the buffer -- a local
        import that could not resolve, and a module name that appeared in
        annotations and reprs while appearing nowhere in the source.

        Per request rather than per session, because a session evaluates
        whichever file the cursor is in and the answer is a property of that
        file. The name is set and left: nothing between requests reads it, and
        the next evaluation says what it is again. The path is scoped, for the
        reasons in `_script_path`.

        `__file__` is the third thing Python sets and is deliberately not here;
        it is a promise about the namespace with its own consequences and its
        own ticket.
        """
        self.namespace["__name__"] = _module_name(filename)
        with _script_path(filename):
            yield

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
        """Run the statement under the cursor and report what it produced.

        Two things happen here when the file does not parse whole, and they
        pull in opposite directions on purpose.

        **A break below the cursor does not stop the cursor's line.** The
        answer comes from the part of the file that parses, and says so:
        `partial` travels with it, so a value computed without the file's full
        context is never mistaken for one computed with it.

        **A break at or above the cursor is the answer.** The fallback
        truncates from the end, so a prefix that stops short of the cursor
        cannot contain the statement the user pointed at -- and a broken
        statement where you are pointing is a real answer rather than an
        obstacle. Either way the report carries the break's own position, so
        the reader is sent to the line that caused it.
        """
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
            parsed = parse_prefix(source, filename=filename)
        except SyntaxError as exc:
            return self._syntax_error(exc)

        if parsed.truncated_at is not None and parsed.truncated_at <= line:
            return self._syntax_error(parsed.error)

        partial = {} if parsed.truncated_at is None else {
            "partial": _partial_of(parsed)}

        form = form_at(parsed.tree, line, character)
        if form is None:
            # A cursor on a blank line. Not an error, and deliberately not a
            # fallback to the nearest statement: that would run code the user
            # did not point at. The break still travels, because the user
            # pressed a key and the file being broken is worth knowing.
            return {"ok": True, "resolved": False, **partial}

        # A single evaluation may prompt: someone pressed a key and is
        # sitting in front of the editor waiting for this line to answer.
        #
        # As the file's own module, so that a line the user points at imports
        # and names what the same line would under `python3 file.py`.
        with self._as_module(filename):
            outcome = self._run(form, filename,
                                allow_stdin=bool(request.get("allow_stdin")),
                                limits=_limits(request))
        outcome.update(partial)
        return outcome

    def evaluate_file(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """Run a module body, reporting what each statement produced.

        This is Calva's Load File. Its Clojure form is safe because a
        namespace is almost all definitions; a Python module body genuinely
        runs, so the translation matters.

        The faithful one is already right. "Load the namespace" in Python
        means *import the module*, and an imported module does not run its
        ``if __name__ == "__main__":`` block. ``__name__`` here is the file's
        own name -- ``10_concurrency`` for ``10_concurrency.py``, which is
        precisely what an import gives it -- so that guard is False without
        anything special being done about it, and for the reason Python has
        rather than an invented one. ``test_kernel`` pins it, because a load
        that ran the guarded block would be this command running code the user
        did not point at, on every press, and it would look like success.

        A file whose whole program is inside that guard therefore loads and
        runs none of it, which is correct and is also not what its reader
        wants. Running it is a separate, explicit command rather than a thing
        a load starts doing; see issue #78 run-file-as-script.

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

        A line that does not *parse* is the same argument one step earlier, and
        gets the same answer: load what parses, report the rest. Refusing the
        whole file over a half-typed line at the bottom is how the command that
        sets up a session comes to need the session already set up.

        **Parse first, then narrow inside what parsed**, when both apply. The
        order is forced rather than preferred: narrowing snaps outward to
        statement boundaries, boundaries only exist inside a tree, and for a
        broken file ``parse_prefix`` is the only thing that produces one. The
        two facts that fall out are reported separately because they are
        separate -- ``range`` is what ran, ``partial.truncated_at`` is where
        parsing stopped, and neither can be computed from the other.

        The consequence worth stating is the empty one. A selection lying
        entirely below the break intersects nothing in the prefix, so it runs
        *nothing*; it does not quietly run the prefix instead. Running code the
        user did not select is the failure both the narrowing and the fallback
        exist to prevent, and it is the more tempting mistake here precisely
        because there is something runnable sitting right there. ``partial``
        still travels, so the answer is "the selection is below the line the
        file stops parsing at" rather than a bare count of zero.

        **Every outcome is announced as it happens**, on the control channel,
        and only then collected. A load is sequential in here and used to be
        atomic on screen: a file that blocks on ``input()`` at line 47 had run
        lines 1-46, had their values in hand, and had said nothing about any of
        them -- so the reader was asked to type a value into a program whose
        behaviour so far was invisible.

        The frames go on the control channel rather than the request channel
        for the reason that channel exists. A response settles a request and
        nothing else is ever written where a response is written; putting a
        not-yet-a-response there would mean telling the two apart by inspecting
        them, which is precisely the rule the split removed. The control
        channel is also the one already proven under the condition that matters
        -- a ``stream`` frame reaches the extension *while* a statement runs,
        through a thread the running statement cannot block.

        Each frame carries the request's ``id`` and the statement's ``index``
        in file order, and its ``outcome`` is the same dict that goes into
        ``results`` rather than a summary of it. The index is what makes the
        reader able to refuse: a consumer that painted on arrival order alone
        would silently shift every annotation by one if a frame were ever lost,
        and shifted annotations are the failure this project treats as worse
        than showing nothing.

        ``results`` stays complete and stays authoritative. The frames are the
        same outcomes arriving earlier, so a caller with no control channel --
        or one that does not care to paint progressively -- reads the response
        and gets everything, exactly as before.
        """
        source: str = request.get("source", "")
        filename: str = request.get("filename") or "<evalens>"
        allow_stdin = bool(request.get("allow_stdin"))
        # The id the response will carry, so a frame can say which load it
        # belongs to. Without it, a frame that lost the race between two pipes
        # could be read as belonging to the load that started next.
        request_id = request.get("id")

        linecache.cache[filename] = (
            len(source), None, source.splitlines(keepends=True), filename,
        )

        try:
            parsed = parse_prefix(source, filename=filename)
        except SyntaxError as exc:
            return self._syntax_error(exc)

        partial = {} if parsed.truncated_at is None else {
            "partial": _partial_of(parsed)}

        # The narrowing runs against the tree that parsed, never against the
        # source. A selection below `truncated_at` therefore intersects nothing
        # and yields no forms, which is the whole point: the empty list is the
        # refusal, and it arrives without a special case for it.
        selection = _selected_lines(request)
        forms = forms_in(parsed.tree, selection)

        results = []
        ran = 0
        # Resolved once for the whole load rather than per statement: every
        # statement in one request is answering the same keypress, so they had
        # better be shown on the same terms.
        limits = _limits(request)
        # Once for the whole load rather than once per statement: the imports
        # at the top of a file and the function bodies further down that import
        # lazily are the same file, and get the same name and the same path.
        with self._as_module(filename):
            for index, form in enumerate(forms):
                # Prompts if the caller allowed it, exactly as a single
                # evaluation does. The flag is the caller's decision either
                # way; nothing about running many statements makes the person
                # watching them go away.
                outcome = self._run(form, filename, allow_stdin=allow_stdin,
                                    limits=limits)
                results.append(outcome)
                # Announced immediately after it is collected, so the two can
                # never disagree about what happened, and in the loop rather
                # than after it, so the reader sees line 46 settle before line
                # 47 stops to ask them something. Written by this thread while
                # it holds the lock `control` takes, so the frames leave in
                # file order and reach one reader on one pipe in that order.
                control({
                    "op": "statement",
                    "id": request_id,
                    "index": index,
                    "outcome": outcome,
                })
                if outcome["ok"]:
                    ran += 1
                elif _was_interrupted(outcome):
                    # Cancel means stop. Failures do not otherwise end a load
                    # -- that is the point of the paragraph above -- but an
                    # interrupt is not the file being broken, it is the user
                    # asking for the load to end, and carrying on into the next
                    # statement would answer a request to stop by running more
                    # of their code.
                    break

        response: Dict[str, Any] = {
            "ok": True,
            "statements": len(forms),
            "ran": ran,
            # The whole of it, still, and not a summary of what was already
            # announced. A frame and its entry here are the same object, so a
            # consumer that saw every frame learns nothing new from this and a
            # consumer that saw none is not missing anything.
            "results": results,
            **partial,
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
             allow_stdin: bool = False,
             limits: Optional[Dict[str, int]] = None) -> Dict[str, Any]:
        limits = _DEFAULT_LIMITS if limits is None else limits
        node, recorders = _instrumented(form.node, limits["loop_values"])
        if form.captured:
            # An assignment to an attribute or a subscript. The value has to
            # come from the statement, because the only other way to it is
            # through the user's own getter. See `_capturing`.
            node = _capturing(node)
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
                        with _Capture(self.namespace, form.captured) as kept:
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
                        # This branch is first, and that ordering is the whole
                        # of the kernel's half of the loop question. The
                        # resolver says a bare-name target *may* be read back,
                        # because looking a name up is a dictionary lookup;
                        # whether it is worth reading is dynamic and only this
                        # frame knows the answer, because only this frame
                        # knows whether the rewrite went in. It did, so the
                        # trace is the answer and nothing is read.
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
                    elif kept.value is not _NOTHING:
                        # What the assignment stored, taken as it stored it.
                        # `acct.balance` is never read: the annotation reports
                        # the value the line put there, which it can do
                        # without asking the object anything.
                        shown, raw_repr = wire_value(kept.value)
                    elif form.readable:
                        # A bare name, or a tuple of them, which the resolver
                        # has already vouched for: evaluating one is a
                        # dictionary lookup and cannot run user code. Every
                        # other display either arrives with its value already
                        # in hand or is not shown at all -- see
                        # `resolver._value_source`, and #68 for what this
                        # branch did when it took anything it was given.
                        #
                        # Reaching here from a loop means `evalens.loopValues`
                        # is off, and then this is the only thing left that
                        # can say what the line did. `for p in []:` is the one
                        # shape where even that has nothing: no iteration ran,
                        # so `p` was never bound, and the lookup raised the
                        # extension's own NameError in red beside a loop that
                        # had worked. Nothing bound is nothing to say, which
                        # is what `count: int` already answers.
                        shown, raw_repr = self._read_back(form, filename)
                    else:
                        # A star import is the one statement with no display
                        # that still has something to say, and what it says
                        # comes from the module it pulled from rather than
                        # from anything on the line. Everything else here
                        # answers None and paints nothing, as before.
                        shown = _star_import(form.node)

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
                #
                # Which names to leave out and how many to keep are separate
                # questions and stay separate calls: the first is about not
                # contradicting the sequence beside it, the second is how much
                # of a line the reader is willing to spend. `limits["names"]`
                # of zero is `evalens.readNames` turned off, and what the cap
                # leaves out is counted rather than dropped in silence.
                names, more_names = _named_values(
                    self.namespace, _unwatched(form.names, recorders),
                    limits["names"], kind=form.kind)
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

    def _read_back(self, form: Form,
                   filename: str) -> Tuple[Optional[str], Optional[str]]:
        """`form.display` looked up in the namespace, or nothing if unbound.

        Only ever called for a display the resolver marked readable, which is
        a bare name or a tuple of bare names. That is what makes the narrow
        `except` honest as well as safe: a name lookup has exactly one way to
        fail, so catching `NameError` here cannot swallow anything else, and
        the one thing it does catch means the statement bound nothing.

        `for p in []:` is the shape that needs it, and only with
        `evalens.loopValues` off -- an instrumented loop answers from its
        recorders and never arrives here. Nothing ran, so nothing is claimed;
        painting `NameError: name 'p' is not defined` beside a loop that
        completed is the extension reporting its own failure as the user's.

        **The known gap, named rather than papered over.** That covers a loop
        that ran zero times over a name nothing had bound. If the name *was*
        bound before -- `q = 5` and then `for q in []:` -- there is no way to
        tell "the loop bound this" from "something earlier did", and the line
        reports `q: 5`, which the statement did not produce. Every way of
        closing it costs more than it saves: instrumenting the loop is what
        `evalens.loopValues` off exists not to do, sentinel-marking the target
        makes `for q in f(q):` see the sentinel, and comparing identity
        answers by whether CPython happened to intern the value. It needs
        all three of an off switch nobody has on by default, an empty
        sequence, and a name already bound; the default reports
        `(no iterations)` correctly, because there the recorders counted.
        """
        expression = ast.Expression(ast.parse(form.display, mode="eval").body)
        code = compile(expression, filename, "eval", dont_inherit=True)
        try:
            value = eval(code, self.namespace)  # noqa: S307
        except NameError:
            return None, None
        return wire_value(value)

    @staticmethod
    def _syntax_error(exc: SyntaxError) -> Dict[str, Any]:
        return {
            "ok": False,
            "error": _syntax_wire(exc),
            "range": _syntax_position(exc),
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
    # Before anything is evaluated, and only once: from here on the import
    # path belongs to the user's file, not to the extension.
    _seal_kernel_directory()
    control_in, _CONTROL_OUT = _open_control(sys.argv)
    if control_in is not None:
        threading.Thread(target=_control_loop, args=(control_in,),
                         name="evalens-control", daemon=True).start()
    # Before a single line of user code can run, and never undone. A thread
    # someone starts on line 4 is still printing on line 40, and the only
    # redirection that catches it is one with no end.
    _install_user_streams()

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
