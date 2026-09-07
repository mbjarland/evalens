# Y2 shared result layout — #163

The compiled renderer was inspected in Chrome with values from Evalens'
real Python kernel. `verify.cjs` executes only its literal fixture, converts
those responses through `present` and `rowsFor`, and renders `valuesHtml`.
The multiline grid value and the stale flag are presentation fixtures.

Run from a compiled checkout with:

```sh
node docs/reviews/163-y2-panel/verify.cjs
```

The script requires Chrome at the macOS path written inside it. The four
screenshots use the extension's contributed dark, light, high-contrast and
high-contrast-light colours, plus explicit sample VS Code chrome colours.
They are standalone compiled-panel evidence, not Extension Host screenshots.

Observed and measured:

- Variable and printed labels begin at the same horizontal position. Each
  single-line value follows its own label immediately; values do not align
  into a second column.
- One continuous three-pixel border spans each statement's result surface.
  The output-only label starts three pixels from the top, which is the
  surface padding: there is no empty line above it and no orphan bar.
- The internal solid rule spans the usable result width at 60% opacity.
  Statement separators span code and results at full opacity, with thicker
  separators in the two high-contrast themes.
- Values-only, output-only, stdout plus stderr, stale and error rows retain
  their distinct labels and colours. A statement without a result has no
  result surface. Two-digit line numbers stay on one line.
- Long multiline values and output fold at the configured line count.
  Show all and Show less send only their fold action; Open in editor sends
  the captured stream identifier. No source-navigation message is emitted
  by those clicks. Full captured text remains available through fullTextFor.
  Expanded text scrolls inside the existing bounded container.

`geometry.json` records the four-theme measurements. `dark.png`, `light.png`,
`highContrast.png`, `highContrastLight.png` and `expanded.png` were inspected.

Validation: 841 extension tests (baseline 839), 678 kernel tests (unchanged).
The extension suite includes source navigation, stale links and error
presentation checks. The integrating session also inspected the initial Y2
layout in a real VS Code Host: the output-only label starts three pixels
below the surface top, and expanding/collapsing output left the source
cursor on line 6.

The maintainer subsequently chose amber evaluated bars. The contributed
`evalens.annotationBorder` now defaults to amber in both inline annotations
and the Values panel, with darker shades for light backgrounds. Existing
colour tests check that the accent remains visible and stale bars remain
quieter. The screenshots above have been regenerated with those defaults;
stale, pending and error colours are unchanged. Explicit user colour
customizations retain priority.

The integrating session then inspected the final amber layout in a real
Extension Development Host using its own `y2.py` fixture.
`y2-amber-host.png` and `y2-amber-light-host.png` show the editor annotations
and Values panel in dark and light themes. Both use amber evaluated bars;
the dark panel's computed border colour was `rgb(230, 173, 69)`, matching
`#e6ad45`. The output-only row has no orphan bar or extra line. The earlier
Host fold expansion/collapse checks kept the source cursor on line 6. No
external teaching file was evaluated. Installed-build verification remains
with the integrating session.

Folding still counts captured newlines, as #155 specifies. This layout
change does not add character-based folding for a huge single-line repr or
new loop capture limits.
