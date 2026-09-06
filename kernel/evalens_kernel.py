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

``is_binding`` says whether ``display`` names a place this statement bound --
an assignment target, a loop variable, a ``with ... as``, the name a ``def``
or ``import`` introduces -- rather than the value of a bare expression
statement. Present only when true, the same as ``loop``'s own ``constant``::

    -> {"id":4,"op":"eval","source":"led = {}\\nled['a'] = 1\\n","line":1,...}
    <- {"id":4,...,"display":"led['a']","value":"1","is_binding":true}

Nothing about ``display``'s own text says this -- ``led['a']`` is no more and
no less a binding than ``x`` is for ``x = 1``, and a consumer that infers the
answer from whether ``display`` looks like a bare or dotted identifier gets
this one wrong (#81). ``resolver.Form.is_binding`` decides it from the
statement, not from the string.

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

A value or a named pair may carry ``table``, a bounded description of it for
the shapes #24 covers -- a ``pandas.DataFrame``, or a ``list``/``tuple`` of
dicts with consistent keys, of ``namedtuple`` s, or of same-length
lists/tuples -- and nothing else. It travels beside ``value``/``repr``
exactly as they do, computed from the identical value at the identical
moment, never by asking the namespace again later::

    <- {..., "display":"df", "value":"   a  b\\n0  1  4\\n1  2  5\\n2  3  6",
        "table":{"kind":"dataframe","columns":["a","b"],
                 "rows":[["1","4"],["2","5"],["3","6"]],
                 "row_count":3,"shown_rows":3,"col_count":2,"shown_cols":2}}

``row_count``/``col_count`` are the value's real totals, cheap to ask for
even on a huge frame or list -- ``len()`` and ``DataFrame.shape`` are both
O(1). ``shown_rows``/``shown_cols`` are how many of them made it into
``rows``/``columns``, bounded to a head-and-tail sample (see
``tabular.HEAD_ROWS``/``TAIL_ROWS``/``MAX_COLUMNS``) so a million-row frame
is never walked; ``more_rows``/``more_cols`` say how many were left out, on
the same terms ``more_names`` does, and are absent when nothing was. Absent
entirely for anything that does not duck-type as one of the shapes above --
which is every value today, since none of this changes what ``value`` or
``repr`` say. See ``tabular.describe`` for the detection rules and why they
stop where they do.

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

``eval_file`` may also carry ``as_script: true``, which runs the file the way
``python3 <file>`` would rather than the way ``import`` would::

    -> {"id":5,"op":"eval_file","source":"...","as_script":true,
        "filename":"/abs/path.py","allow_stdin":true}

``__name__`` is ``"__main__"`` for that request instead of the file's own
name, so an ``if __name__ == "__main__":`` guard fires and its body runs;
``sys.argv`` is ``[filename]`` for the same reason a real script run gives it
that. Everything else is unchanged: the whole buffer runs top to bottom, into
the same persistent namespace a load would use, and a second script run -- or
a script run after an ordinary load -- simply runs the file again, exactly as
pressing Load File twice does. There is no reset and no second namespace,
because the one this kernel already keeps is the thing a session cannot get
back. See ``Kernel._as_module`` and issue #78.

A script run's own functions still cannot cross into a ``multiprocessing``
worker -- issue #80, investigated and left as a known limitation rather than
fixed. ``sys.modules["__main__"]`` during the run is still this kernel
module, never the user's, so a worker looking a pickled function up there
misses it exactly as one would looking it up in any other process that is
not the one holding the namespace. Registering the run's own namespace under
that key was spiked and found not to help the platform this project targets:
it works under ``fork``, because a forked worker is the parent's whole
memory and inherits the registration for free, but macOS has defaulted to
``spawn`` since Python 3.8, and a worker started that way is a fresh
interpreter that inherits nothing -- it can only rebuild the function by
re-importing a real file from disk, which this kernel does not set
(``__file__`` is deliberately absent from a script run's namespace) and
which, even given one, would silently run whatever is saved on disk rather
than the buffer this run actually evaluated the moment the two disagree.
Jupyter and IPython hit the identical wall for the identical reason. See
`RunFileAsScript` in ``test_kernel.py`` for what is pinned instead of
fixed.

``outline`` answers with the same ranges and anchors for every top-level
statement in a file, and runs none of them::

    -> {"id":4,"op":"outline","source":"...","filename":"/abs/path.py"}
    <- {"id":4,"ok":true,"statements":[
        {"kind":"Assign","range":{...}},
        {"kind":"FunctionDef","anchor":3,"range":{...}}]}

It exists so that Evaluate and Advance can step by statements rather than by
lines without a second parser on the extension side -- and it is a separate op
precisely so that asking where the next statement is cannot run anything.

``inspect`` answers with one level of a value's children -- for the object
explorer (#23) -- addressed by a namespace name and a path of safe accesses,
never by an expression to re-evaluate::

    -> {"id":6,"op":"inspect","name":"user","path":[]}
    <- {"id":6,"ok":true,"type":"User","value":"<User instance>",
        "children":[
          {"name":"name","kind":"attr","type":"str","value":"'Jane Smith'",
           "expandable":false,"step":{"kind":"attr","name":"name"}},
          {"name":"email","kind":"property","type":"property","value":null,
           "expandable":false,"evaluated":false}],
        "count":2,"truncated":false}

``name`` has to already be a key in the namespace -- the same lookup a bare
name's own display already trusted (#68) -- and each entry in ``path`` is
handed back verbatim in an earlier response's ``children[].step``, never
built by the caller from a key or index it invented. A ``property`` row
carries no ``step`` and is never expandable, because reading one would run
its getter, which is exactly what design rule 3 forbids. See the module note
above ``INSPECT_CHILD_LIMIT`` for the whole of how the walk stays safe and
bounded.

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

``eval_above`` runs everything strictly above the top-level statement a
0-based cursor ``line`` is in, so that a line further down can be evaluated
against the state the rest of the file would have given it::

    -> {"id":6,"op":"eval_above","source":"a = 1\\nb = 2\\nc = a + b\\n",
        "line":2,"filename":"/abs/path.py","allow_stdin":true}
    <- {"id":6,"ok":true,"statements":2,"ran":2,"results":[...],
        "range":{"start":{"line":0,...},"end":{"line":1,...}}}

The boundary is the first top-level statement, in file order, whose own last
line reaches ``line`` -- the statement the cursor sits in, or would sit in.
Everything before it runs; that statement itself never does, because it is
what ``eval`` answers for, not this op. A cursor at or before the first
statement finds it as the boundary and runs nothing; a cursor past the last
statement, or beneath a break ``parse_prefix`` cut the tree around, matches
no boundary at all, so every parsed form counts as "above" and ``partial``
says what was left out, the same way a broken file answers ``eval_file``.

The namespace is reset before anything runs, unconditionally and with no
setting to skip it -- unlike ``eval_file``, which never resets. A partial
run's whole value is that the namespace afterward matches what running the
file from the top through the cursor would have produced, which a stale
binding from an earlier keypress would quietly falsify.

Failures stop the run, which is the one place this differs from
``eval_file``'s own loop: a load runs through a broken line on purpose, but
``eval_above`` is building a namespace on the way to a specific line, and a
namespace built past a failure is one nobody can reason about. ``results``
holds only the outcomes actually attempted -- through the failure, if there
was one -- so a caller cannot assume ``ran + failed`` equals ``statements``
here the way it can for ``eval_file``.

Ops: ``ping``, ``reset``, ``eval``, ``eval_file``, ``eval_above``,
``outline``.

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

Not asking, when an answer is already known
--------------------------------------------
A statement that prompts twenty times in a row for the same twenty answers is
the exact friction #86 exists to remove. Before ``_AskingStdin`` asks anyone
anything, it checks for a canned answer, in this order:

1. A ``# evalens: ...`` comment on the *statement's own last line*. Never
   evaluated -- the text after the marker is split into literal values by a
   small hand-written parser, the same way a CSV cell is, and nothing about it
   ever reaches ``eval`` or ``ast.literal_eval``. A comment that happened to
   read ``__import__("os").system(...)`` is exactly as inert as one that
   reads ``Ada``.
2. Failing that, whatever this exact statement's *previous* run was given, in
   ``_REPLAY_ANSWERS``. Keyed by ``ast.unparse(form.node)`` rather than by
   line number, so inserting a line above an ``input()`` does not shift a
   stored answer onto a different prompt -- and a statement that now reads
   differently starts asking again, because it is a different key. Cleared by
   ``reset`` and by the dedicated ``clear_input_replay`` op; never invented
   for a fresh kernel, which starts with no answers to forget.

``a, b = input(), input()`` makes two reads on one statement, and a comment or
a replay answers them by position -- the first value for the first read, the
second for the second. Once a comment's list of values runs out, the calls
after it are **not** given the last value again; they fall through to replay
and then to actually asking, because feeding one typed answer to two reads
silently would be answering a question nobody was asked.

Whichever source supplies it, the value reaches ``readline()`` exactly the
way a typed answer does: put on ``_INPUT_REPLIES`` and taken back off it by
the one loop below that turns a reply into what ``input()``, ``readline()``
and ``read()`` return. There is no second implementation of that -- a canned
answer is a reply that arrived before anyone had to type it, not a different
kind of value.

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
import __future__ as _future
import ast
import builtins
import collections
import contextlib
import functools
import inspect
import io
import itertools
import json
import linecache
import os
import operator
import queue
import re
import reprlib
import signal
import sys
import threading
import tokenize
import traceback
import types
from typing import (
    Any, Dict, Iterable, Iterator, List, Optional, TextIO, Tuple, Union,
)

import loops
import passive
import tabular
from capture import OutputCapture
from resolver import Form, Parsed, form_at, forms_in, parse_prefix, utf8_column

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

#: This module's own source files, resolved once, so `_error` can tell one of
#: its frames from the user's. `resolver` never runs on the stack a user's
#: code passes through -- it only parses -- so it does not need to be here;
#: `loops` and this file both do. See `_error` for why a frame from either can
#: legitimately end up in a user's traceback.
_KERNEL_FILES = frozenset(
    os.path.abspath(path) for path in (loops.__file__, __file__) if path)

#: `__name__` for a source that names no file at all -- an unsaved buffer, or
#: a request that sent none. Every file gets its own name instead; see
#: `_module_name`. Kept as a dunder because it is a module name and reads like
#: one wherever it does surface, and kept as this one because it is what
#: Evalens has always called the namespace it has no better name for.
NO_MODULE_NAME = "__evalens__"

#: What `Kernel.reset` puts in an empty namespace, and therefore never
#: residue -- see `evaluate_file`'s residue computation for #100. Read from
#: here rather than repeated at each call site so the two cannot drift.
_KERNEL_OWNED_NAMES = frozenset({"__name__", "__package__", "__builtins__"})

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

#: Hard cap on how many `name: value` pairs one line's response may carry over
#: the wire. This used to double as the display cap, and #85 is the record of
#: why that was wrong: the kernel does not know which of these names the
#: reader has already seen painted above, so a cap enforced here can only
#: choose by position -- keep whichever names came first and drop the rest --
#: and position is exactly the wrong rule. A name reassigned inside a function
#: and never seen again until it is read back on a later line is the one
#: worth painting, and a position-based cap drops it precisely when it
#: differs from four names the reader has already seen.
#:
#: So this is a transport guard now, answering the same question
#: `WIRE_REPR_LIMIT` answers for one value rather than the question
#: `evalens.readNamesPerLine` answers: generous enough that an ordinary line
#: never reaches it, and only there so one response cannot grow without
#: bound. How many of the names that arrive are actually painted is decided
#: afterwards, by the renderer, once repeat suppression has told it which of
#: them are new -- see `PaintedAbove` in `src/render/repeats.ts`.
NAME_LIMIT = 64

#: How many names a star import may name before it settles for counting them.
#: Its own number, not tied to `NAME_LIMIT` -- the two only ever shared a
#: starting value of four by coincidence, and `NAME_LIMIT` becoming a
#: generous transport bound is not a reason to widen this one too: `from
#: math import *` binds sixty, and there is no reader waiting to see a list
#: that long named in full.
#:
#: `STAR_NAME_LIMIT` is a threshold between two different annotations, not a
#: cap in `NAME_LIMIT`'s sense: under it the line names every name; over it
#: the line says `20 names` and no more, because the first four of sixty are
#: wherever the module happened to define them rather than a sample of
#: anything. There is no setting to be had in between, and a number in the
#: settings UI that flips the annotation's whole shape at some value would
#: read as a cap and behave as something else.
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

#: A statement's own typed answers, replayed the next time it runs -- see the
#: module docstring's "Not asking, when an answer is already known". Keyed by
#: `_replay_key`, one list per statement, each entry the answer its `input()`
#: call at that position got. Comment-supplied answers are never written here:
#: the comment already wins every time, and a copy of it would just be a
#: second place for the same value to go stale.
#:
#: Unbounded and never pruned. A session that runs thousands of distinct
#: prompting statements without ever resetting is not a case this feature
#: optimises for, and pruning by guesswork is how a still-wanted answer gets
#: discarded instead.
# Password positions are holes, never answers. The indices still align when
# ordinary and password reads occur in the same statement.
_REPLAY_ANSWERS: Dict[str, List[Optional[str]]] = {}


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
      response carries a bounded prefix and explicit omission count, while
      the complete frame is attributed to the
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
        self._captured: Optional[OutputCapture] = None

    def capture(self, buffer: Optional[OutputCapture]) -> Optional[OutputCapture]:
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
        return captured.tail()


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

    def __init__(self, out: "_UserStream", err: "_UserStream",
                 comment: Optional[Tuple[str, ...]] = None,
                 replay_key: Optional[str] = None) -> None:
        self._out = out
        self._err = err
        #: Values a `# evalens: ...` comment on this statement supplied, one
        #: per `input()` call in order; None when there is no such comment.
        #: See `_comment_answers`.
        self._comment = comment
        #: This statement's identity in `_REPLAY_ANSWERS`, or None when it has
        #: none -- an outline or another caller that never had a `Form` to
        #: give `_user_io`. See `_replay_key`.
        self._replay_key = replay_key
        #: Which `input()` call on this statement is next: 0, 1, 2, ... A
        #: fresh object per statement (see `_user_io`), so this never needs
        #: resetting between statements the way a module global would.
        self._call = 0
        #: What every read on this object answered, and where the answer came
        #: from -- `_run` reads this back to fill the outcome's `stdin` field.
        self.log: List[Dict[str, str]] = []
        self._buffer = io.StringIO()
        self._eof = False

    def readable(self) -> bool:
        return True

    def isatty(self) -> bool:
        # Truthfully. Code that asks is usually deciding whether a human is
        # there, and answering yes would invite the terminal handling this
        # object cannot provide.
        return False

    def readline(self, size: int = -1) -> str:
        """Consume up to one line or `size` characters, preserving the rest."""
        self._checkClosed()
        size = -1 if size is None else operator.index(size)
        if size == 0:
            return ""
        line = self._buffer.readline(size)
        if line or self._eof:
            return line
        answer = self._receive_line()
        if not answer:
            self._eof = True
            return ""
        self._buffer = io.StringIO(answer)
        return self._buffer.readline(size)

    def _receive_line(self) -> str:
        """Ask for one line, and block until it arrives.

        Blocking is correct and is what a REPL does. It is also why this
        feature could not ship without a way to interrupt: while this waits,
        a prompt the user dismissed and a genuinely hung kernel look identical
        from the outside.

        Before asking anyone, this checks for an answer that is already
        known -- a `# evalens:` comment on the statement's own line, or the
        answer this same statement was given last time it ran. See the module
        docstring's "Not asking, when an answer is already known". Either way
        the value is put on `_INPUT_REPLIES` and taken back off it by the loop
        below, exactly like a typed answer -- so a canned reply is never a
        second implementation of what this method returns, only an earlier
        arrival for the one implementation there is.
        """
        if _CONTROL_OUT is None or not _ALLOW_STDIN:
            # No channel to ask on, or a caller that said not to ask. Empty is
            # what `input()` turns into EOFError, which is the behaviour this
            # had before there was anywhere to ask, kept deliberately.
            raise EOFError(_no_input_message())
        global _INPUT_SEQ
        _INPUT_SEQ += 1
        wanted = _INPUT_SEQ
        index, self._call = self._call, self._call + 1
        password = _reading_a_password()

        source: Optional[str] = None
        canned: Optional[str] = None
        if (not password and self._comment is not None
                and index < len(self._comment)):
            canned, source = self._comment[index], "comment"
        elif not password and self._replay_key is not None:
            stored = _REPLAY_ANSWERS.get(self._replay_key)
            if stored is not None and index < len(stored):
                canned = stored[index]
                source = "replay" if canned is not None else None

        if canned is None:
            # The prompt is whatever user code has written and not
            # terminated: stdout for `input()`, stderr for the one thing that
            # prompts there.
            prompt = self._out.tail() or self._err.tail()
            control({
                "op": "input_request",
                "seq": wanted,
                "prompt": _capped(prompt, PROMPT_LIMIT),
                "password": password,
                # Which line is asking. The extension marks and reveals it, so
                # a prompt from a statement scrolled off screen brings the
                # reader to it rather than opening a box about code they
                # cannot see.
                **(_RUNNING_AT or {}),
            })
        else:
            # Delivered through the same queue an extension's `input_reply`
            # uses, and read back by the same loop just below -- see the
            # docstring above for why that is the whole point.
            _INPUT_REPLIES.put((wanted, canned))

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
            break

        if source is None:
            # A real, typed answer -- worth remembering in case this exact
            # statement (see `_replay_key`) runs again before the value does.
            # A comment-supplied answer is never stored here; the comment
            # already wins every time, so a copy of it would only be a second
            # place for the same value to go stale.
            source = "typed"
            if not password and self._replay_key is not None:
                answers = _REPLAY_ANSWERS.setdefault(self._replay_key, [])
                while len(answers) <= index:
                    answers.append(None)
                answers[index] = value
        if not password:
            self.log.append({"value": value, "source": source})
        return value if value.endswith("\n") else value + "\n"

    def read(self, size: int = -1) -> str:
        """Read `size` characters, or ask until EOF for an unsized read."""
        self._checkClosed()
        size = -1 if size is None else operator.index(size)
        chunks = []
        remaining = size
        while remaining != 0:
            line = self.readline(remaining)
            if not line:
                break
            chunks.append(line)
            if remaining > 0:
                remaining -= len(line)
        return "".join(chunks)


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


#: What a `# evalens: ...` comment's marker looks like, once the comment
#: itself has already been found. Matched against the comment text alone
#: (see `_trailing_comment`), never against the whole line -- so a `#` inside
#: a string earlier on the line can never be mistaken for this one.
_COMMENT_MARKER = re.compile(r"#\s*evalens\s*:\s*(.*)$")


def _trailing_comment(line: str) -> Optional[str]:
    """The real trailing ``#...`` comment on this line, or None.

    Tokenizes rather than searching the raw text, so a string literal that
    happens to contain the words ``evalens:`` --
    ``input("please say evalens: now")`` -- is never mistaken for a comment
    supplying an answer. Tokenizing is a lexical pass, the same one
    ``ast.parse`` makes before it builds a tree; nothing here executes
    anything, and a line that fails to tokenize on its own -- the closing
    half of a statement that opened a bracket on an earlier line -- is simply
    answered with None, exactly as "no comment" would be.
    """
    try:
        tokens = tokenize.generate_tokens(io.StringIO(line).readline)
        for tok in tokens:
            if tok.type == tokenize.COMMENT:
                return tok.string
    except Exception:  # noqa: BLE001 - best-effort; never fail the statement
        return None
    return None


def _split_comment_values(text: str) -> Tuple[str, ...]:
    """Split an ``# evalens:`` comment's text into literal answers.

    A small explicit parser, not a general expression, and deliberately not
    good enough to be mistaken for one. A value is either bare text up to the
    next comma, taken verbatim but for the whitespace around it, or a
    ``'...'``/``"..."`` quoted span, taken verbatim between the quotes -- no
    escaping, no interpretation, just characters copied out. Good enough for
    "a name" and "a number written as a string"; anyone who needs more than a
    literal comma inside a value can quote it, and anyone who needs more than
    that should not be putting it in a comment.
    """
    values: List[str] = []
    i, n = 0, len(text)
    while i <= n:
        while i < n and text[i] in " \t":
            i += 1
        if i < n and text[i] in "'\"":
            quote = text[i]
            end = text.find(quote, i + 1)
            if end == -1:
                # Unterminated quote: take the rest of the text verbatim
                # rather than guess where it was meant to close.
                values.append(text[i + 1:])
                break
            values.append(text[i + 1:end])
            comma = text.find(",", end + 1)
            i = n + 1 if comma == -1 else comma + 1
        else:
            comma = text.find(",", i)
            if comma == -1:
                values.append(text[i:].rstrip())
                i = n + 1
            else:
                values.append(text[i:comma].rstrip())
                i = comma + 1
    return tuple(values)


def _comment_answers(form: Form, filename: str) -> Optional[Tuple[str, ...]]:
    """Values a ``# evalens: ...`` comment on ``form``'s own line supplies.

    Only the statement's *last physical line* is read. Every example in #86
    is one line, a multi-line statement's answer has nowhere unambiguous to
    sit across the lines it spans, and the last line is where the value that
    replaces the statement is already shown, so it is the natural line for
    the value that fed it too.

    ``linecache`` rather than a line handed down from the caller, because the
    caller already put the whole source there before running anything -- see
    ``evaluate`` and ``evaluate_file`` -- and reading it back here means
    nothing about *executing* a statement has to also thread its raw text
    through.
    """
    line = linecache.getline(filename, form.end_line + 1)
    if not line:
        return None
    comment = _trailing_comment(line.rstrip("\r\n"))
    if comment is None:
        return None
    match = _COMMENT_MARKER.match(comment)
    if match is None:
        return None
    return _split_comment_values(match.group(1))


def _replay_key(form: Form) -> Optional[str]:
    """A statement's identity in `_REPLAY_ANSWERS`: what it says, not where
    it sits.

    ``ast.unparse`` rather than the raw source line, so that reindenting the
    statement, or adding the very ``# evalens:`` comment this feature reads,
    does not read as a different statement -- comments and incidental
    whitespace are not part of the tree. A statement that now does something
    else *is* a different key, which is the "until the statement changes"
    #86 asks for, and falls out of keying by content instead of position
    rather than needing its own tracking.
    """
    try:
        return ast.unparse(form.node)
    except Exception:  # noqa: BLE001 - identity is best-effort, never fatal
        return None


@contextlib.contextmanager
def _user_io(allow_stdin: bool = False,
             at: Optional[Dict[str, Any]] = None,
             form: Optional[Form] = None,
             filename: Optional[str] = None
             ) -> Iterator[tuple[OutputCapture, OutputCapture, "_AskingStdin"]]:
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

    ``form`` and ``filename`` are how a canned answer gets resolved -- a
    ``# evalens:`` comment on the statement's own source, or a value the same
    statement was given the last time it ran; see the module docstring's "Not
    asking, when an answer is already known". Both are optional and default
    to None, which answers exactly as before: ask every time. That is what a
    caller with no form to give gets, rather than an error, because "cannot
    resolve a canned answer" is not a reason to stop letting code ask.

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
    out = OutputCapture(prompt_limit=PROMPT_LIMIT)
    err = OutputCapture(prompt_limit=PROMPT_LIMIT)
    previous_out = _USER_OUT.capture(out)
    previous_err = _USER_ERR.capture(err)
    comment = (_comment_answers(form, filename)
               if form is not None and filename is not None else None)
    key = _replay_key(form) if form is not None else None
    stdin, allowed, was_at = sys.stdin, _ALLOW_STDIN, _RUNNING_AT
    _ALLOW_STDIN, _RUNNING_AT = allow_stdin, at
    asking = _AskingStdin(_USER_OUT, _USER_ERR, comment=comment, replay_key=key)
    sys.stdin = asking
    try:
        yield out, err, asking
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

#: The operations each formatter above actually performs on a value, beyond
#: `__repr__` -- found by #23's own `NoExecution` test, which caught a
#: `class Probe(dict)` overriding `__getitem__` still being walked by
#: `repr_dict`, because the guard below used to check only `__repr__`.
#: `_pair` reads `mapping[key]` (`__getitem__`); `_repr_iterable`'s `head`
#: loop reads `for item in x` (`__iter__`); its `_last` calls `reversed(x)`,
#: which uses `__reversed__` where a type defines one and the `__len__` +
#: `__getitem__` fallback protocol where it does not; `_cut` slices
#: `x[:keep]` (`__getitem__`). `list` and `collections.deque` define
#: `__reversed__`, so only that slot needs checking for the `reversed()`
#: half of the two; `tuple`, `str`, `bytes` and `bytearray` define none, so
#: `reversed()` and slicing fall back to `__len__` and `__getitem__` for
#: them instead, and those are what have to be unchanged. `dict` needs both:
#: its own `__reversed__`, and `__getitem__` for `_pair`.
_BOUNDED_DUNDERS: Dict[type, Tuple[str, ...]] = {
    list: ("__repr__", "__len__", "__iter__", "__reversed__"),
    collections.deque: ("__repr__", "__len__", "__iter__", "__reversed__"),
    tuple: ("__repr__", "__len__", "__iter__", "__getitem__"),
    dict: ("__repr__", "__len__", "__iter__", "__reversed__", "__getitem__"),
    set: ("__repr__", "__len__", "__iter__"),
    frozenset: ("__repr__", "__len__", "__iter__"),
    str: ("__repr__", "__len__", "__getitem__"),
    bytes: ("__repr__", "__len__", "__getitem__"),
    bytearray: ("__repr__", "__len__", "__getitem__"),
}

#: Stands in for "neither type has this attribute at all" -- `tuple`, `str`,
#: `bytes` and `bytearray` define no `__reversed__`, and two absences have to
#: compare equal or every subclass of those four would fail `_still_the_base`
#: on a slot that was never there to override.
_NO_SUCH_DUNDER = object()


def _still_the_base(kind: type, base: type) -> bool:
    """Is every operation `base`'s formatter performs still `base`'s own on
    `kind`, rather than something `kind` overrode?

    By identity, never by name or by calling it to see what comes back --
    the same reason `_wrote_its_own_repr` gives: an override is free to look
    exactly like the original while doing anything at all. A metaclass that
    makes even `getattr` raise is treated as having overridden everything,
    by `_method`'s own outer `except`.
    """
    return all(
        getattr(kind, dunder, _NO_SUCH_DUNDER)
        is getattr(base, dunder, _NO_SUCH_DUNDER)
        for dunder in _BOUNDED_DUNDERS[base]
    )


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
        """The bounded formatter for `kind`, or None to leave it alone.

        A subclass qualifies only when every operation that formatter
        performs -- not only `__repr__` -- is still the base type's own; see
        `_still_the_base` and the note above `_BOUNDED_DUNDERS`. Anything
        that fails the check falls through to `repr_instance`, which calls
        the object's real `repr()` instead of walking it by hand -- safe
        whatever `kind` overrode, because `repr()` never leaves Python code
        the C implementation is willing to run on its own account.
        """
        name = _BOUNDED_EXACTLY.get(kind)
        if name is not None:
            return getattr(self, name)
        try:
            for base, name in _BOUNDED_TYPES:
                if issubclass(kind, base) and _still_the_base(kind, base):
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


#: How long one table cell's text may run. Well short of `WIRE_REPR_LIMIT`:
#: a table already shows up to `tabular.MAX_COLUMNS` times
#: `tabular.HEAD_ROWS + tabular.TAIL_ROWS` cells, and letting any one of them
#: spend the whole wire budget would crowd out the rows and columns either
#: side of it, the same reasoning `REPR_NESTED_STRING_LIMIT` states for a
#: string found inside an ordinary collection.
TABLE_CELL_LIMIT = 80


def _table_cell(value: Any) -> str:
    """One table cell's text -- `safe_repr`, bounded to `TABLE_CELL_LIMIT`.

    The same machinery every other value on the wire goes through: cycle
    detection, the ``describe()`` substitution for a function or instance
    found sitting in a cell, a ``__repr__`` that raises. Nothing about a
    table cell is exempt from any of that.
    """
    return safe_repr(value, TABLE_CELL_LIMIT)


def wire_value_and_table(
    value: Any, limit: int = WIRE_REPR_LIMIT
) -> Tuple[Optional[str], Optional[str], Optional[Dict[str, Any]]]:
    """``wire_value``, plus a bounded table description when ``value`` is one.

    Computed from the identical value at the identical moment `wire_value`
    already reads -- never a second lookup, which is what an annotation being
    a trace rather than a watch requires (#40). ``tabular.describe`` is
    exactly as defensive as ``describe()`` above and this repeats the same
    belt-and-braces catch around it anyway, so a badly behaved ``.shape`` or
    ``__len__`` can take nothing with it but the table field.
    """
    shown, raw_repr = wire_value(value, limit)
    try:
        table = tabular.describe(value, _table_cell)
    except BaseException:  # noqa: BLE001 - introspection runs user code too
        table = None
    return shown, raw_repr, table
# -- #23: describing a value's children without running anything -----------
#
# `inspect_value` (below, on `Kernel`) is the op an explorer hovers to get
# one level of a value's fields: name, type, bounded value, and whether
# there is more underneath. Everything in this section exists to make that
# answerable without doing the one thing design rule 3 forbids -- running
# code the reader did not ask to run.
#
# The root is always a name already sitting in `self.namespace`, so finding
# it is a dictionary lookup, exactly like a bare name's own display (#68).
# Every step below the root is one of exactly two kinds of read, and both
# are chosen to be incapable of calling anything a class defines:
#
# **`attr`** reads an already-built instance `__dict__` by key. That is a
# dictionary lookup too -- `vars(x)["name"]`, not `getattr(x, "name")` --
# so it cannot reach a `property`, a `__getattr__`, or a descriptor of any
# kind. A `property` is listed as a row with nothing underneath it instead,
# per the ticket's own requirement that one must never be evaluated to be
# shown.
#
# **`item`** reads a position in a `dict`, `list`, `tuple`, `set` or
# `frozenset` -- but only when `passive.base_type` finds the operations this
# performs (`__getitem__`, `__iter__`, `__len__`) still belong to the
# builtin rather than to a subclass's own override. That is #73's rule
# ("type identity plus whether it is inherited, never the type's name"),
# applied to the dunder this module actually calls instead of to
# `__repr__`. A `class LazyRow(dict)` whose `__getitem__` hits a database
# is exactly the shape #68 was filed for, and it is walked by neither
# branch: `passive.base_type` answers `None` for it and nothing is opened.
#
# Every value handed back uses the passive formatter: unknown objects get
# a type description without calling their repr. Every walk is capped at
# `INSPECT_CHILD_LIMIT`
# -- #54's discipline: one level, built only as far as the cap, never
# built whole and then sliced. `len()` on any of the four safe container
# kinds is O(1), so the total count a truncated table reports costs
# nothing beyond what showing the rows already cost.
#
# What this does not solve, by design: a value re-inspected later reads
# whatever the namespace holds *then*, which can differ from what was
# painted if the code ran again in between. That is the same trade the
# ticket's own discussion settled on over a cache keyed by evaluation --
# IPython's `Out`, and its documented habit of pinning every result
# against garbage collection -- a labelling problem, not a leak.

#: How many rows one level of `inspect_value` shows before the rest are
#: elided. Smaller than `REPR_ITEM_LIMIT`: a repr's job is to suggest a
#: value's shape in one line; a table's job is to be read row by row, and a
#: hundred rows already asks more of a reader than any repr does.
INSPECT_CHILD_LIMIT = 100

#: How much of a child's own value rides along in one row. Smaller than
#: `WIRE_REPR_LIMIT`: with up to `INSPECT_CHILD_LIMIT` rows in one response,
#: giving every row the top-level budget would let one field's value crowd
#: out every other field's -- `REPR_NESTED_STRING_LIMIT`'s reasoning, applied
#: to a table instead of a repr.
INSPECT_CHILD_REPR_LIMIT = 240


class _Missing:
    """Answers "not there", where `None` is a value a namespace can hold.

    A path that no longer resolves -- a name reassigned, a list shrunk since
    the row was sent -- has to say so without being confused for a step that
    legitimately led to `None`.
    """

    def __repr__(self) -> str:
        return "<missing>"


_MISSING = _Missing()


# Inspector helpers use static metadata and native storage exclusively.
_own_dict = passive.own_dict
_class_properties = passive.properties
_type_name = passive.type_name


def _is_expandable(value: Any) -> bool:
    base = passive.base_type(value)
    if base is not None:
        return base.__len__(value) > 0
    own = _own_dict(value)
    return (own is not None and dict.__len__(own) > 0
            or bool(_class_properties(value)))


def _key_label(key: Any) -> str:
    return passive.text(key, 80)


def _wire_child(
    name: str, step: Dict[str, Any], value: Any
) -> Dict[str, Any]:
    """One row of an `inspect_value` table.

    The passive formatter cannot dispatch a user-defined repr, even inside
    a built-in container. `step` rides along unexamined, so a
    client asking for this row's own children later sends back exactly the
    access that found it -- never a key or an index it reconstructed itself.
    """
    text, raw = passive.text(value, INSPECT_CHILD_REPR_LIMIT), None
    child: Dict[str, Any] = {
        "name": name,
        "kind": step["kind"],
        "type": _type_name(value),
        "value": text,
        "expandable": _is_expandable(value),
        "step": step,
    }
    if raw is not None:
        child["repr"] = raw
    return child


def _children_of(
    value: Any, cap: int = INSPECT_CHILD_LIMIT
) -> Tuple[list, int]:
    """One level of `value`'s children, built to `cap` rather than sliced
    from the whole.

    #54's discipline, applied to a table instead of a repr: a
    five-million-element list costs the same hundred rows here that a
    five-element one would, because `itertools.islice` never asks the
    container for an element past the cap. The total is still exact --
    `len()` on any of the three safe container kinds is O(1) -- so a
    truncated table can say how much it left out without having paid to
    find out.
    """
    base = passive.base_type(value)
    if base is dict:
        total = dict.__len__(value)
        rows = [
            _wire_child(_key_label(key), {"kind": "item", "index": index},
                        child)
            for index, (key, child) in
            enumerate(itertools.islice(dict.items(value), cap))
        ]
        return rows, total
    if base is not None:
        total = base.__len__(value)
        rows = [
            _wire_child(f"[{index}]", {"kind": "item", "index": index},
                        child)
            for index, child in itertools.islice(passive.items(value, base), cap)
        ]
        return rows, total

    # A plain instance: its own bindings first, then the properties its
    # class declares but has not been made to run -- see the module note
    # above for why a property stops here rather than being read.
    own = _own_dict(value)
    own = {} if own is None else own
    rows = [
        _wire_child(key, {"kind": "attr", "name": key}, child)
        for key, child in itertools.islice(dict.items(own), cap)
        if type(key) is str
    ]
    remaining = max(cap - len(rows), 0)
    own_names = {key for key in dict.__iter__(own) if type(key) is str}
    props = {key: descriptor for key, descriptor in
             _class_properties(value).items() if key not in own_names}
    rows.extend(
        {
            "name": key,
            "kind": "property",
            "type": "property",
            "value": None,
            "expandable": False,
            "evaluated": False,
        }
        for key in itertools.islice(props, remaining)
    )
    return rows, dict.__len__(own) + len(props)


def _walk_step(value: Any, step: Any) -> Any:
    """One child of `value`, addressed exactly the way `_children_of` found
    it -- never by re-deriving anything from a key or index the caller
    supplies.

    Every branch here performs the identical safe access `_children_of`
    already used to list the row, so nothing is looked up by a name or a
    key the request invents, only by the attribute name or position a
    previous response handed out. `_MISSING` rather than raising: a value
    reassigned or shrunk since that response answers "not there any more",
    which is a labelling problem this project already accepts (design rule
    4), not a crash.
    """
    if not isinstance(step, dict):
        return _MISSING
    kind = step.get("kind")
    if kind == "attr":
        key = step.get("name")
        own = _own_dict(value) if isinstance(key, str) else None
        if own is not None:
            for name, child in dict.items(own):
                if type(name) is str and name == key:
                    return child
        return _MISSING
    if kind == "item":
        index = step.get("index")
        if not isinstance(index, int) or isinstance(index, bool) or index < 0:
            return _MISSING
        base = passive.base_type(value)
        if base is None:
            return _MISSING
        for position, (_, child) in enumerate(passive.items(value, base)):
            if position == index:
                return child
        return _MISSING
    return _MISSING


def _inspect_error(kind: str, message: str) -> Dict[str, Any]:
    return {
        "ok": False,
        "error": {"type": kind, "message": message, "traceback": ""},
    }


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
        shown, raw_repr, table = wire_value_and_table(value)
        pair = {"name": name, "value": shown}
        if raw_repr is not None:
            pair["repr"] = raw_repr
        if table is not None:
            pair["table"] = table
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
    node: ast.stmt, head_limit: int = loops.HEAD_LIMIT,
    watches: Optional[Dict[loops.LoopKey, List[Tuple[str, ast.expr]]]] = None,
) -> tuple[ast.stmt, list, list]:
    """`node` rewritten to announce its iterations, plus its recorders.

    Two different rewrites, and a statement gets at most one of them.

    **The statement the user pointed at is itself a `for` or `async for`.**
    Only that loop is touched -- the rewrite descends into loops nested
    directly inside it, but never into a `def` or `class` in the body, whose
    loops run at a time this evaluation knows nothing about -- and its own
    target and body bindings come back as `loop_recorders`, exactly as before
    #75. A comprehension sitting in *this* loop's own iterable or body is not
    additionally instrumented: the two rewrites do not share an index space,
    and a `for` statement already gets a full trace of its own, which is the
    gap #75 exists to close for the statements that do not.

    **Anything else** is searched for a `ListComp`, `SetComp` or `DictComp`
    wherever one appears in the statement -- inside an assignment's
    right-hand side, an expression statement, a condition, anywhere but a
    nested `def`/`class`/`lambda` -- and each `for` clause found is wrapped to
    report what it drew, as `comprehension_recorders`. A generator expression
    is found and left untouched; see `loops._ComprehensionInstrumenter`.

    A statement matching neither case, or one holding no comprehension, comes
    back unchanged with both lists empty, which is what makes this cost
    nothing beside the statement kinds neither #31 nor #75 was asked about.

    A `head_limit` of zero is the off switch for `evalens.loopValues`, and it
    turns both rewrites off rather than the display: an off switch that still
    instrumented would stop showing the sequence and keep charging one
    `repr()` per iteration for it. #75 asked for a comprehension trace to obey
    the same switch, which is what sharing this one guard guarantees rather
    than states.

    `watches` is `Kernel.evaluate_watch`'s addition -- #48 -- and it obeys the
    exact same switch. A watch costs one more `repr()` per iteration than the
    loop already pays, and `evalens.loopValues: 0` is the reader saying that
    price is not worth it for *any* per-iteration value; a watch is not a
    special case that keeps running underneath an instrumentation the reader
    turned off. Left empty (the default) for every ordinary `eval`, which is
    the only caller `head_limit <= 0` was ever guarding before this existed.
    """
    if head_limit <= 0:
        return node, [], []
    repr_fn = lambda value: safe_repr(value, loops.ITEM_LIMIT)  # noqa: E731
    if isinstance(node, (ast.For, ast.AsyncFor)):
        if watches:
            rewritten, plan, watch_plan = loops.instrument_watching(
                node, watches)
            return (rewritten,
                     loops.watching_traces(plan, watch_plan, repr_fn,
                                           head_limit),
                     [])
        rewritten, plan = loops.instrument(node)
        return rewritten, loops.traces(plan, repr_fn, head_limit), []
    rewritten, labels = loops.instrument_comprehensions(node)
    return rewritten, [], loops.comprehension_traces(
        labels, repr_fn, head_limit)


def _report_watch_failures(loop_trace: "loops.LoopTrace",
                           err: "io.StringIO") -> None:
    """Print one line per nominated expression that ever raised -- #48.

    `LoopTrace.fail` deliberately keeps no more than the first exception and
    a count of how many more there were; this is the other half of "reported
    once, not per iteration" -- the half that makes it something the reader
    actually sees. It goes to the statement's own `stderr`, exactly where a
    `print()` inside the loop body would have landed, so it reaches the
    annotation through the existing `printed` field and asks nothing of
    `format.ts` or `decorations.ts`, neither of which #48 owns.

    Called only when the statement ran to completion -- a loop that raised
    outright never reaches this, and correctly: an annotation for a
    statement that failed shows the failure, not a footnote about a watch
    that never got to matter.
    """
    for expr_source, trace in loop_trace.watches.items():
        if trace.error is None:
            continue
        more = f" ({trace.failed} more)" if trace.failed else ""
        print(f"evalens: watching {expr_source!r} raised "
              f"{trace.error['type']}: {trace.error['message']}{more}",
              file=err)


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


def _without_kernel_frames(
    tb: Optional[types.TracebackType]
) -> Optional[types.TracebackType]:
    """`tb`, with any frame from this kernel's own code spliced out.

    A `for` loop's recorders are simple statements in the body -- `record`,
    `bind` -- and user code raising *through* either was never possible; the
    body's own exceptions come from the body's own statements, not from a
    call into this kernel. A comprehension's clause has no body to call one
    from, so `LoopTrace.trace` wraps the clause's *iterable* instead, and that
    does put a frame of this kernel's own on the stack -- an iterable whose
    `__next__` raises mid-iteration unwinds out through `trace`'s own `for
    item in iterable:` on its way to the user's code. `tb_skip` below only
    ever removes a fixed number of frames from the front, which cannot reach
    one sitting in the middle; this walks the whole chain instead.

    Recursive, because a traceback is a linked list built from the raise
    outward, and the replacement has to be assembled the same way: a new node
    can only point at an already-rebuilt tail.
    """
    if tb is None:
        return None
    rest = _without_kernel_frames(tb.tb_next)
    if os.path.abspath(tb.tb_frame.f_code.co_filename) in _KERNEL_FILES:
        return rest
    return types.TracebackType(rest, tb.tb_frame, tb.tb_lasti, tb.tb_lineno)


def _error(exc: BaseException, tb_skip: int = 0) -> Dict[str, Any]:
    """Format an exception for the wire, without the kernel's own frames.

    The user should see their file and their line numbers. Every frame this
    module contributes is noise that makes a NameError look like an
    extension bug. `tb_skip` peels a fixed number from the front -- the
    `exec()`/`eval()` call site above the user's own code -- and
    `_without_kernel_frames` catches the one place a frame of this kernel's
    own can still appear further in: see its docstring.
    """
    tb = exc.__traceback__
    for _ in range(tb_skip):
        if tb is None:
            break
        tb = tb.tb_next
    tb = _without_kernel_frames(tb)
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


def _package_chain(directory: str) -> Tuple[str, Tuple[str, ...]]:
    """Walk up from `directory` through every real, on-disk package.

    A directory counts as a package exactly when it has its own
    ``__init__.py`` sitting in it -- the same fact Python's own import system
    checks. The walk climbs while that keeps being true and stops at the
    first ancestor where it is not, which is the directory a real ``import``
    of the innermost one would need on ``sys.path`` to find it. The answer is
    that directory, and the package names passed on the way up, outermost
    first: ``demo_pkg/geometry.py``'s directory answers
    ``(".../python-walkthrough", ("demo_pkg",))``.

    Filesystem-based, deliberately, and that is what keeps this safe to call
    on every request rather than only real ones. Nothing about a *filename*
    says whether the directory beside it is a package -- unlike ``__init__.py``,
    which says so about itself -- so the only honest answer comes from looking.
    ``os.path.isfile`` on a path that is not there answers False rather than
    raising, so a notional path with nothing on disk (``/tmp/course/...``, the
    whole of the kernel test suite's fixtures) fails the very first check and
    the walk goes nowhere: `directory` itself comes back with no package names,
    exactly the answer this kernel has always given a file with no
    ``__init__.py`` really beside it.
    """
    segments: List[str] = []
    current = directory
    while os.path.isfile(os.path.join(current, "__init__.py")):
        parent = os.path.dirname(current)
        if parent == current:
            # The filesystem root has no parent, so there is nowhere further
            # to climb -- reached only by a package with no floor under it,
            # which is not a shape a real project has.
            break
        segments.insert(0, os.path.basename(current))
        current = parent
    return current, tuple(segments)


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
    deliberately is a separate command, Evalens: Run File as Script (#78),
    which is why this function still never returns ``"__main__"`` for a named
    file: `_as_module` overrides its answer for that one request instead of
    changing what a load is named.

    ``__init__.py`` is named after its directory, because that is a package's
    name and the file is only how it opens. **Real packages nest**, and a
    dotted name says so: ``demo_pkg/geometry.py``, sitting beside a real
    ``demo_pkg/__init__.py``, answers ``demo_pkg.geometry`` -- what
    ``import demo_pkg.geometry`` actually names it, verified against a real
    interpreter rather than assumed. `_package_chain` is the walk that finds
    the ancestors; this only asks it and joins the answer on. A file with no
    real ``__init__.py`` above it gets back an empty chain and answers exactly
    as it always has -- its own bare stem -- which is also every notional
    path the kernel test suite uses, since nothing at ``/tmp/course/...`` is
    ever written to disk for `_package_chain` to find.

    Anything with no name to take -- the ``<evalens>`` placeholder a source
    with no path gets -- keeps ``__evalens__``, which is now the honest answer
    rather than the universal one: there is no module, so there is no name
    for it.
    """
    stem = os.path.splitext(os.path.basename(filename or ""))[0]
    directory = os.path.dirname(os.path.abspath(filename)) if filename else ""
    if stem == "__init__":
        stem = os.path.basename(directory)
        directory = os.path.dirname(directory)
    if not stem or stem.startswith("<"):
        return NO_MODULE_NAME
    if not filename or not os.path.isabs(filename):
        return stem
    _, ancestors = _package_chain(directory)
    return ".".join(ancestors + (stem,)) if ancestors else stem


def _module_package(filename: str) -> str:
    """``__package__`` for a load of `filename`, on `_module_name`'s terms.

    Verified against a real interpreter rather than assumed, because the two
    dunders everyone quotes from memory turn out to disagree by one segment:
    ``import demo_pkg`` gives its own ``__init__.py`` ``__package__ ==
    "demo_pkg"`` -- the same as its ``__name__``, since a package *is* its own
    package -- while ``import demo_pkg.geometry`` gives the submodule
    ``__package__ == "demo_pkg"`` with no ``.geometry`` on it. Both are
    `_module_name`'s answer with the file's own segment removed, except the
    package's own file has no segment to remove; `_package_chain` already
    drew that line once and this reuses it rather than redoing the walk to
    reach a different amount of it.

    A plain top-level module -- no real ``__init__.py`` anywhere above it --
    answers ``""``, which is what a genuine ``import`` gives one too, and
    exactly why a relative import in a file with no package around it fails
    on a load precisely as it would under a real one.
    """
    stem = os.path.splitext(os.path.basename(filename or ""))[0]
    directory = os.path.dirname(os.path.abspath(filename)) if filename else ""
    if stem == "__init__":
        return _module_name(filename)
    if not stem or stem.startswith("<"):
        return ""
    if not filename or not os.path.isabs(filename):
        return ""
    _, ancestors = _package_chain(directory)
    return ".".join(ancestors)


def _script_directory(filename: str) -> Optional[str]:
    """The directory ``python3 <filename>`` would put at ``sys.path[0]``.

    ``None`` when the request does not name a file on disk -- ``<evalens>`` for
    a source with no path, or an unsaved buffer, whose name is a title rather
    than a location. Falling back to the working directory there would import
    from wherever the editor happened to be launched, which is nobody's intent
    and differs between two windows opened the same way.

    This is deliberately *not* package-aware, because ``python3`` is not
    either: running ``python3 demo_pkg/geometry.py`` puts ``demo_pkg/`` itself
    at ``sys.path[0]`` -- verified against a real interpreter -- never the
    directory above it, however many real packages sit between the file and
    the filesystem root. See `_package_root` for the answer a load needs
    instead, and `_script_path` for where the two are chosen between.
    """
    if not filename or not os.path.isabs(filename):
        return None
    directory = os.path.dirname(os.path.abspath(filename))
    return directory if os.path.isdir(directory) else None


def _package_root(filename: str) -> Optional[str]:
    """Where a real ``import`` of this file would need ``sys.path`` to start.

    `_script_directory`'s answer, generalised the way `_module_name`'s is: a
    file with no real ``__init__.py`` above it is answered exactly as
    `_script_directory` always has -- its own directory -- and a file that is,
    or sits inside, one or more real packages walks up through all of them and
    answers with the first ancestor that is not one. That is where
    ``import demo_pkg`` would need to look to find ``demo_pkg/`` at all;
    leaving ``sys.path[0]`` at ``demo_pkg/`` itself, which is what a plain
    top-level file gets, was the reason ``from .geometry import area`` failed
    with ``ModuleNotFoundError: No module named 'demo_pkg'`` even once
    ``__package__`` was set -- reproduced and fixed together, because setting
    one without the other still fails, only later and with a different
    traceback.

    ``None`` on `_script_directory`'s own terms: nothing here re-decides when
    there is no directory to speak of.
    """
    directory = _script_directory(filename)
    if directory is None:
        return None
    stem = os.path.splitext(os.path.basename(filename))[0]
    start = os.path.dirname(directory) if stem == "__init__" else directory
    root, _ = _package_chain(start)
    return root


@contextlib.contextmanager
def _script_path(filename: str, as_script: bool = False) -> Iterator[None]:
    """Run with the right directory first on ``sys.path``.

    Two different answers, on purpose, and `as_script` is what picks between
    them -- the same split `_as_module` makes for ``__name__``. A load means
    *import this module*, so it is entitled to `_package_root`: the directory
    a real ``import`` would need, which reaches above the file's own directory
    exactly when the file is, or sits inside, a real package. A script run
    means ``python3 <file>``, and `_script_directory` is what that command
    actually gives ``sys.path[0]`` -- verified against a real interpreter --
    which is the file's own directory *regardless* of any package around it.
    They agree, and both reduce to the one directory this always inserted,
    whenever the file has no real ``__init__.py`` anywhere above it; the
    split is only visible on a package member, and only there because the two
    commands are answering different questions about the same file.

    This is the other half of the import path the user is entitled to.
    ``python3 myfile.py`` puts ``myfile.py``'s directory at ``sys.path[0]``,
    and that is how a file imports the package sitting beside it; the kernel
    is a different script in a different directory, so without this an
    ``import demo_pkg`` fails with ``demo_pkg/`` in the same folder as the
    file being loaded, and every statement that names anything from it fails
    after it.

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
    directory = (
        _script_directory(filename) if as_script else _package_root(filename))
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


@contextlib.contextmanager
def _script_argv(filename: str, as_script: bool) -> Iterator[None]:
    """``sys.argv`` the way ``python3 <filename>`` sets it, for a script run.

    ``python3 myfile.py`` gives the running program ``sys.argv ==
    [myfile.py]``; the kernel's own argv is its own command line, e.g.
    ``["evalens_kernel.py", "--control-in", "3", ...]``, and code that reads
    ``sys.argv[0]`` expecting its own name gets the kernel's instead. That is
    only worth fixing for a request explicitly asking to be run as a script:
    an ordinary load or a single evaluation makes no such claim, and replacing
    ``sys.argv`` under either would be a promise about the namespace nobody
    asked for -- the same reasoning `_script_path` is scoped by.

    A no-op, not merely a narrower one, when ``as_script`` is false: this is
    called on every ``eval_file``, and a context manager that is sometimes a
    context and sometimes nothing is easier to get wrong at the call site than
    one that is always entered and does nothing when there is nothing to do.

    Scoped to the request and restored after, on the same terms as
    `_script_path`: a session evaluates many files, and ``sys.argv`` left
    pointing at whichever ran last would make the next file's ``sys.argv[0]``
    depend on what happened to run before it.
    """
    if not as_script:
        yield
        return
    previous = sys.argv
    sys.argv = [filename]
    try:
        yield
    finally:
        sys.argv = previous


def _is_main_guard(node: ast.stmt) -> bool:
    """Whether `node` is the canonical ``if __name__ == "__main__":`` guard.

    Deliberately narrow: it matches the one idiom every first-year course
    teaches, in either operand order, and nothing looser. A ``!=`` guard, an
    ``elif``, or a comparison folded into a larger boolean expression falls
    through and gets no special treatment -- guessing at author intent for a
    shape nobody actually writes would risk mislabelling a statement that has
    nothing to do with the problem #78 is about.

    Used only to decide whether a *load*'s dead guard is worth saying so
    about; see the call in `Kernel._run`. It is never used to decide what
    runs -- that is `__name__`'s job, set once in `_as_module`, and this
    function does not change it.
    """
    if not isinstance(node, ast.If):
        return False
    test = node.test
    if not isinstance(test, ast.Compare) or len(test.ops) != 1:
        return False
    if not isinstance(test.ops[0], ast.Eq):
        return False
    left, right = test.left, test.comparators[0]

    def is_dunder_name(candidate: ast.expr) -> bool:
        return isinstance(candidate, ast.Name) and candidate.id == "__name__"

    def is_main_literal(candidate: ast.expr) -> bool:
        return (isinstance(candidate, ast.Constant)
                and candidate.value == "__main__")

    return ((is_dunder_name(left) and is_main_literal(right))
            or (is_dunder_name(right) and is_main_literal(left)))


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
    # SyntaxError offsets count Unicode code points, unlike AST byte offsets.
    if exc.text is not None:
        character = len(exc.text[:character].encode("utf-16-le")) // 2
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


def _above_boundary(forms: List[Form], line: int) -> int:
    """Index into `forms` of the boundary form for 0-based cursor `line`.

    The boundary is the top-level statement the cursor sits in, or would sit
    in if one reached that far: the first form, in file order, whose own last
    line is at or past the cursor. Everything before it in `forms` is what
    "above the cursor" means for `eval_above`; the boundary form itself is
    never run here, because it is the statement Evaluate at Cursor answers
    for, not this command -- run-above sets up context, it does not also
    perform the evaluation the cursor is pointing at.

    Three cases fall out of the one rule rather than needing a case each. A
    cursor inside a multi-line statement finds that whole statement as the
    boundary, so it is excluded intact -- a statement never runs partially.
    A cursor on a blank line between two statements finds the *next* one,
    because the previous statement's last line is already behind the cursor
    and the next one's is not, so "above" ends exactly at the blank line.
    A cursor with nothing at or after it -- past the last statement, or
    beneath a break `parse_prefix` already cut the tree around -- matches no
    form, and `len(forms)` says so: every parsed form is "above" and none is
    excluded, because there is nothing left for a boundary to be.
    """
    for index, form in enumerate(forms):
        if form.end_line >= line:
            return index
    return len(forms)


def _future_flags(tree: ast.Module) -> int:
    """The source module's explicit compiler context, never the kernel's."""
    flags = 0
    for index, node in enumerate(tree.body):
        if (index == 0 and isinstance(node, ast.Expr)
                and isinstance(node.value, ast.Constant)
                and isinstance(node.value.value, str)):
            continue
        if not isinstance(node, ast.ImportFrom) or node.module != "__future__":
            break
        for alias in node.names:
            feature = getattr(_future, alias.name, None)
            if isinstance(feature, _future._Feature):
                flags |= feature.compiler_flag
    return flags


class Kernel:
    """The namespace and the operations that act on it."""

    def __init__(self) -> None:
        self.namespace: Dict[str, Any] = {}
        self.reset()

    def reset(self) -> None:
        self.namespace.clear()
        self.namespace.update(
            # Both replaced per request by `_as_module`, which knows which
            # file is being evaluated and can therefore say what the module
            # is called and what package it belongs to. This is what an
            # empty session is called, and belongs to, before anything has
            # been evaluated into it.
            {"__name__": NO_MODULE_NAME, "__package__": "",
             "__builtins__": __builtins__}
        )
        # A fresh session has no statement it has already asked, so it has
        # nothing to replay either -- see `clear_input_replay` for the lighter
        # version of this that keeps the namespace.
        _REPLAY_ANSWERS.clear()

    @contextlib.contextmanager
    def _as_module(
        self, filename: str, as_script: bool = False
    ) -> Iterator[None]:
        """Set the namespace up the way Python sets a module up.

        Four things, in two pairs that answer the same question on two
        different terms. The module's name and the import path a module of
        that name would have are one pair; both were the kernel's rather than
        the user's, and each was visible in the buffer -- a local import that
        could not resolve, and a module name that appeared in annotations and
        reprs while appearing nowhere in the source. ``__package__`` and
        *which* import path -- `_package_root`'s or `_script_directory`'s --
        are the second pair, added for the same reason: a relative import
        inside a real package member is a third way the kernel's own
        omissions were visible in the buffer, this time as an ``ImportError``
        a real ``import`` of the same file would not raise.

        Per request rather than per session, because a session evaluates
        whichever file the cursor is in and the answer is a property of that
        file. The name and the package are set and left: nothing between
        requests reads them, and the next evaluation says what they are
        again. The path is scoped, for the reasons in `_script_path`.

        ``as_script`` is what picks between the two terms, and the one place
        Evalens: Run File as Script (#78) touches. True imitates ``python3
        <file>``, verified against a real interpreter rather than assumed:
        the module is named ``__main__``, ``__package__`` is ``None`` --
        Python's own answer, not an empty string -- and `_script_directory`
        decides the path, which is the file's own directory whatever package
        surrounds it. That is also why a relative import inside a package
        member fails under a script run precisely as it would under a real
        ``python3 pkg/mod.py``: running a file directly never establishes
        package context, in Evalens or anywhere else, and pretending
        otherwise would be a load-bearing difference from what this command
        promises to imitate. False, the only way `evaluate` ever calls this,
        is every load and every single evaluation exactly as before -- naming
        the module after its file *is* what stops the guard firing, on
        purpose -- with `__package__` and `_package_root` now completing the
        promise `_module_name` already made: a load is *import this module*,
        including the relative imports a real one would resolve.

        `__file__` is the fifth thing Python sets and is deliberately not
        here; it is a promise about the namespace with its own consequences
        and its own ticket.
        """
        self.namespace["__name__"] = (
            "__main__" if as_script else _module_name(filename))
        self.namespace["__package__"] = (
            None if as_script else _module_package(filename))
        with _script_path(filename, as_script), \
                _script_argv(filename, as_script):
            yield

    # -- operations ---------------------------------------------------------

    def handle(self, request: Dict[str, Any]) -> Dict[str, Any]:
        op = request.get("op")
        if op == "ping":
            return {"ok": True, "python": sys.version, "pid": os.getpid()}
        if op == "reset":
            self.reset()
            return {"ok": True}
        if op == "clear_input_replay":
            # Lighter than `reset`: the namespace and every binding in it
            # stay exactly as they were, and only the memory of what answered
            # past prompts is let go. What "the user cleared it" means for
            # mechanism 1 of #86 -- the comment mechanism needs no clearing,
            # since editing or removing the comment already is that.
            _REPLAY_ANSWERS.clear()
            return {"ok": True}
        if op == "eval":
            return self.evaluate(request)
        if op == "eval_watch":
            return self.evaluate_watch(request)
        if op == "eval_file":
            return self.evaluate_file(request)
        if op == "outline":
            return self.outline(request)
        if op == "inspect":
            return self.inspect_value(request)
        if op == "eval_above":
            return self.evaluate_above(request)
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

        form = form_at(parsed.tree, line, character, source=source)
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
                                compiler_flags=_future_flags(parsed.tree),
                                allow_stdin=bool(request.get("allow_stdin")),
                                limits=_limits(request))
        outcome.update(partial)
        return outcome

    def evaluate_watch(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """Run the loop enclosing a nominated expression, tracing that
        expression alongside the loop's own target -- #48.

        **This is a trace, not a watch, whatever the ticket is titled.** A
        "watch" in this project is a forbidden thing: the *current* value of
        something, re-read later, which asserts more than any statement
        produced (#40, design rule 4). What this op adds is the same claim
        `loops.py` already makes for a loop's target and for what its body
        binds -- a value read **during** the iteration that produced it,
        recorded once and never re-read -- for one more expression the
        reader chose. `request["watch"]` names it; nothing about the result
        can be asked for again without sending another request.

        **Evaluating `request["watch"]` at all is design rule 3's hard case.**
        A nominated expression is arbitrary -- `acct.balance`, `f(x)`, `d[k]`
        -- and running it once per iteration is exactly the unbidden
        execution #68 was filed over, one level up: nobody asked this line
        to call `f`, they asked to watch what it returns. What licenses it
        here and nowhere else in the kernel is that the request names one
        specific expression, chosen and typed by the reader for this one
        call; it is not run because the kernel guessed it might be
        interesting; it is not kept running after this response is sent, and
        nothing in this module remembers it once `_run` returns. A future
        `eval` of the same loop, with no `watches` in its request, installs
        no watch at all -- see `_instrumented`'s `watches` parameter, which
        defaults to none, and `loops.py`'s module docstring for the fuller
        argument against letting a nomination outlive its own request.

        **A failing expression is reported once and does not stop the
        loop.** `loops._watch_call` wraps the evaluation in the rewritten
        tree's own `try`/`except Exception`, so a raise on iteration 300 of
        1000 is caught where it happens, in the user's frame, recorded
        through `LoopTrace.fail`, and the loop keeps going; `_run` prints one
        line about it to the statement's own stderr (`_report_watch_failures`)
        rather than one per iteration.

        The rest of the resolution mirrors `evaluate`: the same parse, the
        same fallback for a file that does not parse whole, and the same
        `resolved: False` for a request that lands nowhere. What is new is
        narrower and specific to a watch:

        * the statement under `line`/`character` must itself be a `for` or
          `async for` -- a watch on an expression inside an `if` or `try`
          wrapping a loop is out of scope for the same reason plain
          `eval` never shows *that* loop's sequence either, and reported as
          `NoLoop` rather than silently doing nothing;
        * `loops.innermost_loop_at` then finds the most tightly nested loop
          actually enclosing the expression's own position, so a watch
          nominated inside a nested loop is filed against that loop and not
          the outer one;
        * `request["watch"]` must parse as a single expression -- a
          statement, or unparsable text, is `SyntaxError` rather than a
          silently empty trace.
        """
        source: str = request.get("source", "")
        line: int = request.get("line", 0)
        character: int = request.get("character", 0)
        filename: str = request.get("filename") or "<evalens>"
        expr_source = request.get("watch")
        if not isinstance(expr_source, str) or not expr_source.strip():
            return {
                "ok": False,
                "error": {"type": "NoExpression",
                          "message": "no expression to watch",
                          "traceback": ""},
            }

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

        form = form_at(parsed.tree, line, character, source=source)
        if form is None:
            return {"ok": True, "resolved": False, **partial}

        if not isinstance(form.node, (ast.For, ast.AsyncFor)):
            # Matches `_instrumented`'s own gate for the plain loop display:
            # a watch on an expression the statement under the cursor does
            # not itself iterate has nothing established to attach to.
            return {
                "ok": False,
                "error": {"type": "NoLoop",
                          "message": "the statement under the cursor is not "
                                     "a loop",
                          "traceback": ""},
            }

        source_lines = source.split("\n")
        byte_column = utf8_column(source_lines[line], character)
        loop_node = loops.innermost_loop_at(form.node, line, byte_column)
        if loop_node is None:
            # Reachable only if the position `form_at` resolved the
            # statement from falls outside that very statement's own span --
            # not expected, and answered the same honest way rather than
            # guessed at.
            return {
                "ok": False,
                "error": {"type": "NoLoop",
                          "message": "no loop encloses this expression",
                          "traceback": ""},
            }

        try:
            expr_node = ast.parse(
                expr_source, filename=filename, mode="eval").body
        except SyntaxError as exc:
            return {
                "ok": False,
                "error": {"type": "SyntaxError",
                          "message": f"cannot watch {expr_source!r}: {exc}",
                          "traceback": ""},
            }

        watches = {loops.loop_key(loop_node): [(expr_source, expr_node)]}

        with self._as_module(filename):
            outcome = self._run(form, filename,
                                compiler_flags=_future_flags(parsed.tree),
                                allow_stdin=bool(request.get("allow_stdin")),
                                limits=_limits(request), watches=watches)
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
        wants. Running it is a separate, explicit act rather than a thing a
        load starts doing on its own: ``as_script: true`` asks for exactly
        that, and only that -- everything above this paragraph is still true
        of it. ``__name__`` becomes ``"__main__"`` for the request instead of
        the file's own name, the guard evaluates the way ``python3 file.py``
        would, and its body runs like every other statement in the file:
        through this same method, in the same namespace, with its own
        outcome in ``results``. See `_as_module`.

        This method never resets the namespace on its own account, for a
        script run or an ordinary load alike -- whatever was bound before the
        request stays bound going into it, exactly as a second ordinary load
        leaves the first load's namespace in place and simply runs the file
        again on top of it. That is still the right behaviour for the op
        itself: a test or another caller that sends ``eval_file`` twice with
        ``as_script: true`` and nothing in between gets Load File with one bit
        flipped, not a second command with its own rules about what survives
        -- see the `RunFileAsScript` tests below, which drive exactly that and
        would break if this method reset behind their back.

        The decision that a script run's namespace should be fresh
        (`docs/development/namespace-reset.md`, superseded by the setting
        recorded on #99) is therefore kept out of here and made by the
        caller instead: Evalens: Run File as Script always sends ``op:
        reset`` immediately ahead of this request, whatever
        ``evalens.resetOnLoad`` says -- see `evaluateFile` in
        `src/evaluate.ts`. It has to be unconditional there, because the
        command exists to answer whether the file matches what ``python3
        file.py`` would do, and a namespace carrying an earlier run's
        leftovers makes that comparison meaningless. An ordinary load reset
        is what the setting actually governs, and it is the same one-line
        wiring: a `reset` request ahead of this one, sent or not sent by the
        extension, never by this method.

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

        For a whole-file request, the response also carries ``residue``
        (#100): the namespace's own names, after this load, that nothing in
        the file just read binds. See the comment above where it is built.
        """
        source: str = request.get("source", "")
        filename: str = request.get("filename") or "<evalens>"
        allow_stdin = bool(request.get("allow_stdin"))
        # Evalens: Run File as Script (#78). Absent or false is every load
        # there has ever been; see `_as_module` for what true changes.
        as_script = bool(request.get("as_script"))
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
        forms = forms_in(parsed.tree, selection, source=source)

        results = []
        ran = 0
        # Resolved once for the whole load rather than per statement: every
        # statement in one request is answering the same keypress, so they had
        # better be shown on the same terms.
        limits = _limits(request)
        compiler_flags = _future_flags(parsed.tree)
        # Once for the whole load rather than once per statement: the imports
        # at the top of a file and the function bodies further down that import
        # lazily are the same file, and get the same name and the same path.
        with self._as_module(filename, as_script=as_script):
            for index, form in enumerate(forms):
                # Prompts if the caller allowed it, exactly as a single
                # evaluation does. The flag is the caller's decision either
                # way; nothing about running many statements makes the person
                # watching them go away.
                outcome = self._run(form, filename, allow_stdin=allow_stdin,
                                    compiler_flags=compiler_flags,
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
        if selection is None:
            # #100: what the namespace holds after this load that the file
            # just read does not bind anywhere in its own text -- residue an
            # earlier load, of this file or another, left behind. `#99`
            # defaults to resetting before a whole-file load, which is why
            # this is usually empty; it is the signal for whoever turned that
            # off, or for the (also unconditionally reset) script run.
            #
            # Judged against `forms`, the statements the parser found, rather
            # than `results`, the ones that actually got to run: a name is
            # "in the file" whether or not this particular pass reached the
            # statement that binds it, and residue is a property of the text
            # on screen, not of how far an interrupted or broken load got.
            # `form.binds` is computed statically and costs nothing to read
            # again here; see `resolver.py`.
            #
            # Restricted to a whole-file request on purpose. A selection is a
            # narrower question -- "run this part of my file" -- and nearly
            # everything in the namespace would look like residue against a
            # selection of three lines, which is not the fact this exists to
            # report.
            bound_names: set = set()
            for form in forms:
                bound_names.update(form.binds)
            residue = sorted(
                name for name in self.namespace
                if name not in _KERNEL_OWNED_NAMES and name not in bound_names
            )
            if residue:
                response["residue"] = residue
        return response

    def evaluate_above(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """Run everything strictly above the statement the cursor is in.

        Evaluating line 40 needs lines 1-39 to have run, and the only way to
        get there one statement at a time is to evaluate them one at a time.
        This is the command that does it in one press -- and it is a command
        rather than something `evaluate` falls back to automatically, because
        nothing here runs that the user did not explicitly ask this specific
        key to run. See issue #13.

        **Where "above" stops.** `forms_in(parsed.tree, None)` is the whole
        parsed module body in source order, the same call `evaluate_file`
        makes with no selection, and `_above_boundary` finds the first form
        in it whose own last line reaches the cursor -- the boundary form,
        which is the statement the cursor sits in or would sit in. Everything
        strictly before it runs; the boundary form itself never does, because
        it is what Evaluate at Cursor is for, not this command. Run-above
        sets up context; it does not also perform the evaluation the cursor
        is pointing at. A cursor on or before the first statement finds that
        statement as the boundary and runs nothing. A cursor past the last
        statement, or sitting below a break `parse_prefix` already cut the
        tree around, matches no boundary at all, and every parsed form counts
        as "above" -- which is the same answer `evaluate_file` gives a broken
        file: run what parsed, report the rest through `partial`.

        `character` is not read from the request. A top-level form's span
        already decides the boundary; see `form_at`'s own comment for why
        sub-expression resolution is the only thing that would need it.

        **The namespace is reset first, unconditionally.** A partial run's
        entire value is that the namespace afterward matches what running the
        file from the top through the cursor would produce -- the same
        requirement `docs/development/namespace-reset.md` (#56) settles for a
        full-file run, which #99 is implementing separately for `Evaluate
        File` and which `Run File as Script`'s own code has not yet caught up
        to (its docstring above still says it does not reset). `eval_above`
        does not wait on either: it is a new command with no prior "don't
        reset" behaviour to preserve, so it resets unconditionally and with
        no setting to skip it. Without the reset, a binding left over from an
        earlier keypress could masquerade as something this run of the file
        itself defined, which is exactly the ordering-and-state confusion
        this command exists to remove.

        **Failures stop the run, unlike `evaluate_file`.** A load runs
        through failures on purpose, because a file being explored is
        expected to contain broken lines. `eval_above` is building a
        namespace on the way to a specific line, and continuing past a
        failure would build one whose contents nobody can reason about -- so
        the loop stops at the first outcome that is not ok, whether that is
        an ordinary exception or an interrupt, and nothing after it is
        attempted. `results` therefore holds only the outcomes actually
        attempted -- up to and including the failure, if there was one --
        never a placeholder for what came after. `statements` is still the
        total number of forms found to be above the cursor, matching
        `evaluate_file`'s `len(forms)` convention, so a caller can tell a
        stopped-early run from a completed one by comparing it against
        `len(results)`; unlike `evaluate_file`, `ran + failed` need not equal
        `statements` here.

        **Streaming is identical to `evaluate_file`'s.** Each attempted
        outcome is announced on the control channel as `{"op": "statement",
        "id": request_id, "index": index, "outcome": outcome}` before the loop
        decides whether to stop, so the extension can paint line 1's value
        before line 30 is even attempted, and can tell a load apart from a
        run-above only by which request the frame's `id` answers.
        """
        source: str = request.get("source", "")
        filename: str = request.get("filename") or "<evalens>"
        line: int = request.get("line", 0)
        allow_stdin = bool(request.get("allow_stdin"))
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

        forms = forms_in(parsed.tree, None, source=source)
        above = forms[:_above_boundary(forms, line)]

        # A partial run's whole premise is a namespace matching a run from
        # the top through the cursor -- see the docstring above. That premise
        # fails quietly if whatever an earlier keypress bound is still here.
        self.reset()

        results = []
        ran = 0
        limits = _limits(request)
        compiler_flags = _future_flags(parsed.tree)
        with self._as_module(filename):
            for index, form in enumerate(above):
                outcome = self._run(form, filename, allow_stdin=allow_stdin,
                                    compiler_flags=compiler_flags,
                                    limits=limits)
                results.append(outcome)
                control({
                    "op": "statement",
                    "id": request_id,
                    "index": index,
                    "outcome": outcome,
                })
                if outcome["ok"]:
                    ran += 1
                else:
                    # Unlike `evaluate_file`: any failure stops the run here,
                    # not only an interrupt, because a namespace built past a
                    # failure is one nobody can reason about. `_was_interrupted`
                    # would also be true for a Cancel, but it is not what
                    # decides this branch -- an ordinary exception stops the
                    # run exactly the same way.
                    break

        response: Dict[str, Any] = {
            "ok": True,
            "statements": len(above),
            "ran": ran,
            "results": results,
            **partial,
        }
        if above:
            # The span of what was actually attempted, not of `above` as a
            # whole -- a stopped-early run's last attempt is `results[-1]`,
            # which may be well short of `above[-1]` when it stopped.
            last = above[len(results) - 1]
            response["range"] = {
                "start": _position(above[0].start_line, above[0].start_char),
                "end": _position(last.end_line, last.end_char),
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
                for form in forms_in(tree, source=source)
            ],
        }

    def inspect_value(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """One level of a value's children, for an explorer's hover and its
        drill-down command (#23).

        The value is never evaluated to get here. ``name`` is a namespace
        key -- a dictionary lookup, on the same footing as reading a bare
        name back for a loop target (#68) -- and every entry in ``path``
        below it is one of the two accesses ``_walk_step`` performs, neither
        of which can run anything a class defines. See the module note above
        ``INSPECT_CHILD_LIMIT`` for the whole of why that is true.

        Nothing here extends what the namespace already keeps alive: the
        root has to be bound there before this can be asked about it, and
        every child handed back is a reference already reachable through
        that same binding, never copied or cached anywhere new. That is the
        constraint the ticket's own discussion settled on in place of a
        cache keyed by evaluation -- see the comments on #23 about IPython's
        ``Out`` and the memory it is documented to pin.

        Travels on the request channel, exactly like ``eval``: while a
        statement is running, an ``inspect`` sent to hover a *previous*
        result waits behind it rather than being serviced early. Jupyter's
        own introspection shares this limitation for the same structural
        reason -- one reader on the channel a busy kernel is not reading --
        and fixing it needs the second, non-queued channel the ticket's
        discussion sketches for interrupt and stdin, which is out of scope
        here.
        """
        name = request.get("name")
        path = request.get("path")
        if not isinstance(name, str) or not name.isidentifier():
            return _inspect_error(
                "InvalidRequest", "name must be a bare identifier")
        if path is None:
            path = []
        if not isinstance(path, list):
            return _inspect_error("InvalidRequest", "path must be a list")
        value = next((child for key, child in dict.items(self.namespace)
                      if type(key) is str and key == name), _MISSING)
        if value is _MISSING:
            return _inspect_error("NotFound", f"{name!r} is not bound")

        for step in path:
            value = _walk_step(value, step)
            if value is _MISSING:
                return _inspect_error(
                    "NotFound", "that value is no longer there")

        text, raw = passive.text(value, WIRE_REPR_LIMIT), None
        children, total = _children_of(value)
        result: Dict[str, Any] = {
            "ok": True,
            "type": _type_name(value),
            "value": text,
            "children": children,
            "count": total,
            "truncated": total > len(children),
        }
        if raw is not None:
            result["repr"] = raw
        return result

    # -- internals ----------------------------------------------------------

    def _run(self, form: Form, filename: str,
             allow_stdin: bool = False,
             limits: Optional[Dict[str, int]] = None,
             watches: Optional[
                 Dict[loops.LoopKey, List[Tuple[str, ast.expr]]]] = None,
             compiler_flags: int = 0
             ) -> Dict[str, Any]:
        limits = _DEFAULT_LIMITS if limits is None else limits
        node, recorders, comp_recorders = _instrumented(
            form.node, limits["loop_values"], watches)
        if form.captured:
            # An assignment to an attribute or a subscript. The value has to
            # come from the statement, because the only other way to it is
            # through the user's own getter. See `_capturing`.
            node = _capturing(node)
        statement = ast.Module(body=[node], type_ignores=[])
        shown: Optional[str] = None
        raw_repr: Optional[str] = None
        table: Optional[Dict[str, Any]] = None
        loop: Optional[Dict[str, Any]] = None
        bindings: list = []
        names: list = []
        more_names = 0
        # `_instrumented` never returns both: a statement is either the loop
        # the user pointed at, or something searched for comprehensions, never
        # both. So whichever list came back non-empty is what `installed`
        # needs to make reachable from the rewritten code.
        active_recorders = recorders or [trace for _, trace in comp_recorders]

        with _user_io(allow_stdin, _located(form), form=form,
                     filename=filename) as (out, err, stdin_stub):
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
                    #
                    # `node.value`, not `form.node.value`: a bare comprehension
                    # statement -- `[x**2 for x in range(10)]` on its own line
                    # -- is an `Expr`, and `node` is where `_instrumented`
                    # put its rewrite. Reading the value back off the
                    # untouched original would run the comprehension the user
                    # wrote instead of the one wrapped to report on itself,
                    # silently dropping the trace this whole branch exists to
                    # obey the same off switch for.
                    expression = ast.Expression(node.value)
                    with loops.installed(self.namespace, active_recorders):
                        value = eval(  # noqa: S307 - evaluating user code is the product
                            compile(expression, filename, "eval",
                                    flags=compiler_flags,
                                    dont_inherit=True), self.namespace)
                    if form.display is not None:
                        shown, raw_repr, table = wire_value_and_table(value)
                    # A docstring is the one expression statement the resolver
                    # declines to display. It still runs, and the region
                    # highlight still says so; what it must not do is restate
                    # a module's opening paragraph back at its author with the
                    # newlines escaped.
                else:
                    with loops.installed(self.namespace, active_recorders):
                        with _Capture(self.namespace, form.captured) as kept:
                            exec(compile(statement, filename, "exec",
                                         flags=compiler_flags,
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
                        # #48. `recorders` holds one trace per instrumented
                        # loop, outer first, and a watch may be filed against
                        # any of them -- `evaluate_watch` attaches it to
                        # whichever loop `loops.innermost_loop_at` found, not
                        # necessarily the outermost one `recorders[0]` is.
                        # Every recorder is checked for that reason, even
                        # though only `recorders[0]`'s own target and body
                        # bindings are ever shown above: the user pointed at
                        # this expression specifically, wherever it was
                        # nested, and losing it silently would be #48's
                        # entire mechanism built for nothing.
                        shown_names = {b["name"] for b in bindings}
                        for trace in recorders:
                            if not trace.watches:
                                continue
                            # Sent under the same shape a body binding
                            # already uses -- `{name, values, last, count}`
                            # -- because a nominated expression's sequence is
                            # the exact rendering #48 asks for: "another
                            # name: value pair on the loop's header line".
                            # `name` here is the expression's own source text
                            # rather than an identifier, which the wire
                            # already allows: it is an opaque label to every
                            # consumer of this array, never parsed back into
                            # anything.
                            #
                            # A nomination that spells exactly the name of a
                            # body binding already on the line -- `total`,
                            # say, when `total += x` already reports one --
                            # is not a second fact: both read the same name
                            # at the same point in the same iteration, so the
                            # two sequences are identical, and painting them
                            # side by side would be the "value repeated on
                            # consecutive lines" design rule 2 already rules
                            # out, one line narrower. The existing binding
                            # already answers what was nominated, so the
                            # watch adds nothing and is left out; it is not
                            # lost, since `evaluate_watch`'s caller nominated
                            # a name that was already going to be shown.
                            for entry in trace.watches_wire():
                                if entry["name"] in shown_names:
                                    continue
                                bindings.append(entry)
                                shown_names.add(entry["name"])
                            _report_watch_failures(trace, err)
                    elif kept.value is not _NOTHING:
                        # What the assignment stored, taken as it stored it.
                        # `acct.balance` is never read: the annotation reports
                        # the value the line put there, which it can do
                        # without asking the object anything.
                        shown, raw_repr, table = wire_value_and_table(
                            kept.value)
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
                        shown, raw_repr, table = self._read_back(
                            form, filename)
                    else:
                        # A star import is the one statement with no display
                        # that still has something to say, and what it says
                        # comes from the module it pulled from rather than
                        # from anything on the line. Everything else here
                        # answers None and paints nothing, as before.
                        shown = _star_import(form.node)

                if comp_recorders:
                    # A comprehension's own trace: what each `for` clause drew,
                    # appended after whatever the statement's value slot
                    # already holds. `bindings` rather than `loop`, on purpose
                    # -- the renderer displaces `value` with `loop`, and
                    # `squares: [0, 1, 4, ...]` is the answer, not something to
                    # replace with `x: 0, 1, 2, ..., 9`. The two sit side by
                    # side exactly as a `for` loop's body binding already does
                    # beside its target, which is the rendering this reuses
                    # rather than a new one. Never filtered by count: a clause
                    # that drew nothing is itself the lesson -- see
                    # `loops.comprehension_traces` and #75.
                    bindings = [*bindings,
                                *(trace.named_wire(label)
                                  for label, trace in comp_recorders)]

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
                failure: Dict[str, Any] = {
                    "ok": False,
                    "error": _error(exc, tb_skip=1),
                    "kind": form.kind,
                    "range": _range_of(form),
                    **_anchor_of(form),
                    **_dependencies_of(form),
                    "stdout": out.getvalue(),
                    "stderr": err.getvalue(),
                }
                if stdin_stub.log:
                    # A read can succeed and the statement still fail
                    # afterwards -- `int(input("Age: "))` on a non-numeric
                    # reply -- and what answered the read is worth keeping
                    # even though the statement raised.
                    failure["stdin"] = list(stdin_stub.log)
                return failure

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
        if stdin_stub.log:
            # Absent when the statement never read anything, in line with
            # every other conditional field here. Present, it says what
            # answered each `input()` call and whether the answer was typed
            # just now, replayed from this statement's last run, or read off
            # its own `# evalens:` comment -- see #86.
            outcome["stdin"] = list(stdin_stub.log)
        if raw_repr is not None:
            # Only when a description replaced it: sending it unconditionally
            # would double the width of every large value on the wire to say
            # the same thing twice.
            outcome["repr"] = raw_repr
        if form.is_binding:
            # Present only when true, on the same terms as `loop`'s own
            # `constant`: absence is the ordinary case, a plain expression
            # statement, and costs nothing to say nothing about. What this
            # says is what `resolver.Form.is_binding` says -- `display` names
            # a place this statement bound, whether or not that place is a
            # bare name -- so a renderer can label `led['a']: 1` without first
            # asking whether `led['a']` looks like an identifier (#81).
            outcome["is_binding"] = True
        if table is not None:
            # Present only for the shapes `tabular.describe` recognises, and
            # computed from this same value at this same moment -- never a
            # second lookup. See the module docstring's `table` section.
            outcome["table"] = table
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
        if (outcome["value"] is None and form.kind == "If"
                and self.namespace.get("__name__") != "__main__"
                and _is_main_guard(form.node)):
            # #78's minimum, done regardless of whether the rest of the ticket
            # landed. The guard is checked against `self.namespace["__name__"]`
            # as it actually stands, not assumed False, because it is not
            # always False: `_module_name` answers `"__main__"` on its own for
            # a file literally named `__main__.py`, and there this branch
            # correctly stays quiet -- the guard already fires, exactly as
            # `python -m thatpackage` would make it. Everywhere else it is
            # dead, and its body ran nothing, and until now nothing on the
            # wire said so. The line looked exactly like an `If` with nothing
            # to report, which is what every other empty `If` looks like, and
            # a first-year reader has no way to tell "ran and had nothing to
            # show" from "did not run" apart. Same shape `_star_import`
            # already uses for a statement with a fact to report and no
            # target to hang it on.
            outcome["value"] = (
                "False -- not run as a script (Evalens: Run File as Script)")
        return outcome

    def _read_back(
        self, form: Form, filename: str
    ) -> Tuple[Optional[str], Optional[str], Optional[Dict[str, Any]]]:
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
            return None, None, None
        return wire_value_and_table(value)

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
