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


def _first_bound_name(alias: ast.alias) -> str:
    """The name an `import` actually binds.

    `import os.path` binds `os`, not `os.path` -- evaluating the latter as an
    expression happens to work, but the name the statement put in the
    namespace is the first segment, and that is what the user just created.
    """
    if alias.asname:
        return alias.asname
    return alias.name.split(".")[0]


def display_expr(node: ast.stmt) -> Optional[str]:
    """The expression worth showing after `node` has run, as source.

    `None` means the statement runs but has nothing to display -- an `if`, a
    `del`, a bare `pass`. That is a real answer and not a failure; the caller
    highlights the region without painting a value.
    """
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


def form_of(node: ast.stmt) -> Form:
    """Describe a statement: what to run, what to show, and where it is."""
    start = _start_line(node) - 1
    end = (node.end_lineno or node.lineno) - 1
    return Form(
        node=node,
        kind=type(node).__name__,
        display=display_expr(node),
        start_line=start,
        start_char=0 if start < node.lineno - 1 else node.col_offset,
        end_line=end,
        end_char=node.end_col_offset or 0,
    )


def form_at(tree: ast.Module, line: int, character: int = 0) -> Optional[Form]:
    """The top-level statement containing 0-based `line`, or None.

    A cursor on a blank line, or past the last statement, resolves to nothing.
    Falling back to the nearest preceding statement would be the kind of
    helpfulness that runs code the user did not point at.
    """
    del character  # reserved: sub-expression resolution needs it, top-level does not

    for node in tree.body:
        start = _start_line(node) - 1
        end = (node.end_lineno or node.lineno) - 1
        if start <= line <= end:
            return form_of(node)
    return None
