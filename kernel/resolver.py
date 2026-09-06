"""Resolve the form under a cursor: what to execute, and what to show.

This is the piece that makes Python behave like Clojure for the purposes of
inline evaluation. In Clojure "the current form" is unambiguous because
everything is parenthesised; here it takes real parsing, and `ast` has given
exact end positions since 3.8.

Two decisions shape everything below.

**The enclosing top-level statement is what executes.** A cursor inside a
function body evaluates the whole `def`, which is what Calva's "evaluate
top-level form" does and is what makes redefining a function while iterating
feel natural. Resolving to the innermost expression instead would usually
raise `NameError`, because the names it reads are the function's parameters
and do not exist at module level.

**Statements do not return values, so execution and display are separate.**
`x = [1, 2, 3]` returns nothing; what is worth showing is the value of the
*target*. The mapping from statement to displayable expression is most of
this module's substance, and it is why the kernel runs two steps rather than
one.

**The second step must not be an execution.** Writing the target beside the
line and *evaluating* it are different decisions, and treating them as one is
how `acct.balance = 100` came to run the user's property getter a second time
under the annotation. `_value_source` splits them: a target is read back only
where reading it is a namespace lookup, and an assignment whose target is not
hands over the value it stored instead.

**A statement's own value is not the only thing worth showing.** Most lines
in a real file are not bindings, and one value per statement has nothing to
say about them: `print("y unaffected by rebind:", y)` produced `None`, which
is true, useless and misleading beside the line whose whole point is `y`.
Rider annotates the *names on a line* and shows several, so `annotated_names`
reports what a statement binds and what it reads, and the kernel looks them
up in the namespace afterwards.

Coordinates in and out are VS Code's: 0-based line, 0-based character. `ast`
is 1-based for `lineno`, and the conversion happens here rather than in the
renderer -- an off-by-one next to the parser is much cheaper to find than one
three layers away.

A file that does not parse is still mostly a file, and `parse_prefix` is what
keeps one broken line from making every line unevaluable. It answers from as
much of the buffer as parses on its own, and says how much that was, because a
value computed without the rest of the file is not the same claim as one
computed with it.

Requires Python 3.9 or later, for `ast.unparse`.
"""

from __future__ import annotations

import ast
import re
from dataclasses import dataclass
from typing import List, Optional, Set, Tuple, Union


@dataclass(frozen=True)
class Form:
    """A resolved form: the statement to run, and the value worth showing."""

    node: ast.stmt
    kind: str
    display: Optional[str]
    start_line: int
    start_char: int
    end_line: int
    end_char: int
    #: The line the annotation belongs beside, which is the last line of the
    #: statement for everything except a compound one. Separate from the range
    #: on purpose: the range says how much code ran and still covers the whole
    #: statement, while this says where the answer is written.
    anchor_line: int
    #: Bare names this statement binds and then reads, in the order to show
    #: them, minus the ones `display` already accounts for. What they hold is
    #: the namespace's business, not the parser's.
    names: Tuple[str, ...] = ()
    #: The module-level names this statement binds, and the ones it reads.
    #: Nothing is displayed from these and nothing is looked up: they exist so
    #: the extension can decide which *other* annotations an evaluation just
    #: put out of date. See `defs_and_uses`.
    binds: Tuple[str, ...] = ()
    reads: Tuple[str, ...] = ()
    #: Whether the kernel *may* evaluate `display` once the statement has run,
    #: which is a question about safety and not about need. True only where
    #: doing so is a namespace lookup. False is not "nothing to show" -- an
    #: expression statement displays something the statement has already
    #: produced -- it is "do not run this again".
    #:
    #: Whether the kernel *should* is its own call and stays there: a loop
    #: whose target is a bare name is readable, and the kernel still reads it
    #: only when it installed no recorders, because a recorded sequence is a
    #: better answer than the value the target stopped on.
    readable: bool = False
    #: Whether the value beside `display` has to be taken as the statement
    #: stores it, because reading the target back would run the user's code.
    #: Exactly one of this and `readable` is ever true. See `_value_source`.
    captured: bool = False
    #: Whether `display` names a place this statement bound -- an assignment
    #: target, a loop variable, a `with ... as`, the name a `def` or `import`
    #: introduces -- as opposed to the value of a bare expression statement,
    #: which is the only case this is ever false while `display` is not None.
    #:
    #: A renderer that wants to lead with a binding and trail with a result
    #: needs this fact and does not otherwise have it: `led["a"] = 1` unparses
    #: `display` to `led['a']`, which is exactly as much a binding as `x` is
    #: for `x = 1`, and no less one for failing to look like a bare name (#81).
    #: Guessing from the text of `display` -- is it a bare or dotted
    #: identifier -- is the mistake this field replaces; the resolver already
    #: knows which statement it is looking at; a text pattern is a second,
    #: worse way of asking the same question, and the one that missed a
    #: subscript and an attribute target.
    is_binding: bool = False


#: Statements whose value belongs on the line that introduces them rather than
#: at the end of the code they contain.
#:
#: `def greet(name):` is where `greet` comes into existence and `for p in xs:`
#: is where `p` is bound, so a value written twenty lines below -- beside the
#: `return`, or beside the last line of a loop body -- reads as a claim about
#: that line instead. `greet: <function greet>` next to `return f"hello
#: {name}"` says the return statement produced a function, and `p: 16` next to
#: `print(p)` says `print` returned 16.
#:
#: Everything else keeps the end-of-statement anchor, because a multi-line
#: expression genuinely finishes where its value appears:
#:
#:     total = sum([
#:         10,
#:         20,
#:     ])                              total: 30
_HEADER_ANCHORED = (
    ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef,
    ast.For, ast.AsyncFor, ast.While,
    ast.With, ast.AsyncWith, ast.If, ast.Try,
)


def _first_bound_name(alias: ast.alias) -> Optional[str]:
    """The name an `import` actually binds, or None when there is not one.

    `import os.path` binds `os`, not `os.path` -- evaluating the latter as an
    expression happens to work, but the name the statement put in the
    namespace is the first segment, and that is what the user just created.

    `from pkg import *` binds a set of names decided at runtime by the
    exporting module's `__all__`, and there is no one name for the parser to
    find: the alias's name is the literal string `"*"`. Answering with it sent
    `*` to the kernel as the expression to display, where compiling it raised
    `SyntaxError: invalid syntax (<unknown>, line 1)` -- the extension's own
    failure, in red, beside an import that had worked, quoting a file and a
    line the user cannot go and look at.
    """
    if alias.name == "*":
        return None
    if alias.asname:
        return alias.asname
    return alias.name.split(".")[0]


def _pattern_names(target: ast.expr) -> Set[str]:
    """Every name a binding pattern puts in scope.

    A target is rarely just one name: `for k, v in d.items()` binds two, and
    `head, *rest` binds through a `Starred`. Walking the pattern is what makes
    both fall out of one rule instead of two special cases.

    `obj.attr` and `d[k]` deliberately contribute nothing. They bind into an
    object that already exists rather than creating a name, and the `obj` in
    front of them is a genuine read of the enclosing scope -- so answering
    "no names here" is what keeps that read reportable.
    """
    if isinstance(target, ast.Name):
        return {target.id}
    if isinstance(target, ast.Starred):
        return _pattern_names(target.value)
    if isinstance(target, (ast.Tuple, ast.List)):
        return {name for element in target.elts
                for name in _pattern_names(element)}
    return set()


def _only_names(target: ast.expr) -> bool:
    """Is reading this target back a namespace lookup and nothing else?

    The rule `_Names` states for the names a line reports, applied to the
    display slot -- which had been exempt from it, and that was #68. A bare
    name is a dictionary lookup that cannot run user code; `obj.attr` may be a
    property with a body, and `d[k]` calls `__getitem__`. Reading either back
    to annotate an assignment executes something the statement itself did not,
    which the explicit-trigger design exists to make impossible.

    A tuple or list of bare names is the same lookup several times over, so it
    passes: `with cm() as (a, b)` can be read back safely. `*rest` cannot,
    even though the name it binds is bare -- as an *expression* `(a, *rest)`
    iterates `rest` rather than showing it, and iterating is the user's code
    again as well as the wrong answer. `loops._load_copy` learned that one the
    same way.
    """
    if isinstance(target, ast.Name):
        return True
    if isinstance(target, (ast.Tuple, ast.List)):
        return all(_only_names(element) for element in target.elts)
    return False


def is_docstring(node: ast.stmt, first_in_body: bool) -> bool:
    """Is this statement a docstring rather than a value someone asked for?

    Positional, not "a string constant": a bare string that is *not* in
    docstring position is someone evaluating a literal to see it, and
    `"hello"` should still answer `=> 'hello'`. What makes a docstring
    different is where it sits, so that is what the rule tests.

    `first_in_body` is the caller's, because a statement does not know its
    parent. Today only a module's first statement can reach here -- a class or
    function docstring is inside a body that resolves to the whole definition
    -- but the rule is written for all three, so sub-statement resolution
    cannot reintroduce the case by accident.
    """
    return (
        first_in_body
        and isinstance(node, ast.Expr)
        and isinstance(node.value, ast.Constant)
        and isinstance(node.value.value, str)
    )


def _display_target(node: ast.stmt) -> Optional[Union[ast.expr, str]]:
    """What the statement produces, as a node -- or as a plain bound name.

    Split out from `display_expr` so the same table answers two questions: the
    source to show, and which names that source already accounts for. Deriving
    the second by re-parsing the first would be a second table pretending to
    be one.

    Answering with a target says what to *write* beside the line. It says
    nothing about how to find the value, which is `_value_source`: some of
    these are read back out of the namespace afterwards and some are not, and
    a target that cannot be read back safely is either captured as the
    statement stores it or dropped here.
    """
    if isinstance(node, ast.Assign):
        # `a = b = 1` has two targets; the first is the one written left-most
        # and is what the eye lands on.
        target = node.targets[0]
        if isinstance(target, (ast.Tuple, ast.List)):
            # `d1, d2 = {'a': 1}, {'b': 2}` is not one binding to display but
            # several, and the display slot holds one. Unparsed it reads
            # `(d1, d2)`, which is not an identifier, so it is not labelled
            # with and falls through to `=> ({'a': 1}, {'b': 2})` -- the
            # right-hand side echoed back, which is already on the line, while
            # the question the reader has (what is `d1` now?) goes unanswered.
            #
            # Leaving the slot empty hands the whole line to `annotated_names`,
            # which reports one `name: value` pair per bound name from the
            # namespace after the statement ran. That is the same rendering
            # several names on a line already use, so this is composition
            # rather than new display, and it stays a trace: nothing here is
            # re-evaluated to produce it.
            return None
        return target
    if isinstance(node, ast.AugAssign):
        # `n += 1` reads, computes and stores back, so its value exists only
        # in the namespace afterwards -- there is nothing for the statement to
        # hand over. Reading `counter.n` back would call the property a second
        # time, having already called it once for the `+=` itself, so an
        # augmented assignment to anything but a name shows nothing and lets
        # the object in front of the dot be reported as an ordinary name.
        return node.target if _only_names(node.target) else None
    if isinstance(node, ast.AnnAssign):
        if node.value is None:
            # `count: int` records an annotation and binds nothing at all, so
            # reading `count` back raised NameError on a line that ran
            # perfectly and painted the extension's own failure in red.
            return None
        # An annotated assignment to an attribute is not captured: the capture
        # works by adding a second target, and `AnnAssign` allows exactly one.
        # It is a rare enough shape at module level -- `self.x: int = 0` lives
        # inside a `def` -- that showing nothing costs less than moving when
        # the annotation is evaluated relative to the store.
        return node.target if _only_names(node.target) else None
    if isinstance(node, ast.Expr):
        return node.value
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
        return node.name
    if isinstance(node, (ast.Import, ast.ImportFrom)):
        # None for `from pkg import *`, which binds a set of names rather than
        # one and has nothing for the display slot. What it did bind is the
        # kernel's to report, from the module rather than from the parse.
        if len(node.names) > 1:
            # `import os, sys` and `from math import floor, ceil, sqrt` bind
            # several names, and the display slot holds one -- the same shape
            # as `d1, d2 = ...` above. Answering with `node.names[0]` reported
            # the first binding as though it were the statement's whole
            # value, and the ones after it went unmentioned: `from math
            # import floor, ceil, sqrt` annotated `def floor(x, /)`, and
            # `ceil` and `sqrt` were bound and never named.
            #
            # Leaving the slot empty hands the whole line to `annotated_names`
            # the same way an unpacking assignment does: `visit_Import`
            # already walks every alias in source order, so this is
            # composition rather than new display.
            return None
        return _first_bound_name(node.names[0])
    if isinstance(node, (ast.For, ast.AsyncFor)):
        # The target usually labels a sequence rather than a value: the kernel
        # records what it held on each iteration and reports all of them, and
        # `p` is what the reader is watching. Whether anything evaluates it
        # afterwards is `_value_source`'s answer and then the kernel's --
        # `for d[next(it)] in xs:` may never be read back, because that
        # advances the user's iterator a second time and then paints the
        # KeyError it caused, while `for p in xs:` may be and is only when
        # there is no recorded sequence to prefer to it. See `loops`, which
        # declines to instrument the first shape for the same reason.
        return node.target
    if isinstance(node, (ast.With, ast.AsyncWith)):
        for item in node.items:
            if item.optional_vars is not None:
                # `with open(p) as obj.attr:` binds through a descriptor whose
                # getter is the user's; only a name is read back. The first
                # `as` clause is the one the eye lands on, so a later one does
                # not stand in for it.
                return (item.optional_vars
                        if _only_names(item.optional_vars) else None)
        return None
    return None


def display_expr(node: ast.stmt, first_in_body: bool = False) -> Optional[str]:
    """The expression worth showing after `node` has run, as source.

    `None` means the statement runs but has nothing to display -- an `if`, a
    `del`, a bare `pass`. That is a real answer and not a failure; the caller
    highlights the region without painting a value.

    An unpacking assignment answers `None` for a different reason: it has
    several things to display rather than none, and `annotated_names` is where
    several go. See `_display_target`. A multi-name import is the same shape:
    `import os, sys` binds two names, not one, and `annotated_names` is where
    the second one gets named at all.

    A docstring is the one statement whose value is real and worth nothing:
    restating a module's opening paragraph back at its author, with the
    newlines escaped so it reads worse than the original, is the first thing
    the extension does on loading any well-documented file.
    """
    if is_docstring(node, first_in_body):
        return None
    target = _display_target(node)
    if target is None or isinstance(target, str):
        return target
    return ast.unparse(target)


def _value_source(node: ast.stmt,
                  target: Optional[Union[ast.expr, str]]) -> Tuple[bool, bool]:
    """Where the value beside `display` comes from: `(readable, captured)`.

    One function rather than two so the pair cannot disagree, and the whole
    rule in one place because it is the rule an annotation is only ever as
    safe as. **Nothing an annotation does may execute user code the statement
    did not.** Three answers satisfy it, and this picks between them.

    *Readable* -- evaluate `display` afterwards. Allowed only where that is a
    namespace lookup, which is a bare name or a tuple of them: the same test
    `_Names` applies to the names a line reports. A bound name from an
    `import` or a `def` arrives here as a plain string and is one of those.

    *Captured* -- an assignment whose target cannot be read back hands over
    the value it stored instead. The right-hand side has already been
    evaluated by the statement, so nothing runs twice, and `acct.balance: 100`
    is what the reader wanted from `acct.balance = 100` anyway. What it claims
    is that this is the value the line assigned, which is true even where a
    setter went on to transform it -- a read-back would have claimed to be the
    attribute's current value and, when the getter was not idempotent, would
    not even have been that.

    *Neither* -- the value is the statement's own doing and the kernel has it
    already: an expression statement is evaluated exactly once and never
    re-run, which was the first bug this project found.

    The question this does **not** answer is whether reading is the best
    available answer, and a loop is where the two come apart. `for i in xs:`
    is readable because `i` is a name, and the kernel still prefers the
    sequence its recorders collected -- reading is what it falls back to when
    the user turned `evalens.loopValues` off and there are no recorders. That
    call needs to know what actually ran and belongs in the kernel; all this
    can say is that looking `i` up would be a dictionary lookup, which is a
    fact about the parse. `for d[next(it)] in xs:` is the shape that made the
    distinction matter: it is not readable at all, because reading it back
    advances the user's iterator a second time.
    """
    if target is None:
        return False, False
    if isinstance(target, str):
        # A name an import or a definition bound, and nothing else reaches
        # here as a string.
        return True, False
    if isinstance(node, ast.Expr):
        return False, False
    if _only_names(target):
        return True, False
    # An attribute or subscript target, which only a plain assignment still
    # offers: every other statement kind has already answered `None` for one.
    # Anything that reaches here without a value to hand over shows nothing,
    # which is the answer that cannot be wrong.
    return False, isinstance(node, ast.Assign)


class _Names(ast.NodeVisitor):
    """The bare names a statement binds, and the bare names it reads.

    Bare names only. Reading one is a dictionary lookup that cannot run user
    code, which is what makes reporting them safe to do unbidden; `obj.attr`
    may be a property with a body and `area(3, 4)` would have to be called
    again, and #40 settles that an annotation never re-runs either.

    A `del`eted name is neither: it is gone, and reading it back would raise.

    Two callers ask two questions of this walk, and `for_display` is which.

    **What is worth showing beside the line** wants each name once across both
    lists, because `n += 1` has one thing to say about `n` and the binding is
    the more informative half; and it wants nothing from a definition but the
    name it binds, because `shout: <function shout>` beside `def greeting():`
    is noise.

    **What the statement actually touched at module level** wants both halves
    of `x = x + 1`, since a statement that reads `x` goes out of date when `x`
    is rebound whether or not it also binds it; and it wants a definition's
    decorators, defaults and annotations, because those are evaluated where the
    `def` is written rather than when the function is called.
    """

    def __init__(self, for_display: bool = True) -> None:
        self.for_display = for_display
        self.bound: List[str] = []
        self.read: List[str] = []
        #: One set of shadowed names per comprehension currently being walked.
        #: A stack rather than a set because comprehensions nest and shadow
        #: independently, and because a name is only shadowed *inside* the
        #: comprehension that binds it -- `sum(x for x in xs) + x` reads the
        #: enclosing `x` in its second half and must still say so.
        self._shadowed: List[Set[str]] = []

    def visit_Name(self, node: ast.Name) -> None:
        if any(node.id in scope for scope in self._shadowed):
            return
        if isinstance(node.ctx, ast.Store):
            self._record(self.bound, node.id)
        elif isinstance(node.ctx, ast.Load):
            self._record(self.read, node.id)

    def visit_Import(self, node: ast.Import) -> None:
        for alias in node.names:
            name = _first_bound_name(alias)
            if name is None:
                # A star import, whose names only the exporting module knows.
                # Reporting none of them costs the dependency walk a mark it
                # cannot make honestly -- see `defs_and_uses` on why an
                # unsound answer in this direction is the affordable one.
                continue
            self._record(self.bound, name)

    visit_ImportFrom = visit_Import

    def visit_AugAssign(self, node: ast.AugAssign) -> None:
        # `n += 1` consults `n` and then rebinds it, but the AST marks the
        # target Store and leaves the read implicit -- there is no Load node to
        # find. The display is content with the binding alone, which is the
        # more informative half of a pair; the dependency walk is not, because
        # an accumulator really does go out of date when what it accumulates
        # into is rebound above it.
        if not self.for_display and isinstance(node.target, ast.Name):
            self._record(self.read, node.target.id)
        self.generic_visit(node)

    def visit_ExceptHandler(self, node: ast.ExceptHandler) -> None:
        if node.name:
            # Python deletes it again at the end of the block, so it is
            # usually gone by the time anyone looks. Recorded anyway: the
            # reader who is missing a name is worse off than the one whose
            # name simply is not there to report.
            self._record(self.bound, node.name)
        self.generic_visit(node)

    # A definition binds its name now and runs its BODY at some other time --
    # when it is called, which may be long after this evaluation. Descending
    # into the body would report names that do not exist yet, or that belong
    # to a scope nothing here can see. `loops` refuses the same three nodes for
    # the same reason, and it is spelled out per type rather than left to a
    # comment.
    #
    # Its header is a different matter, and only the dependency walk cares:
    # decorators, default arguments and annotations are ordinary expressions
    # evaluated where the `def` is written, so `@register` really does read
    # `register` at the moment this statement runs.
    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        self._record(self.bound, node.name)
        if self.for_display:
            return
        for decorator in node.decorator_list:
            self.visit(decorator)
        # `ast.arguments` holds the defaults and, through each `arg`, the
        # annotations. A parameter's own name is a plain string rather than a
        # Name node, so descending here cannot mistake one for a binding.
        self.visit(node.args)
        if node.returns is not None:
            self.visit(node.returns)

    visit_AsyncFunctionDef = visit_FunctionDef

    def visit_ClassDef(self, node: ast.ClassDef) -> None:
        self._record(self.bound, node.name)
        if self.for_display:
            return
        for expression in (*node.decorator_list, *node.bases, *node.keywords):
            self.visit(expression)
        # Not the body, which does run now: every name it binds is a class
        # attribute rather than a module global, and recording those would
        # claim the statement rebound something at module level. The reads it
        # makes are missed as a consequence, which is the safe half to lose.

    def visit_Lambda(self, node: ast.Lambda) -> None:
        # Body and defaults both skipped, in both modes. The body genuinely
        # runs later; the defaults do not, and are a small deliberate miss
        # rather than a case worth a branch.
        return

    # A comprehension is the same situation one step further out, and it was
    # missed because it is an expression rather than a statement. In Python 3
    # `[x**2 for x in range(10)]` runs in a scope of its own and its `x` never
    # leaves it -- so beside a file that also has a module-level `x`, reporting
    # `x` reads that unrelated variable and presents it as part of the line.
    # That is worse than reporting nothing, because the value looks plausible:
    # comprehensions are where a beginner first meets scope, and an `x`
    # shadowing an outer `x` is the classic exercise, so it misleads exactly
    # where the reader is least equipped to notice.
    #
    # Only the loop targets go. `[x * factor for x in data]` still reports
    # `factor` and `data`, which are read from the enclosing scope and are the
    # context that makes the line make sense. A walrus inside a comprehension
    # is not a target and really does bind outside it, so it is still reported
    # -- which is the whole point of walking the body rather than skipping it
    # the way a `def` is skipped.
    #
    # The one name given up that a rule splitting hairs would keep is the
    # outermost iterable of `[x for x in x]`, which Python does evaluate in the
    # enclosing scope. Keeping it would put `x: ...` beside a line where `x` is
    # also the loop variable, leaving the reader to work out which `x` was
    # meant -- the confusion this exists to remove, so it goes too.
    def _visit_comprehension(self, node: ast.expr) -> None:
        generators = node.generators  # every comprehension node has these
        shadowed = {name for generator in generators
                    for name in _pattern_names(generator.target)}
        self._shadowed.append(shadowed)
        try:
            self.generic_visit(node)
        finally:
            self._shadowed.pop()

    visit_ListComp = _visit_comprehension
    visit_SetComp = _visit_comprehension
    visit_DictComp = _visit_comprehension
    visit_GeneratorExp = _visit_comprehension

    def _record(self, into: List[str], name: str) -> None:
        if self.for_display and (name in self.bound or name in self.read):
            # A name that is both bound and read -- `n += 1`, `x = x + 1` -- is
            # one pair, and the binding is the more informative half.
            return
        if name not in into:
            into.append(name)


def _already_shown(node: ast.stmt, first_in_body: bool) -> Set[str]:
    """Names the display slot already accounts for.

    Reporting them again would put the same name twice on one line: `x = 1`
    would read `x: 1   x: 1`.

    An expression statement is the exception, and the reason this is not
    simply "the names in the display". There the display *is* the expression,
    so its names are exactly the reads worth showing -- `y` in `y.append(4)`
    is the whole point of the exercise. Only when the expression is one bare
    name does the pair repeat the display.
    """
    if is_docstring(node, first_in_body):
        return set()
    target = _display_target(node)
    if target is None:
        return set()
    if isinstance(target, str):
        return {target}
    if isinstance(node, ast.Expr):
        return {target.id} if isinstance(target, ast.Name) else set()
    return {name.id for name in ast.walk(target)
            if isinstance(name, ast.Name)}


def annotated_names(node: ast.stmt, first_in_body: bool = False) -> Tuple[str, ...]:
    """The names worth reading beside this statement, in the order to show.

    What it binds first, then what it reads: a binding is what the line did,
    and a read is the context that makes the line make sense. `print("y
    unaffected by rebind:", y)` reads `y`, and `y` is the entire lesson of the
    line -- where the annotation used to say `None`, which is true, useless
    and misleading in a display whose job is to show what the code did.

    Which of these survive to the screen is the caller's: this side knows what
    the source refers to, and only the namespace knows what those names hold.
    """
    collector = _Names()
    collector.visit(node)
    shown = _already_shown(node, first_in_body)
    return tuple(name for name in (*collector.bound, *collector.read)
                 if name not in shown)


def defs_and_uses(node: ast.stmt) -> Tuple[Tuple[str, ...], Tuple[str, ...]]:
    """The module-level names this statement binds, and the ones it reads.

    Def and use over the module already being parsed, and it is used to *mark*
    and never to run. Re-evaluating a statement that binds `x` puts every later
    annotation that reads `x` out of date; saying so is a claim about time,
    which costs a walk of one statement, while fixing it would mean running the
    user's code unbidden, which #40 rules out.

    Deliberately unsound, and in the safe direction. Aliasing and mutation
    defeat it outright -- `y = lst` and then `lst.append(4)` changes what `y`
    shows without any statement binding `y` -- and so does a call whose body
    rebinds a global. Those go unmarked. That is affordable precisely because
    the output is a marker: a missed mark costs what the tool cost before this
    existed, and a spurious mark costs one grey pixel. It would not be
    affordable if the output were an execution, which is why reactive notebooks
    cannot do this reliably; marimo's own documentation says tracking mutations
    reliably is impossible in Python. Runtime lineage tracking is what catches
    them, and nbsafety measured its tracer at a 1.44x median slowdown.

    Read as a pair with `annotated_names`, which asks the other question of the
    same walk: that one is what to *show*, this one is what to *mark*.
    """
    collector = _Names(for_display=False)
    collector.visit(node)
    return tuple(collector.bound), tuple(collector.read)


def _start_line(node: ast.stmt) -> int:
    """The first line of `node` in the source, 1-based, decorators included.

    `FunctionDef.lineno` points at the `def`, not at the first decorator, so a
    cursor on a decorator line falls outside `[lineno, end_lineno]` and would
    resolve to nothing at all.
    """
    decorators = getattr(node, "decorator_list", None)
    if decorators:
        return min(node.lineno, min(d.lineno for d in decorators))
    return node.lineno


#: A line that contributes nothing to where a header ends: blank, or a comment
#: with nothing else on it. `_anchor_line` walks back over these; a `#` inside
#: a string in a wrapped header would defeat this cheap test, which is why it
#: is a text scan rather than the tokenizer -- see the docstring below.
_BLANK_OR_COMMENT = re.compile(r"^\s*(?:#.*)?$")


def _anchor_line(node: ast.stmt, end: int,
                 source_lines: Optional[List[str]] = None) -> int:
    """The 0-based line the annotation belongs on.

    For a compound statement that is its header: the first line through the
    end of the introducing clause, which is everything above the body. It is
    found as the line before the body starts rather than from the header's own
    sub-expressions, because the clause ends at a `:` that no node's position
    covers -- a signature wrapped over five lines ends at `):`, and the last
    argument is a line above it.

    `max` against the statement's own line keeps `if x: pass`, whose body
    begins on the header line, from anchoring on the line above.

    A comment or a blank line opening the body used to be the one shape this
    read low: `_start_line(node.body[0]) - 1` counts them as part of the
    header they merely precede, and the value came out beside a `#` instead of
    beside the clause that produced it -- a claim about a line that holds no
    statement at all (#93). `source_lines`, when given, is walked back from
    that guess past every line that is blank or a bare comment, stopping at
    the header's own last line or at `node.lineno`, whichever comes first --
    the same clamp the docstring above already relies on for `if x: pass`.
    This is the cheap fix the ticket accepts rather than a scan for the `:`
    that actually closes the clause: it does not see a `#` inside a string in
    a wrapped header, because that is still text a line starts with. Absent
    `source_lines` -- a caller with only the tree, no buffer -- the old guess
    stands, comments and all.

    The `def` line, not the first decorator: `node.lineno` already points at
    the `def`, and the decorator line is not where the name appears.
    """
    if not isinstance(node, _HEADER_ANCHORED):
        return end
    anchor = max(node.lineno, _start_line(node.body[0]) - 1) - 1
    if source_lines is None:
        return anchor
    floor = node.lineno - 1
    while (floor < anchor < len(source_lines)
           and _BLANK_OR_COMMENT.match(source_lines[anchor])):
        anchor -= 1
    return anchor


def utf16_column(text: str, byte_column: int) -> int:
    """Convert Python AST UTF-8 byte offsets to editor UTF-16 units."""
    prefix = text.encode("utf-8")[:max(0, byte_column)].decode(
        "utf-8", errors="ignore")
    return len(prefix.encode("utf-16-le")) // 2


def utf8_column(text: str, editor_column: int) -> int:
    """Convert editor UTF-16 units to Python AST UTF-8 byte offsets."""
    prefix = text.encode("utf-16-le")[:max(0, editor_column) * 2].decode(
        "utf-16-le", errors="ignore")
    units = len(text.encode("utf-16-le")) // 2
    return len(prefix.encode("utf-8")) + max(0, editor_column - units)


def form_of(node: ast.stmt, first_in_body: bool = False,
            source_lines: Optional[List[str]] = None) -> Form:
    """Describe a statement: what to run, what to show, and where it is.

    `first_in_body` says whether `node` opens the body it belongs to, which is
    the only thing that separates a docstring from a string someone typed to
    see the value of.

    `source_lines` supplies comment-aware anchors and converts AST UTF-8
    columns to editor UTF-16 columns. Tree-only callers retain AST columns;
    all protocol callers supply the source.
    """
    start = _start_line(node) - 1
    end = (node.end_lineno or node.lineno) - 1
    binds, reads = defs_and_uses(node)
    display = display_expr(node, first_in_body)
    # None only for a suppressed docstring; every other display is what
    # `_display_target` answered, computed once and shared by the two
    # questions below rather than asked twice.
    target = None if display is None else _display_target(node)
    readable, captured = _value_source(node, target)
    start_char = 0 if start < node.lineno - 1 else node.col_offset
    end_char = node.end_col_offset or 0
    if source_lines is not None:
        start_char = utf16_column(source_lines[start], start_char)
        end_char = utf16_column(source_lines[end], end_char)
    return Form(
        node=node,
        kind=type(node).__name__,
        display=display,
        start_line=start,
        start_char=start_char,
        end_line=end,
        end_char=end_char,
        anchor_line=_anchor_line(node, end, source_lines),
        names=annotated_names(node, first_in_body),
        binds=binds,
        reads=reads,
        readable=readable,
        captured=captured,
        is_binding=target is not None and not isinstance(node, ast.Expr),
    )


def _span(node: ast.stmt) -> Tuple[int, int]:
    """The 0-based first and last lines `node` covers, decorators included."""
    return _start_line(node) - 1, (node.end_lineno or node.lineno) - 1


def form_at(tree: ast.Module, line: int, character: int = 0,
            source: Optional[str] = None) -> Optional[Form]:
    """The top-level statement containing 0-based `line`, or None.

    A cursor on a blank line, or past the last statement, resolves to nothing.
    Falling back to the nearest preceding statement would be the kind of
    helpfulness that runs code the user did not point at.

    **`character` only matters when more than one top-level statement covers
    `line`.** Ordinary code never has this happen -- indentation is what keeps
    every other pair of top-level statements on disjoint lines -- so the one
    way it does is a semicolon: `print('x'); 'the value'` is two statements,
    both spanning column 0's line, and a resolver that used line containment
    alone always answered the first of them regardless of where the cursor
    actually was (#18). Preferring whichever statement's own column range
    contains `character` answers the one the user pointed at; falling back to
    the first when `character` lands in neither -- on the semicolon itself, or
    past the end of the line -- keeps every existing single-statement caller,
    which never had a reason to pass anything but the default, resolving
    exactly as it always did.

    With `source`, incoming columns are UTF-16 and converted to AST bytes
    before resolving semicolon-separated statements.
    """
    source_lines = None if source is None else source.split("\n")
    matches = [(index, node) for index, node in enumerate(tree.body)
               if _span(node)[0] <= line <= _span(node)[1]]
    if len(matches) > 1:
        if source_lines is not None and 0 <= line < len(source_lines):
            character = utf8_column(source_lines[line], character)
        for index, node in matches:
            if node.col_offset <= character <= (node.end_col_offset
                                                 if node.end_col_offset is not None
                                                 else node.col_offset):
                return form_of(node, first_in_body=index == 0,
                              source_lines=source_lines)
    if not matches:
        return None
    index, node = matches[0]
    return form_of(node, first_in_body=index == 0, source_lines=source_lines)


def forms_in(tree: ast.Module,
             lines: Optional[Tuple[int, int]] = None,
             source: Optional[str] = None) -> List[Form]:
    """The module body, or the part of it `lines` touches, in source order.

    `lines` is a 0-based inclusive line range, and a statement is in it when
    **any** of the statement lies inside it -- so a range that begins halfway
    through a `def` runs the whole `def`, and one that stops halfway through
    runs it whole as well. That outward snap is the point rather than a
    convenience. Running the highlighted lines as written is the alternative,
    and the trouble with it is not that a fragment breaks -- it is that a
    fragment frequently does not. The body of `if __name__ == "__main__":` is
    ordinary code on its own, and on its own it runs the block the guard
    exists to stop; the body of a `try` runs without its `except`, raising
    where the file it came from handles. Code that parses into something other
    than what the reader highlighted is the failure this refuses to have.

    `first_in_body` is decided against the module's own body, not against the
    selection, which is what keeps a range starting at statement seven from
    turning the string it starts with into a docstring and swallowing it.

    `source`, when given, is the same buffer `tree` was parsed from, split
    once here rather than once per statement, and passed on so a compound
    statement whose body opens with a comment anchors on its header instead of
    on that comment. See `_anchor_line`.
    """
    source_lines = None if source is None else source.split("\n")
    forms: List[Form] = []
    for index, node in enumerate(tree.body):
        if lines is not None:
            start, end = _span(node)
            if end < lines[0] or start > lines[1]:
                continue
        forms.append(form_of(node, first_in_body=index == 0,
                            source_lines=source_lines))
    return forms


@dataclass(frozen=True)
class Parsed:
    """A parse of the buffer, and an honest account of how much it covers.

    `truncated_at` is `None` for the ordinary case -- the whole file parsed,
    and every answer drawn from this tree was computed with the file's full
    context. Otherwise it is the 0-based line where the part that does not
    parse begins, and `error` is why. Both travel together because a value
    computed without the rest of the file is not the same claim as one
    computed with it, and the caller has to be able to say so.
    """

    tree: ast.Module
    truncated_at: Optional[int] = None
    error: Optional[SyntaxError] = None


#: Keywords that continue a compound statement someone already opened.
#:
#: They sit at the same indentation as the `if`, `for` or `try` they belong to,
#: which makes them the one kind of line that starts flush left and is still
#: the middle of a statement. Cutting the file at an `else:` leaves an `if`
#: that parses perfectly and *does something different* -- it silently drops
#: the branch the reader can see two lines below the cursor. That is the
#: failure this whole module refuses: an answer to a question nobody asked is
#: worse than no answer.
_CONTINUES_A_CLAUSE = re.compile(r"^(?:else|elif|except|finally)\b")

#: How many cuts are worth trying before giving up and reporting the error.
#:
#: Each attempt is guided by the position of the error it just hit, so it takes
#: a file broken in a new place every time to use these up -- and a file broken
#: in ten separate places is not one with a half-typed line at the bottom. At
#: that point "the part of the file that is fine" has stopped being a useful
#: idea and the honest answer is the syntax error.
_MAX_ATTEMPTS = 10


def cut_points(lines: List[str]) -> List[int]:
    """Line indices where the file may be cut without splitting a statement.

    A cut keeps `lines[:k]` and drops the rest, so `k` names the first dropped
    line, and the question is whether that line is the start of a statement or
    the middle of one.

    Two conditions, and between them they are exhaustive:

    **The line starts flush left.** Everything indented is inside a body, and
    cutting into a body leaves a `for` or a `def` running fewer statements than
    the one the user is looking at.

    **The line does not continue a clause** -- see `_CONTINUES_A_CLAUSE`.

    Nothing else needs checking, and the reason is worth stating because the
    list looks too short. Every other way a statement spans lines -- an open
    bracket, a triple-quoted string, a backslash continuation, a decorator
    waiting for its `def` -- leaves the *prefix* unparseable when it is cut
    through. The caller parses each candidate, so those disqualify themselves;
    only indentation and the clause keywords can produce a prefix that parses
    and means something else.

    Blank lines and comments are not candidates, which costs nothing: cutting
    above them and cutting below them produce the same tree.
    """
    points = []
    for index, line in enumerate(lines):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if line[:1].isspace():
            continue
        if _CONTINUES_A_CLAUSE.match(stripped):
            continue
        points.append(index)
    return points


def parse_prefix(source: str, filename: str = "<evalens>") -> Parsed:
    """Parse `source`, or as much of it from the top as parses on its own.

    `ast` is all-or-nothing, so one half-typed line makes a whole file
    unevaluable -- and a half-typed line is exactly what a file being explored
    in has, because that is why anyone is evaluating anything. The recovery is
    to drop trailing lines until what is left parses.

    **From the end, and never around the cursor.** The tempting alternative is
    a window that shrinks towards the cursor until it parses, and it retreats
    into precisely the constructs that defeat parsing in the first place:
    compound statement headers, backslash continuations, a bracketed pandas
    chain, a dict literal spanning a dozen lines. Microsoft enumerated that
    list from the other direction in vscode-jupyter#1471 and answered it by
    parsing rather than guessing. The dangerous half is not the window that
    fails to parse -- it is the window that parses into something valid that
    means something else, because that produces an answer instead of an error.
    Truncating from the end cannot cut through a construct the cursor is
    inside, and it handles the case the complaint is actually about: the
    broken line is the one being typed.

    Raises the original `SyntaxError` when nothing survives, so a genuinely
    broken file reports the error it always did.
    """
    try:
        return Parsed(ast.parse(source, filename=filename))
    except SyntaxError as first:
        original = first

    # `split`, not `splitlines`: the latter breaks on form feeds and a handful
    # of Unicode separators that Python's own tokenizer treats as ordinary
    # whitespace. A file with a form feed in it would renumber every line
    # below, and every position this module reports is a line number.
    lines = source.split("\n")
    points = cut_points(lines)
    error: SyntaxError = original

    for _ in range(_MAX_ATTEMPTS):
        # The parser says where it gave up, so the largest cut worth trying is
        # the last statement start at or above that line. Following the error
        # rather than stepping down one candidate at a time is what keeps this
        # from re-parsing a long file once per statement -- and it is what
        # makes the loop terminate: a failed attempt can only fail inside the
        # prefix it just cut, so the next limit is strictly smaller than this
        # cut, and the next cut strictly smaller again.
        limit = (error.lineno or 1) - 1
        candidates = [k for k in points if k <= limit]
        if not candidates or candidates[-1] == 0:
            # Nothing above the break, so there is no reduced context to answer
            # from -- only the error, which is what the user needs to see.
            raise original
        cut = candidates[-1]
        try:
            tree = ast.parse("\n".join(lines[:cut]) + "\n", filename=filename)
        except SyntaxError as again:
            error = again
            continue
        return Parsed(tree, truncated_at=cut, error=original)

    raise original
