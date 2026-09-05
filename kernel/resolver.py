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

Requires Python 3.9 or later, for `ast.unparse`.
"""

from __future__ import annotations

import ast
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


def _first_bound_name(alias: ast.alias) -> str:
    """The name an `import` actually binds.

    `import os.path` binds `os`, not `os.path` -- evaluating the latter as an
    expression happens to work, but the name the statement put in the
    namespace is the first segment, and that is what the user just created.
    """
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
    """
    if isinstance(node, ast.Assign):
        # `a = b = 1` has two targets; the first is the one written left-most
        # and is what the eye lands on.
        return node.targets[0]
    if isinstance(node, (ast.AnnAssign, ast.AugAssign)):
        return node.target
    if isinstance(node, ast.Expr):
        return node.value
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
        return node.name
    if isinstance(node, (ast.Import, ast.ImportFrom)):
        return _first_bound_name(node.names[0])
    if isinstance(node, (ast.For, ast.AsyncFor)):
        # The target labels a sequence rather than a value: the kernel records
        # what it held on each iteration and reports all of them. `p` is still
        # the right thing to write beside the answer -- it is what the reader
        # is watching -- but nothing evaluates it afterwards, because by then
        # it holds only the last of the values already recorded. See `loops`.
        return node.target
    if isinstance(node, (ast.With, ast.AsyncWith)):
        for item in node.items:
            if item.optional_vars is not None:
                return item.optional_vars
        return None
    return None


def display_expr(node: ast.stmt, first_in_body: bool = False) -> Optional[str]:
    """The expression worth showing after `node` has run, as source.

    `None` means the statement runs but has nothing to display -- an `if`, a
    `del`, a bare `pass`. That is a real answer and not a failure; the caller
    highlights the region without painting a value.

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
            self._record(self.bound, _first_bound_name(alias))

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


def _anchor_line(node: ast.stmt, end: int) -> int:
    """The 0-based line the annotation belongs on.

    For a compound statement that is its header: the first line through the
    end of the introducing clause, which is everything above the body. It is
    found as the line before the body starts rather than from the header's own
    sub-expressions, because the clause ends at a `:` that no node's position
    covers -- a signature wrapped over five lines ends at `):`, and the last
    argument is a line above it.

    `max` against the statement's own line keeps `if x: pass`, whose body
    begins on the header line, from anchoring on the line above. The one shape
    this reads a line low is a comment or blank line as the first thing in a
    body; the annotation then sits on that instead of on the header, which is
    still beside the statement rather than at the far end of it.

    The `def` line, not the first decorator: `node.lineno` already points at
    the `def`, and the decorator line is not where the name appears.
    """
    if not isinstance(node, _HEADER_ANCHORED):
        return end
    return max(node.lineno, _start_line(node.body[0]) - 1) - 1


def form_of(node: ast.stmt, first_in_body: bool = False) -> Form:
    """Describe a statement: what to run, what to show, and where it is.

    `first_in_body` says whether `node` opens the body it belongs to, which is
    the only thing that separates a docstring from a string someone typed to
    see the value of.
    """
    start = _start_line(node) - 1
    end = (node.end_lineno or node.lineno) - 1
    binds, reads = defs_and_uses(node)
    return Form(
        node=node,
        kind=type(node).__name__,
        display=display_expr(node, first_in_body),
        start_line=start,
        start_char=0 if start < node.lineno - 1 else node.col_offset,
        end_line=end,
        end_char=node.end_col_offset or 0,
        anchor_line=_anchor_line(node, end),
        names=annotated_names(node, first_in_body),
        binds=binds,
        reads=reads,
    )


def _span(node: ast.stmt) -> Tuple[int, int]:
    """The 0-based first and last lines `node` covers, decorators included."""
    return _start_line(node) - 1, (node.end_lineno or node.lineno) - 1


def form_at(tree: ast.Module, line: int, character: int = 0) -> Optional[Form]:
    """The top-level statement containing 0-based `line`, or None.

    A cursor on a blank line, or past the last statement, resolves to nothing.
    Falling back to the nearest preceding statement would be the kind of
    helpfulness that runs code the user did not point at.
    """
    del character  # reserved: sub-expression resolution needs it, top-level does not

    for index, node in enumerate(tree.body):
        start, end = _span(node)
        if start <= line <= end:
            return form_of(node, first_in_body=index == 0)
    return None


def forms_in(tree: ast.Module,
             lines: Optional[Tuple[int, int]] = None) -> List[Form]:
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
    """
    forms: List[Form] = []
    for index, node in enumerate(tree.body):
        if lines is not None:
            start, end = _span(node)
            if end < lines[0] or start > lines[1]:
                continue
        forms.append(form_of(node, first_in_body=index == 0))
    return forms
