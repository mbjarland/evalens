# Evalens — Calva-style inline evaluation for Python in VS Code

## The idea

Put the cursor on a line, hit a key, and see the resulting value painted
**inline in the buffer** next to the code — not in a side panel, not in a
terminal, not in a notebook cell, and without starting a debugger.

```python
lst = [1, 2, 3]                    => [1, 2, 3]
y = lst
y.append(4)
lst                                 => [1, 2, 3, 4]
squares = [x**2 for x in range(5)]  => [0, 1, 4, 9, 16]
```

This is precisely what [Calva](https://calva.io) gives Clojure developers,
and what Python does not have.

## Why this doesn't already exist

Not because it's hard. Because the demand got absorbed by notebooks.

Clojure's inline evaluation exists because the community standardised on
**nREPL** — a network REPL *protocol*. Any editor can connect to a live,
stateful runtime, send a form, get a value back, and render it. REPL-driven
development is Clojure's defining cultural practice, so every editor
plugin implements it.

Python has an equivalent protocol — the **Jupyter kernel protocol**
(ZeroMQ, stateful out-of-process runtime). It's good. But the UX the
community built on top of it went to *notebooks* and the Interactive
Window (`# %%` cells), never to editor overlays. The energy that produced
Calva in Clojure produced Jupyter in Python.

### Marketplace evidence (September 2026)

The entire "live Python evaluation" category:

| Extension | Installs | Last updated |
|---|---:|---|
| `almenon.arepl` | 2,131,982 | 2024-11-19 |
| `xirider.livecode` | 1,355,020 | **2020-06-26** |
| `VentureCasserole.python-live-evaluator` | 1,486 | 2025-09-15 |
| `wuhy.live-coding` | 980 | 2026-02-07 |
| `srejv.python-inline-eval` | 63 | 2026-04-14 |
| `gideonnnalue.pyroo` | 18 | 2026-08-07 |

One project won the category (AREPL, 4.9★) and then stopped being
updated. Everything else is a rounding error. Critically, **none of them
render values inline** — AREPL's own `inlineResults` setting is
documented as *"(Currently just error icons)"*. Values go to a side panel.

So the gap is real, and it is not crowded.

## Architecture

Three pieces. All three are available; two were verified before writing
this document.

### 1. A live, stateful runtime

Two viable options:

**(a) Roll your own — ~30 lines, zero dependencies.** A subprocess running
a loop: read code over a pipe, `exec()` it into a persistent namespace
dict, write back the `repr()` of the requested target.

You do **not** need the notebook protocol for this. Jupyter kernels buy
rich display (images/HTML), interrupt, restart, and multi-language
support — none of which inline scalars and collections require.

**(b) Borrow Jupyter's kernel.** The `ms-toolsai.jupyter` extension
exposes `IExportedKernelService` / `getKernelService` to third-party
extensions (verified present in the shipped bundle of
`ms-toolsai.jupyter-2025.8.0`). This hands you a managed kernel rather
than babysitting a process, at the cost of depending on the notebook
stack.

Start with (a). Graduate to (b) only if rich display becomes worth it.

### 2. Deciding what to evaluate

This looks like the hard part, because Clojure gets it free from
s-expressions: "the current form" is unambiguous when everything is
parenthesised. Python needs real parsing.

It turns out to be easy. `ast` has exact end positions (`end_lineno`,
`end_col_offset`) since Python 3.8. Roughly 40 lines of stdlib resolves
the form under a cursor — see `prototype/form_at_cursor.py`, which was
run against real files and produces:

```
cursor line 9   ->  exec 'tup = (1, 2, 3)'                  then show  tup
cursor line 33  ->  exec 'evens = [x for x in range(20)...]' then show  evens
```

This also solves the **statement-vs-expression problem**. In Clojure
everything returns a value; in Python `x = [1, 2, 3]` is a statement that
returns nothing. The resolution: exec the statement, then separately
evaluate the assignment *target* and display that. For a bare expression
statement, just display its value.

### 3. Rendering the overlay

`vscode.window.createTextEditorDecorationType({ after: { contentText: ' => [1, 2, 3]' } })`
followed by `editor.setDecorations(...)`.

This is the same mechanism Calva uses, and Error Lens, and inlay hints.
Well-documented, well-trodden.

## The genuinely hard parts

- **Ordering and state.** Evaluating line 40 requires lines 1–39 to have
  run. Calva has this exact problem and solves it socially: you evaluate
  top-down and the REPL holds state. The same answer works here. An
  optional "run everything above this line" command covers the rest.
- **Side effects on re-evaluation.** Re-running `db.execute(...)` is bad.
  Manual trigger (Calva's model) sidesteps this entirely — which is
  exactly why AREPL, running continuously, needs its `unsafeKeywords`
  blocklist hack. Prefer explicit evaluation.
- **Value formatting.** Truncation limits, nesting depth, hover-for-full,
  and sensible `repr()` handling of large or cyclic structures.
- **Decoration lifecycle.** Clear on edit, dismiss on Escape, reposition
  as the document changes. Fiddly rather than difficult.

## Prior art worth reading

- **Calva** — `BetterThanTomorrow/calva`. Open source. Its evaluation and
  result-decoration rendering is directly readable and is the reference
  implementation of the exact UX being targeted here.
- **AREPL** — `almenon/AREPL-vscode`. Solves the continuous-execution and
  value-serialisation problems, even though it renders to a panel.

## Scope of a first prototype

The smallest thing that proves or kills the idea:

1. 30-line subprocess kernel holding a persistent namespace.
2. The AST resolver (already written and working).
3. `Cmd+Enter` → evaluate the statement under the cursor → paint the
   value inline as a decoration.

No continuous mode, no rich display, no kernel management. If that feels
good to use, the rest is incremental. If it doesn't, very little was
spent finding out.

Estimated effort: a weekend for the prototype, a few more to reach
something daily-drivable. `yo code` scaffolds the TypeScript extension.

## Naming and marketplace positioning

The name is **Evalens** (eval + lens). A marketplace search for "evalens"
returns zero results, so it is unclaimed.

The reasoning: **Error Lens has 9,780,508 installs**, and `*-Lens` has
become recognised shorthand for "paints information into your editor."
Landing in that mental category is free positioning. As a second data
point, `TylerLeonhardt.vscode-inline-values-powershell` has 115,525
installs — the "inline values for X" framing demonstrably sells, in a
language with a fraction of Python's user base.

### Use both name fields

`package.json` exposes two separate fields, so brandability and
searchability are not a trade-off:

```jsonc
"name":        "python-inline-values",           // id + marketplace URL slug: pure SEO
"displayName": "Evalens — Inline Python Values",  // shown to humans: brand + keywords
```

### Other listing metadata that matters

- **`keywords`** are indexed by marketplace search:
  `python, repl, inline, live, values, evaluate, calva, nrepl, arepl,
  print debugging`. Including `calva` and `arepl` is deliberate — people
  searching those terms are precisely the target audience.
- **`categories`**: `["Debuggers", "Visualization", "Programming Languages"]`
- **`description`** renders as the single line under the name in search
  results, so it should be the pitch rather than a summary. Something
  like: *"See values inline as you type. No print(), no debugger, no
  notebook."*

### What actually converts

For a visual extension, an **animated GIF at the top of the README**
outsells the name by a wide margin. Every extension that has won this
category leads with one above the fold, Error Lens included. A viewer
scrolling search results decides in about two seconds, and a five-second
loop of values appearing on `Cmd+Enter` does that work. This deserves
more effort than the naming did.

## Motivation

Written while setting up a Python development environment for a student
beginning a five-year university programme. The absence of this workflow
in Python — coming from Clojure, where it is table stakes — was the
prompt.
