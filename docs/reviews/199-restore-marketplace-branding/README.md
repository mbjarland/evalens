# Restored Marketplace branding

The page restores the centered `eval·lens` name, its eval/lens wordplay and
the notebook-feedback-loop tagline. The first example again uses two names
for one list, followed by a running total whose recorded values explain its
bug. The installation, session, loop, keybinding and recording corrections
remain. macOS shortcuts come first, with Windows/Linux equivalents.

The maintainer's review found that the original accumulator wording assumed
too much Python knowledge. The final section starts from adding 2, 4 and 6,
expecting 12 but obtaining 6. It explains replacement before showing
`total = total + n`, explicitly reruns the whole file from zero, and only
then introduces `+=` as shorthand. The arithmetic and history correspond to
the actual screenshot; the image itself was not recreated or retouched.

`marketplace-preview.json` records the final README hash and its rendering
inside the public Marketplace page's actual CSS. The content measures 711px
at a 1360px viewport and 488px at a 900px viewport. The centered branding,
complete page, running-total section and native product images were visually
reviewed at both sizes. All six main-page images load without horizontal
document overflow. The eleven demo images remain referenced across README
and the full user guide. #198 supplied the updated native nested-loop image;
the other public captures and learning screenshots retain their provenance.

The preview only replaces content in a local browser instance. It does not
upload or change the Marketplace. `preview.cjs` also writes a standalone
local page in `/private/tmp/evalens-199/index.html`, using the actual page's
styles and the real image bytes. Serve that directory on loopback to view it
in the default browser. The package build separately pins public image and
documentation URLs to the release commit.

After rebasing onto #198, both complete suites pass: 969 extension tests and
718 kernel tests, with no failures or skips. The extra extension test belongs
to #198; this issue changes README and review evidence. Native extension
acceptance is in `../198-shared-loop-headings/native`.
