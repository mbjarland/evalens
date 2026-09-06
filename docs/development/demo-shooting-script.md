# Shooting the demo

> Status: Current
> Audience: whoever records the GIF
> Source of truth for: what to film, in what order, and what must not be in
> frame

`IDEA.md` argues that a demo above the fold outsells the name. This is the
recipe for it. It cannot be produced without a human driving a real editor,
which is why it is written down rather than done.

## The file

[`examples/demo.py`](../../examples/demo.py). It exists for this and nothing
else — ten beats, each one line, ordered so every press lands harder than the
last. Do not shoot `examples/tour.py`: that is a 700-line conformance corpus
walked by `kernel/test_resolver.py`, and most of it is scrolling.

Every beat has been driven through the real kernel and the compiled renderer;
the annotations below are what it actually paints, not what it ought to.

## Before you press record

- **Window**: 1280×720 or 1440×810. Bigger reads as a screenshot, smaller
  loses the annotations.
- **Theme**: Dark Modern, the default. The palette was measured against its
  background.
- **Font**: 13–14px. Menlo, SF Mono or JetBrains Mono. Ligatures off — they
  shape a run of text differently from the per-segment rendering and can
  misalign a chip edge.
- **Hide**: the sidebar, the panel, the minimap, breadcrumbs, and any other
  extension that paints in the editor. Zen mode plus the line numbers is
  close to right.
- **Empty the namespace** first: run `Evalens: Restart Kernel`. A demo that
  opens with values already on screen has given the trick away.
- **Cursor on line 13**, the first statement. Nothing painted yet.

## The beats

Hold `Cmd+Shift+Enter` (`Ctrl+Shift+Enter` elsewhere) — **Evaluate and
Advance**. One press per statement, about 700ms apart. Let each answer land
before the next press; the whole point is that the reader watches a value
appear.

| # | Line | What appears | Why it is in the film |
|---|---|---|---|
| 1 | `greeting = "hello"` | `greeting: 'hello'` | Establishes the mechanic in one press |
| 2 | `lst = [1, 2, 3]` | `lst: [1, 2, 3]` | Sets up the hero beat |
| 3 | `other = lst` | `other: [1, 2, 3]   lst: [1, 2, 3]` | Two names, and the line says so |
| 4 | `other.append(4)` | `other: [1, 2, 3, 4]` | **The hero.** Both values are on screen; one just changed |
| 5 | `lst` | `lst: [1, 2, 3, 4]` | The payoff — `lst` moved without being assigned |
| 6 | `lst = [9, 9]` | `lst: [9, 9]` | And now they are two lists again |
| 7 | `other` | `other: [1, 2, 3, 4]` | Rebinding did not touch the other name |
| 8 | `for n in range(5):` | `n ×5: 0, 1, 2, 3, 4   squared ×5: 0, 1, 4, 9, 16   printed: n is 0 …(5 lines)` | The line no terminal can produce |
| 9 | `squares = [...]` | `squares: [0, 1, 4, 9, 16, 25]   n ×6: 0, 1, 2, 3, 4, 5` | A comprehension showing its hidden loop |
| 10 | `total = sum(squares)` | `total: 55   squares: [0, 1, 4, 9, 16, 25]` | Ordinary, and the name it read comes along — keeps the rhythm |
| 11 | `print("the total is", total)` | `printed: the total is 55` | Output, not the `None` it returned |

**Then stop pressing and use the mouse**, which is the change of gear:

| # | Action | What appears |
|---|---|---|
| 12 | Hover `crew` | The records table, three rows |
| 13 | Hover `p` | The field table — pause on `magnitude` reading *not evaluated* |
| 14 | Press the key on `int("not a number")` | The error, in the error colour, on its own line |

Beat 13 is the one to hold longest. A property listed and deliberately not
called is the clearest single frame of what this tool refuses to do.

## Length and framing

Twenty to thirty seconds. Under twenty and the values appear faster than
anyone can read; over thirty and it stops being a GIF.

Frame beats 1–7 tight — those seven lines and nothing else. Widen for the
loop at beat 8, because the annotation is long and the point is that all of
it fits beside the code.

## How to know it worked

Watch it with the sound off and no context, as a stranger would. If you
cannot tell **from the picture alone** that the answers are appearing *in
the file* rather than in a panel, reframe and shoot again — that is the
entire thing being sold, and it is the one thing a still image cannot say.

## Encoding

- GIF, 12–15fps, under 3MB so GitHub and the marketplace both inline it.
- `media/demo/evalens.gif`, referenced from `README.md`'s Demo section,
  replacing `hero.png`.
- Keep the still as a fallback: the marketplace renders the README from the
  packaged copy, and a GIF that fails to load leaves nothing behind.
