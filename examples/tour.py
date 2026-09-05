# Evalens tour -- the manual test fixture, and the file the demo is recorded
# from.
#
# Put the cursor on a line and press Ctrl+Enter (Cmd+Enter) to evaluate that
# form.  Ctrl+Alt+Enter (Cmd+Alt+Enter) loads the whole file in one step, and
# Escape clears the annotations.  Work top-down: the kernel remembers what you
# have run and nothing else, so a case that names something from further up
# wants that line run first.
#
# Cases 1-10 are the tour proper -- short, visual, in the order the demo shows
# them.  From 11 on it is coverage: one case for every row of the
# statement/display table in `kernel/resolver.py`, plus the values and the
# statement shapes that have broken the renderer or the resolver before.
# Every case says what it is there to prove.
#
# This is also an ordinary Python file.  `python3 examples/tour.py` runs top
# to bottom, prints a handful of lines and exits 0 -- and never stops to ask
# you anything, which case 2a explains.  Nothing here imports anything from
# outside the standard library, on purpose: the tour has to work against
# whatever interpreter the user happens to have selected, with no environment
# to set up first.

# 0. A module docstring, which must annotate NOTHING.  It is the first
#    statement in the file and therefore the first thing the extension has an
#    opinion about on load; restating it back at its author with the newlines
#    escaped is worse than the original and is the one value nobody could
#    want.  The region still highlights, because it did run.  Case 8's bare
#    `'the value'` is the other half of the rule: an identical statement out
#    of docstring position is someone looking at a literal, and still answers.
"""The tour's own docstring, which no annotation should ever repeat."""

# 1. An `import` shows the name it actually binds, which is not always the
#    name written: `import os.path` binds `os`, and an `as` clause binds the
#    alias rather than the module.  Both `import` shapes and both
#    `from ... import` shapes are here, and every one of them is used further
#    down, so none of them can quietly rot.
import contextlib
import io
import json as encoder
import os.path
import sys
from decimal import Decimal
from types import SimpleNamespace as Record


# ----------------------------------------------------------------- the tour --

# 2. The example IDEA.md opens with.  Run these four lines in order: the point
#    is that `lst` and `y` are the same list, which the third line proves and
#    the fourth line shows.  Seeing it needs no print() and no breakpoint.
#
#    `y.append(4)` is also the shape every mutating method in Python has: it
#    changed `y` and returned nothing.  It annotates `y: [1, 2, 3, 4]` rather
#    than `=> None`, and the None it produced is on the hover.
lst = [1, 2, 3]
y = lst
y.append(4)
lst

# 2a. `input()` asks -- and, one case down, deliberately does not.  Put the
#     cursor on the `if` below and press Ctrl+Enter: a box opens carrying the
#     prompt text, and what you type comes back as the value of `answer`.
#     Press Escape at that box instead and you get EOFError, which is the way
#     out rather than a dead end.
#
#     Now try Evaluate File over the whole tour.  This case does NOT prompt:
#     it raises EOFError and paints red, because loading a file asks the
#     kernel not to prompt at all.  A teaching file with twenty `input()`
#     calls would otherwise stop dead on the first one waiting for a human --
#     the opposite of what a command called "load this file" is for -- and
#     twenty modal boxes in a row is not the better version of that.
#
#     The guard is `__name__` rather than `sys.stdin.isatty()`, which is worth
#     a sentence because the obvious choice is the wrong one here.  Evalens
#     hands evaluated code a stdin that is deliberately not a terminal, so
#     isatty() answers False exactly where you *do* want to ask, and True in
#     the plain `python3 examples/tour.py` run, where stopping to wait for a
#     human would hang the script.  `__name__` is `"__evalens__"` under
#     Evalens and `"__main__"` as a script -- the same fact case 52 turns on.
if __name__ == "__evalens__":
    answer = input("Enter a value: ")
    print("You entered:", answer)

# 2b. Several names on one line, which is what most lines of a real file
#     need.  Neither of these two statements has a value worth showing --
#     `print` returns None -- and both of them are the reason the file exists:
#     `x` was rebound and `y` was not, and the annotation is where you read
#     that.  This is the case one-value-per-statement had nothing to say
#     about.
print('after mutating y, lst is:', lst)
print('and y is still the same object:', y)

# 2c. Output shows up while a loop runs, not in a lump once it finishes.
#     Evaluate this `while` and watch the Evalens output channel: each tick
#     appears as it is printed, because the kernel sends what user code writes
#     as it writes it rather than holding the lot until the statement returns.
#     A loop that reports its progress only reads as progress if the report
#     arrives while it is still going.
#
#     The line itself annotates nothing, for the reason case 20 gives: a
#     `while` has no target to point at.  The output channel is the whole of
#     what this case has to show.
ticks = 3
while ticks > 0:
    print("tick", ticks)
    ticks -= 1

# 3. A value keeps its internal spacing.  VS Code collapses ordinary spaces in
#    decoration text, so this dict renders as one word unless the renderer
#    substitutes non-breaking spaces -- which is what this line is here to
#    catch.
config = {'host': 'localhost', 'port': 8080, 'debug': True}

# 4. A comprehension, and an assignment whose value is None.  `list.append`
#    returns None, so `noise` is the case where there is a value to show and
#    it happens to be nothing.
squares = [x ** 2 for x in range(5)]
noise = lst.append(99)

# 5. A cursor anywhere inside this def evaluates the WHOLE def, Calva-style,
#    and the annotation shows the bound name.  Try the `scaled` line: an inner
#    expression would raise NameError, because `w` and `h` do not exist at
#    module level.  Redefining a function while poking at it is the reason to
#    resolve outward rather than inward.
def area(w, h):
    scaled = w * h
    return scaled


area(3, 4)


# 6. A decorator line resolves to its function rather than to nothing.
#    `FunctionDef.lineno` points at the `def`, so a cursor on the `@shout`
#    line falls outside the node's own span and needs the start widened.
def shout(fn):
    return lambda: fn().upper()


@shout
def greeting():
    return 'ok'


greeting()

# 7. A multi-line statement resolves from any of its lines, and the evaluated
#    region highlight covers all four.  Try each line in turn.
total = sum([
    10,
    20,
])

# 8. print() output is captured and attributed to the statement that produced
#    it; the value is still the value.  The first line annotates None and puts
#    its text in the output channel, the second annotates the string.
print('printed to stdout')
'the value'

# 9. The deliberate failure, and the reason for keeping one.  Evaluating this
#    paints a NameError in the error colour, and loading the file does not
#    stop here -- every case below still gets a value.  A load that abandoned
#    the rest of the file at the first bad line would refuse to set up a
#    session in exactly the file you opened the tool to debug.
#
#    It is behind a guard so that `python3 examples/tour.py` still exits 0.
#    Under Evalens `__name__` is `"__evalens__"`, so the branch is taken and
#    the line runs; run as a script it is skipped.  That is the same fact the
#    `__main__` guard at the foot of the file depends on, seen from the other
#    side.
if __name__ != "__main__":
    undefined_name

# 10. A blank line resolves to nothing at all, and says so in the status bar
#     rather than running the nearest statement instead.  The line below this
#     comment is that blank line.
#
#     Then the staleness demo, which takes four keystrokes.  Type a character
#     on any annotated line: the value STAYS, and the marker in the gutter
#     beside it breaks in two -- the kernel still holds what it holds, and now
#     the file says so.  Undo it: still broken, because undo told the kernel
#     nothing and only an evaluation may claim the two agree again.  Evaluate
#     the line: whole bar.  Press Escape and every annotation goes.
#
#     Reindent the line instead of editing it, or leave a trailing space, and
#     nothing changes -- a marker that goes amber for a formatter is a marker
#     nobody reads.


# ----------------------------------------------------------------- bindings --

# 11. A chained assignment has two targets; the annotation shows the
#     left-most, which is where the eye lands.
first = second = 'both'

# 12. A tuple target is shown whole, so unpacking reads as one value rather
#     than as the first name only.
low, high = 1, 100

# 13. A starred target survives the round trip through unparsing, and is the
#     one row of the table where reading the display expression back is not
#     faithful: `(head, *rest)` re-splats, so the annotation says
#     `(1, 2, 3, 4)` where the binding is `head = 1, rest = [2, 3, 4]`.  The
#     case is kept precisely because it is wrong today (#38).
head, *rest = [1, 2, 3, 4]

# 14. Subscript and attribute targets are shown as written.  Displaying
#     `shelf` or `spot` instead would hide the thing that just changed, and
#     re-running the right-hand side to find out would run it twice.
shelf = {'jam': 1, 'tea': 2}
shelf['jam'] = 99

spot = Record(x=1, y=2)
spot.x = 10

# 15. An annotated assignment shows its target, not its annotation.
budget: int = 500

# 16. An augmented assignment shows the target after the update, which is the
#     only interesting moment for `+=`.
budget += 25

# 17. A walrus binds inside an expression, and the expression statement is
#     evaluated exactly once -- so `step` is 3 and the annotation is 3, not a
#     second increment of something.
(step := 3)


# ------------------------------------------------ statement kinds that bind --

# 18. A `for` shows its target, which after the loop holds the last value it
#     took.  That is the most informative thing a loop leaves behind, and it
#     is why a `for` annotates at all.
for index in range(3):
    pass

# 18a. What the loop COMPUTED, beside what it was handed.  `v` is the input
#      being iterated and `u` is the result, and both change on every
#      iteration -- so `v: 1, 2, 3   u: 4, 8, 12` is the annotation, where it
#      used to be `v: 1, 2, 3   u: 12`.  One value beside a history reads as
#      that history's last entry, and it was the half of the line the reader
#      came for.
inputs = [1, 2, 3]
for v in inputs:
    u = 4 * v

# 18b. The same thing with a `continue`, where the two sequences are
#      deliberately NOT the same length: five iterations, two results, because
#      an iteration that skipped out early computed nothing to report.
#      Padding `kept` out to five entries would be inventing observations, so
#      the annotation says `n: 1, 2, 3, 4, 5   kept: 4, 8`.
for n in [1, 2, 3, 4, 5]:
    if n % 2:
        continue
    kept = n * 2

# 18c. A body binding that never changes is shown once rather than as
#      `limit: 10, 10, 10`.  Three readings of one fact would crowd out the
#      sequence beside it that is actually moving.
for step in range(3):
    limit = 10
    reached = step * limit

# 19. A tuple loop target is shown whole, the same as a tuple assignment.
for key, value in shelf.items():
    pass

# 20. A `while` binds names in its body but has no target to point at, so it
#     runs and annotates nothing.  That is a real answer rather than a
#     failure: the region highlights, no value is painted.
countdown = 3
while countdown:
    countdown -= 1

# 21. A `with ... as` shows the name it bound.  The buffer is closed by the
#     time the annotation is read, which is the honest state of it.
with io.StringIO() as sink:
    sink.write('captured')
    captured = sink.getvalue()

# 22. A `with` and no `as` binds nothing, so there is nothing to show.  The
#     lookup inside raises and is swallowed by the context manager, which is
#     the statement working, not failing.
with contextlib.suppress(KeyError):
    del shelf['coffee']


# 23. A `def` shows the name it bound.  Evaluating it again after an edit
#     rebinds the name in the live namespace, which is the whole reason to
#     evaluate a definition rather than restart a process.
def halve(n):
    return n / 2


# 24. An `async def` binds a name the same way.  Defining it is safe with no
#     event loop anywhere; nothing here calls it.  `async for` and `async
#     with` can only appear inside one of these, so they are never top-level
#     forms and are covered here rather than as cases of their own.
async def drain(stream):
    async with stream as opened:
        async for chunk in opened:
            return chunk


# 25. A `class` shows the name it bound, and a cursor on any line of the body
#     -- the docstring, `dimensions`, either method -- resolves to the whole
#     class.  Evaluating half a class body would leave a broken type behind.
class Point:
    """A point, and a class body to put the cursor inside."""

    dimensions = 2

    def __init__(self, x, y):
        self.x = x
        self.y = y

    def __repr__(self):
        return 'Point({}, {})'.format(self.x, self.y)


origin = Point(0, 0)


# 26. A decorator stack resolves from any of its lines to the function
#     underneath, and the decorators apply in the usual order: `exclaim`
#     first, then `shout`.
def exclaim(fn):
    return lambda: fn() + '!'


@shout
@exclaim
def chant():
    return 'ok'


chant()


# 27. A decorated class, with a decorator that has a side effect.  `registry`
#     showing exactly one entry after a load is the check that a definition is
#     executed once and not once per annotation -- the double-execution defect
#     is invisible against a decorator that only returns its argument.
registry = []


def register(cls):
    registry.append(cls.__name__)
    return cls


@register
class Widget:
    pass


registry


# 28. A nested function and a `nonlocal`.  A cursor on the `nonlocal` line
#     resolves to the outer `def`, because that is the top-level statement
#     containing it; the inner one is not separately evaluable.
def make_counter():
    count = 0

    def bump():
        nonlocal count
        count += 1
        return count

    return bump


counter = make_counter()
counter()

# 29. A `global`, likewise reached through the def that contains it.  The
#     kernel's namespace is one dict used as both globals and locals, so a
#     `global` declaration finds the module-level name a cursor evaluation
#     bound earlier.
tally = 0


def add_to_tally(n):
    global tally
    tally += n
    return tally


add_to_tally(5)
tally


# ------------------------------------------ statements with nothing to show --

# 30. An `if` runs and shows nothing.  There is no target and no expression
#     worth calling the statement's value.
if budget > 100:
    tier = 'large'
else:
    tier = 'small'

# 31. A `del` runs and shows nothing -- the name it names is gone, so showing
#     it would be a NameError dressed up as a result.
scratch = 'temporary'
del scratch

# 32. A bare `pass` is the smallest statement that runs and produces nothing.
pass

# 33. An `assert` that holds produces nothing.  It is here because an assert
#     is the one statement whose whole purpose is to have no value.
assert 1 + 1 == 2

# 34. A `raise` caught by its own `try` produces nothing, and must not be
#     reported as a failure: the statement did exactly what it says.
try:
    raise ValueError('handled')
except ValueError as caught:
    handled = str(caught)


# ------------------------------------------ values that stress the renderer --

# 35. None.  Falsy, and must still paint: a renderer that tests the value for
#     truthiness silently shows nothing here, which reads as a broken
#     evaluation rather than as a result.
nothing = None

# 36. An empty collection, falsy for the same reason and just as real a
#     result.
empty = []

# 37. A very long list.  The kernel caps what it puts on the wire; the
#     extension knows the editor width and truncates for reading.  This is the
#     line that shows whether one long value drags every other annotation off
#     the screen.
long_list = list(range(400))

# 38. A repr with newlines in it.  Decoration text is a single line, so this
#     is the case that proves newlines are flattened rather than swallowing
#     the rest of the value.
class Recipe:
    def __repr__(self):
        return 'Recipe(\n    flour=500,\n    water=350,\n)'


recipe = Recipe()


# 39. A repr that already contains non-breaking spaces.  Substituting spaces
#     for U+00A0 must be idempotent -- a value that arrives pre-joined should
#     not come out doubled or mangled.  A plain str cannot reach here, because
#     repr() escapes U+00A0 to \xa0; only a custom __repr__ can.
class Joined:
    def __repr__(self):
        return 'already\u00a0joined'


joined = Joined()


# 40. A cyclic structure.  repr() handles it itself, printing `[[...]]`
#     instead of recursing forever, and the renderer has to survive the
#     result rather than the recursion.
cycle = []
cycle.append(cycle)
cycle

# 41. An object whose __repr__ raises.  That is a bug in the user's code, not
#     a reason for the kernel to die and take a whole session's namespace with
#     it, so the annotation reports the failed repr and everything below still
#     evaluates.
class Grumpy:
    def __repr__(self):
        raise RuntimeError('__repr__ is user code too')


grumpy = Grumpy()

# 42. A string containing `=>`.  Calva writes its results after a `;;=>`
#     marker; anything that goes looking for that marker in a value finds one
#     here that is not one.
arrow = 'a => b'

# 43. A value full of quotes and braces, which is what any JSON-ish string
#     looks like and is where naive escaping shows up.
serialised = encoder.dumps(config)

# 44. A value whose repr is not its literal.  Decimal('0.3') is the answer;
#     0.30000000000000004 is what a float would have shown, and the annotation
#     is supposed to show the object, not a guess at it.
precise = Decimal('0.1') + Decimal('0.2')

# 45. A tuple, so the annotation is not always a scalar or a container
#     literal.
name_and_ext = os.path.splitext('tour.py')


# -------------------------------- statement shapes that stress the resolver --

# 46. Two statements on one line.  Both run when the file is loaded; a cursor
#     anywhere on the line resolves to the first of them, because a line is
#     all the position a cursor gives.  Kept as the fixture for the
#     column-aware resolution issue (#18).
left = 'a'; right = 'b'

# 47. A trailing comment is not part of the statement, so the evaluated region
#     must stop at the value and the annotation must not land on top of the
#     comment.
tail = 42  # the annotation has to share this line with me

# 48. A `#` inside a string is not a comment.  Anything that finds the end of
#     a statement by scanning for `#` truncates this one.
hashless = 'this # is not a comment'

# 49. A multi-line literal with a comment inside it, and a trailing comma.
#     Every one of these five lines belongs to one statement.
matrix = [
    [1, 2, 3],
    # a comment in the middle of a statement
    [4, 5, 6],
]

# 50. A multi-line call with keyword arguments, which is the shape most real
#     code is: the first line is not the statement, and the last line is not
#     either.
summary = dict(
    file=os.path.join('examples', 'tour.py'),
    registered=len(registry),
    tier=tier,
)

# 51. A def whose signature wraps.  Any of these six lines resolves to the
#     whole definition, the closing paren of the signature included.
def describe(
    subject,
    verb='is',
    obj='here',
):
    return '{} {} {}'.format(subject, verb, obj)


describe('the tour')


# ---------------------------------------------------------------- the guard --

# 52. What must NOT run on load.  Evalens loads a file the way `import` does,
#     and an imported module does not run its `__main__` block: `__name__` in
#     the kernel is `"__evalens__"`, so this condition is False and the body
#     is skipped.  The proof is here rather than only in a unit test because a
#     banner that never appears in the annotations is something a human can
#     check in one look -- and because a SystemExit that did run would be a
#     loud, obvious failure rather than a quiet one.
#
#     Running the file as a script is the other half of the proof: then the
#     block does run, prints, and exits 0.
if __name__ == "__main__":
    print("THIS SHOULD NEVER APPEAR ON LOAD")
    print("(as a script it should, and the exit below is the same idea)")
    sys.exit(0)
