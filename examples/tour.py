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
#
#    It is also the one case the stale markers cannot see, and it is here on
#    purpose.  Evaluating it leaves the `lst = [1, 2, 3]` annotation above
#    still reading `[1, 2, 3]` with an unbroken marker, because no statement
#    bound `lst` -- the list was mutated through another name.  Catching that
#    needs a runtime tracer rather than a parse, and a tracer is a 1.4x
#    slowdown on everything to fix a marker.  See case 10 for the half of
#    staleness that does work.
lst = [1, 2, 3]
y = lst
y.append(4)
lst

# 2a. `input()` asks, whichever way you run it.  Put the cursor on the `if`
#     below and press Ctrl+Enter: the line greys and says it is waiting, a box
#     opens carrying the prompt text, and what you type comes back as the
#     value of `answer`.  Press Escape at that box instead and you get
#     EOFError, which is the way out rather than a dead end.
#
#     Now try Evaluate File over the whole tour.  This case asks there too:
#     the load stops on this line, marks and scrolls to it, and continues once
#     you answer.  It used to refuse and paint red -- and refusing meant a red
#     EOFError here plus a NameError on every line below that wanted `answer`,
#     on exactly the kind of file the command exists to set up.  A file with
#     twenty prompts is a real worry, and it is answered by the box offering
#     to skip the rest from the second prompt on, not by refusing the first.
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
#     The line ends up saying `ticks: 0   printed: tick 3 …(3 lines)`: a
#     `while` has no target to point at, for the reason case 20 gives, so what
#     it shows is the name it changed and the summary of what it said.  Live
#     in the channel and summarised on the line are the same text arriving
#     twice on purpose -- one is the progress, the other is the record.
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

# 4a. A comprehension whose variable shadows one that already exists, which is
#     the classic scope exercise and was the classic wrong annotation.  `x`
#     below holds [1, 2, 3] and keeps holding it: in Python 3 a comprehension
#     runs in a scope of its own and its `x` never leaves it.  So the only
#     honest annotation here names `powers` and nothing else -- reporting `x`
#     would show an unrelated variable as though it were part of the line, and
#     a plausible-looking wrong value is worse than an empty column.  Evaluate
#     the last line to see that the outer `x` really is untouched.
#
#     The nested case shadows at two levels and must lose both targets.  What
#     the comprehension reads from outside is a different matter and is still
#     shown: `multiplier` on the fourth line is read from here, not bound
#     there, and it is the context that makes the line make sense.
x = [1, 2, 3]
powers = [x ** 2 for x in range(10)]
combos = [(x, y) for x in range(3) for y in range(2)]
multiplier = 10
scaled = [x * multiplier for x in (1, 2)]
x

# 5. A cursor anywhere inside this def evaluates the WHOLE def, Calva-style,
#    and annotates nothing -- which is the answer rather than the absence of
#    one.  `def area(w, h)` beside a line reading `def area(w, h):` says only
#    what the line says, so the region highlight reports that it ran and the
#    width goes to something that has news.  Case 6 is the def that does
#    annotate and says why.
#
#    Try the `scaled` line: an inner expression would raise NameError, because
#    `w` and `h` do not exist at module level.  Redefining a function while
#    poking at it is the reason to resolve outward rather than inward.
def area(w, h):
    scaled = w * h
    return scaled


area(3, 4)


# 6. A decorator line resolves to its function rather than to nothing.
#    `FunctionDef.lineno` points at the `def`, so a cursor on the `@shout`
#    line falls outside the node's own span and needs the start widened.
#
#    This is also the def that MUST annotate, where case 5 must not:
#    `greeting: def <lambda>()` says the decorator replaced the function with
#    something else entirely, and the line cannot show that.  It is why an
#    annotation is dropped by comparing it against its own line rather than by
#    recognising a `def` -- the shortcut would have deleted exactly this.
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

# 8. What a statement printed goes ON THE LINE.  This is the case the whole
#    project stands or falls on: for the reader this is written for, print()
#    is not one feature among many, it is the tool.  The first line annotates
#    `printed: printed to stdout` and the None it returned is suppressed --
#    something better is being shown -- while the second still annotates the
#    string, because it printed nothing and its value is the answer.
#
#    `printed:` rather than a bare `printed to stdout`, because annotating
#    with the text alone invites the reading that the expression EVALUATED to
#    it.  The label puts output in the same `name: value` grammar as
#    `lst: [1, 2, 3]` above, so there is nothing new to read.
print('printed to stdout')
'the value'

# 8a. Several lines cannot all fit on one, so the first leads and the count
#     says how much is not on screen -- `printed: line one …(3 lines)`.  Hover
#     for all three; they are in the output channel too, and they arrived
#     there while this was still running.  The elision is the same one a long
#     loop's sequence uses, for the same reason: a summary that did not say
#     how much it left out would read as the whole of it.
print('line one\nline two\nline three')

# 8b. A statement can bind AND print, and both are shown -- `warmed: 42`
#     first, then what it said on the way.  They answer different questions,
#     so neither displaces the other, and the binding leads because it is what
#     the statement did.
def warm_up():
    print('warming up')
    return 42

warmed = warm_up()

# 8c. stderr keeps its own name and is NOT painted as an error.  Writing to
#     stderr is not a failure -- a library logging a warning does it on a line
#     that worked perfectly -- and colouring it red would teach exactly the
#     wrong lesson.  `write` returns the number of characters, which is a real
#     value, so this line shows both: `=> 8   stderr: careful`.  (`sys` came
#     from case 1, which is why working top-down matters.)
sys.stderr.write('careful\n')

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
#
#     The other half of it is in case 2 and needs no editing at all: with all
#     four of those lines annotated, evaluate `lst = [1, 2, 3]` again.  The
#     `y = lst` line below it breaks its marker without its own text changing,
#     because it reads a name that line just rebound.  Nothing re-runs; the
#     value stays exactly as it was.  Case 2's third line is the case this
#     cannot see, and case 2 says why.


# ----------------------------------------------------------------- bindings --

# 11. A chained assignment has two targets; the annotation shows the
#     left-most, which is where the eye lands.
first = second = 'both'

# 12. An unpacking target is several bindings, not one, so the annotation
#     names each of them: `low: 1   high: 100`.  Showing the target whole gave
#     `=> (1, 100)`, which is the right-hand side read back -- already on the
#     line, and no answer to the question the reader has, which is which name
#     got which value.  The nested case binds every leaf.
low, high = 1, 100
outer, (inner, deepest) = 1, (2, 3)

# 13. A starred target names the list the star collected.  Reading the
#     unparsed target back gave `(1, 2, 3, 4)` instead, because `(head, *rest)`
#     as an expression re-splats: a faithful echo of the right-hand side and a
#     misleading picture of what is now in the namespace.
head, *rest = [1, 2, 3, 4]

# 13a. A swap, which is the case that shows these values are read out of the
#      namespace after the statement ran rather than by re-running anything.
#      There is no right-hand side here whose echo would say the same thing.
low, high = high, low

# 14. Subscript and attribute targets are shown as written, and the value
#     beside one is the value the statement stored -- kept as it was stored,
#     never read back.  Displaying `shelf` or `spot` instead would hide the
#     thing that just changed.
shelf = {'jam': 1, 'tea': 2}
shelf['jam'] = 99

spot = Record(x=1, y=2)
spot.x = 10

# 14a. Why that value is kept rather than read back, said out loud.  `Meter`
#      counts every read of `reading` and every `meter[...]`, so an
#      annotation that reads cannot hide: evaluate the three lines below the
#      class and `meter.reads` answers 0.  It answered 2 before, because the
#      annotation -- not the program -- had called the property and then the
#      `__getitem__`, and a getter is free to fetch, lazily load, pop a queue
#      or charge a card.  Nothing on screen said so, and the count the user
#      could then read was the extension's own footprint reported back as
#      their program's state.
#
#      Then the case with no safe answer.  `meter.reading += 1` calls the
#      getter itself, once, and leaves the sum inside the object with no way
#      back to it but the getter again -- so the line shows no value at all,
#      only `meter: <Meter instance>`, and the count under it reads 1, which
#      is the read the user's own `+=` made.
class Meter:
    def __init__(self):
        self._reading = 0
        self.slots = {}
        self.reads = 0

    @property
    def reading(self):
        self.reads += 1
        return self._reading

    @reading.setter
    def reading(self, value):
        self._reading = value

    def __setitem__(self, key, value):
        self.slots[key] = value

    def __getitem__(self, key):
        self.reads += 1
        return self.slots[key]


meter = Meter()
meter.reading = 7
meter['dial'] = 'lit'
meter.reads

meter.reading += 1
meter.reads

# 15. An annotated assignment shows its target, not its annotation.
budget: int = 500

# 15a. A bare annotation binds nothing at all -- it records a type and stops
#      -- so there is nothing to show beside it.  Reading `ceiling` back to
#      display it raised NameError, which painted the extension's own failure
#      in red beside a line that had run perfectly.
ceiling: int

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


# 23. A `def` rebinds its name in the live namespace when it is evaluated
#     again after an edit, which is the whole reason to evaluate a definition
#     rather than restart a process.  Nothing is painted, per case 5; the
#     region highlight is the report that it happened.
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


# 25. A `class` shows how to construct one -- `class Point(x, y)`, read off
#     `__init__` -- which is the question asked of a class and is not on the
#     header line.  A cursor on any line of the body, the docstring and either
#     method included, resolves to the whole class: evaluating half a class
#     body would leave a broken type behind.
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
