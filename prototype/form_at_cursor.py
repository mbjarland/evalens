"""Proof: find the 'form' under a cursor, Calva-style, using stdlib ast."""
import ast, sys

def form_at(src: str, line: int, col: int = 0):
    """Return (kind, range, text, display_expr) for the node under the cursor."""
    tree = ast.parse(src)
    lines = src.splitlines()

    # innermost EXPRESSION containing the cursor (Calva's "current form")
    best_expr = None
    for node in ast.walk(tree):
        if isinstance(node, ast.expr) and hasattr(node, "end_lineno"):
            if node.lineno <= line <= node.end_lineno:
                size = (node.end_lineno - node.lineno, node.end_col_offset)
                if best_expr is None or size < best_size:
                    best_expr, best_size = node, size

    # enclosing top-level STATEMENT (what you must exec to get state)
    stmt = next((n for n in tree.body
                 if n.lineno <= line <= (n.end_lineno or n.lineno)), None)

    if stmt is None:
        return None
    text = "\n".join(lines[stmt.lineno - 1: stmt.end_lineno])

    # for an assignment, the thing worth SHOWING is the target's value
    display = None
    if isinstance(stmt, ast.Assign):
        display = ast.unparse(stmt.targets[0])
    elif isinstance(stmt, ast.AnnAssign):
        display = ast.unparse(stmt.target)
    elif isinstance(stmt, ast.Expr):
        display = ast.unparse(stmt.value)

    return {
        "stmt_kind": type(stmt).__name__,
        "lines": (stmt.lineno, stmt.end_lineno),
        "exec_text": text,
        "show_expr": display,
        "inner_expr": ast.unparse(best_expr) if best_expr else None,
    }

src = open(sys.argv[1]).read()
for line in [int(x) for x in sys.argv[2:]]:
    r = form_at(src, line)
    print(f"--- cursor on line {line} ---")
    for k, v in r.items():
        print(f"  {k:<11} {v!r}")
