# The demo GIF — shooting script

> Status: Current
> Audience: whoever records the GIF next (human, camera in hand)
> Source of truth for: exactly what to record, and how to know it worked
> Last verified: 2026-09-06

`IDEA.md` and #15 are both blunt about this: for a visual extension, an
animated GIF above the fold outsells the name, and it is feature work rather
than documentation. **No agent can record it** — it needs a human driving a
real editor in front of a screen recorder — so this script exists to make
that fifteen minutes mechanical rather than a decision someone has to make
from scratch. `media/demo/tour-still.png` is the static stand-in until this
is shot; see the README's Demo section for how the two relate.

## What it has to prove in five seconds

A viewer scrolling search results decides in about two seconds. What has to
land in that window: **one keypress, held down, and a file filling up with
its own values while the cursor walks down it.** Not a menu, not a settings
screen, not an error case — the single loop this whole project is built
around.

## Exact file, exact lines

`examples/tour.py`, case 2 — the same four lines `IDEA.md` opens with and
`src/test/integration.test.ts` pins against the running kernel, so the
recording can never show a value the suite does not also assert:

```
84  lst = [1, 2, 3]
85  y = lst
86  y.append(4)
87  lst
```

Nothing above or below those four lines needs to be on screen. Case 2's own
comment block (lines 69–83) is useful context if it fits in the same
scroll position, but the four statements are the whole of what gets pressed.

## Setup, before the recording rolls

1. Open `examples/tour.py` in a *fresh* Extension Development Host window —
   no annotations from an earlier session anywhere in the file. **Evalens:
   Restart Kernel** if in doubt.
2. Bump `editor.fontSize` to **18** for the recording only (12 is correct for
   real use and unreadable once a GIF is scaled down for a README). Turn off
   the minimap and breadcrumbs (`editor.minimap.enabled`,
   `breadcrumbs.enabled`) so the frame is nothing but code.
3. Scroll so lines 84–87 sit comfortably in the upper half of the frame, with
   a few blank lines below them so the annotations have room and nothing
   reflows off the bottom edge mid-recording.
4. Place the cursor at the start of line 84 and confirm it is *not* yet
   blinking on an already-annotated line — the first frame of the recording
   is plain code, nothing painted.
5. Start the screen recording, then wait one full second before the first
   keypress. A GIF that starts on the keypress reads as cut off; a beat of
   plain code first is what makes the "before" register.

## The recording, beat by beat

One command, one key, pressed four times: **Evalens: Evaluate and Advance**
(`Cmd+Shift+Enter` on macOS, `Ctrl+Shift+Enter` on Windows/Linux). It
evaluates the statement at the cursor, paints its value, and moves the
cursor to the next one — which is the whole reason to film this command
rather than Evaluate at Cursor: the cursor's own movement is what makes the
loop legible on a silent GIF with no voiceover.

Every annotation text below is the real kernel's output, captured for this
ticket by driving `kernel/evalens_kernel.py` through the same
`KernelClient` → `render/present.ts` → `render/format.ts` path the extension
itself uses (see `media/demo/tour-still.png` and the README's Demo section)
— nothing here is invented.

| Beat | Time | Action | What appears on screen |
|---|---|---|---|
| 0 | 0.0s | (nothing yet) | Plain code, cursor blinking on line 84 |
| 1 | ~1.0s | Press the key once | Line 84 gains `lst: [1, 2, 3]`; the gutter shows one teal bar; a brief flash on the line; cursor moves to line 85 |
| 2 | ~2.0s | Press the key again | Line 85 gains `y: [1, 2, 3]   lst: [1, 2, 3]`; cursor moves to line 86 |
| 3 | ~3.0s | Press the key again | Line 86 gains `y: [1, 2, 3, 4]` — and line 84's annotation is deliberately still `[1, 2, 3]`, unbroken marker and all, because no statement rebound `lst` (see the comment on case 2 in `tour.py` if this needs explaining on camera, though the GIF itself says nothing) |
| 4 | ~4.0s | Press the key a fourth time | Line 87 gains `lst: [1, 2, 3, 4]`; cursor advances past the block |
| 5 | ~4.0s–6.5s | Hold, no input | All four annotations sit on screen together, readable at once — this is the payoff frame and the one worth the longest hold |

Total length: **six to seven seconds** before the loop point. Cut the
recording at the end of beat 5, with the frame still holding all four
annotations — the loop should feel like it restarts on a natural breath, not
mid-keypress.

## What must NOT be in frame

- Any notification, progress spinner, or the Output channel. This is the
  fast path — every one of these four evaluations finishes in a few
  milliseconds — and `evalens.progressDelay` (750ms) means none of that UI
  should appear at all if the recording is cut clean. If it does appear,
  something is slow and worth investigating before, not glossing over in,
  the recording.
- The Command Palette. The keybinding is the whole point; showing the menu
  path undercuts "one key."
- Any other extension's UI (Python extension status bar items are fine to
  leave visible — they are what a real setup looks like — but do not let a
  notification from one interrupt the loop).

## Recording and encoding

Any screen recorder that exports to `.mov`/`.mp4` works; convert to GIF
afterwards rather than recording to GIF directly, so a bad take can be
re-cut without re-recording. `gifski` (via `ffmpeg` for the intermediate
frames) produces smaller, sharper GIFs than QuickTime's own GIF export.

Target output:

- **Width**: 800–900px. Wide enough to read `y: [1, 2, 3]   lst: [1, 2, 3]`
  at README scale, narrow enough to load fast in a marketplace listing.
- **Frame rate**: 12–15fps is enough for a keypress-driven demo; this is not
  motion video and a higher rate only costs file size.
- **File size**: under 2MB if at all possible. A GIF above the fold that
  takes three seconds to load has defeated its own purpose.
- **Loop**: on, no delay before repeating.

## How to know it worked

Play the finished GIF back with the sound off and a stranger's eyes: does
the four-line story — a list, an alias, a mutation, and the alias seeing
it while nothing was ever assigned to prove it — read in five seconds
without narration? If it needs a caption to make sense, the recording chose
the wrong four lines or held a beat too briefly, not that the caption is
missing. Case 2 was written to answer this without help; if it does not,
that is worth a comment on this file before reshooting.

Once shot, replace `media/demo/tour-still.png`'s spot in the README's Demo
section with the GIF (`media/demo/tour.gif` is the suggested path), and
leave the still in place lower down as the one frame worth pausing on, per
the payoff beat above.
