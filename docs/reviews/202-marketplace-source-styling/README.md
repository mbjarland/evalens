# Marketplace source styling and typography

The loop example now begins with an actual VS Code capture of its source,
using the dark editor background and Python syntax colors. At the normal
711px image width, its source text is 18px; the native capture and provenance
are in [native/README.md](native/README.md). The exact four-line Python
example remains selectable and copyable under **Copy this example**, before
the existing loop-results image. The result image and runtime are unchanged.

## What made the preview too small

The live Marketplace page was measured on 2026-09-09 at ordinary browser
scale. Body text is 14px with 22.4px line height. Its standard fenced code
uses 11.9px text. These are styles supplied by the Marketplace, which
[renders the extension's README](https://code.visualstudio.com/api/references/extension-manifest#marketplace-presentation-tips).
The documented manifest provides no body-font-size override.

The standalone preview omitted the live page's `ms-Fabric` ancestor. It
therefore inherited 12px body text, 19.2px line height, and a different font
family from the site shell. Restoring that class on the preview container
makes its typography match the actual Marketplace. This correction belongs
to the review preview; it does not inject custom CSS into the README or
claim that the publisher controls the site's body text.

`marketplace-preview.json` records matching computed font sizes, families,
and line heights for paragraphs, both heading levels, and fenced code in
the live-page rendering and standalone preview. The corrected body text is
about 17% larger than the previous local preview. Browser zoom remains the
reader's way to enlarge the entire Marketplace page beyond its default.

## Visual acceptance

The coordinating session inspected the native source crop, its surrounding
VS Code window, and the page at approximately 711px and 488px content
widths. Both page captures are stored here. The source image, copyable
Python, and original result fixture agree exactly, and source precedes
result in the rendered page. All seven README images load, with no
horizontal page overflow at either width. The smaller page naturally
scales screenshots down; the text disclosure remains available to copy.

The existing suites pass unchanged: 969 extension tests and 718 kernel
tests. This is documentation and preview acceptance, not a new runtime,
Windows keyboard, or screen-reader verification. The tree-guide concepts
requested alongside this change are tracked separately in #203 and are
not part of these public product images.

## Reproduce

From an installed repository checkout, run:

```sh
node docs/reviews/202-marketplace-source-styling/preview.cjs "$PWD"
```

The helper uses local Chrome, the repository's development dependencies,
current public Marketplace styles, and this checkout's README and images.
It writes to `/private/tmp/evalens-202` by default; `EVALENS_PREVIEW_OUT`
can select another directory. It never uploads Marketplace content.
