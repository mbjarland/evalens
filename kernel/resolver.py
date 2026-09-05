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

Coordinates in and out are VS Code's: 0-based line, 0-based character. `ast`
is 1-based for `lineno`, and the conversion happens here rather than in the
renderer -- an off-by-one next to the parser is much cheaper to find than one
three layers away.

Requires Python 3.9 or later, for `ast.unparse`.
"""

from __future__ import annotations

import ast
from dataclasses import dataclass
from typing import Optional


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
    if isinstance(node, ast.Assign):
        # `a = b = 1` has two targets; the first is the one written left-most
        # and is what the eye lands on.
        return ast.unparse(node.targets[0])
    if isinstance(node, (ast.AnnAssign, ast.AugAssign)):
        return ast.unparse(node.target)
    if isinstance(node, ast.Expr):
        return ast.unparse(node.value)
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
        return ast.unparse(node.target)
    if isinstance(node, (ast.With, ast.AsyncWith)):
        for item in node.items:
            if item.optional_vars is not None:
                return ast.unparse(item.optional_vars)
        return None
    return None


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
    return Form(
        node=node,
        kind=type(node).__name__,
        display=display_expr(node, first_in_body),
        start_line=start,
        start_char=0 if start < node.lineno - 1 else node.col_offset,
        end_line=end,
        end_char=node.end_col_offset or 0,
        anchor_line=_anchor_line(node, end),
    )


def form_at(tree: ast.Module, line: int, character: int = 0) -> Optional[Form]:
    """The top-level statement containing 0-based `line`, or None.

    A cursor on a blank line, or past the last statement, resolves to nothing.
    Falling back to the nearest preceding statement would be the kind of
    helpfulness that runs code the user did not point at.
    """
    del character  # reserved: sub-expression resolution needs it, top-level does not

    for index, node in enumerate(tree.body):
        start = _start_line(node) - 1
        end = (node.end_lineno or node.lineno) - 1
        if start <= line <= end:
            return form_of(node, first_in_body=index == 0)
    return None
