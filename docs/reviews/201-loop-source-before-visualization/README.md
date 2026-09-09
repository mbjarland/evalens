# Code before the loop visualization

The Marketplace loop section now shows its four-line Python example before
the existing native Values-panel image. The example exactly matches the
capture fixture, including `v = x + y` and `print(x, y)`. The accompanying
sentence connects the sum to Variables and the printed pairs to Printed
output.

The coordinating session inspected this section in the actual Marketplace
styles at 711px and 488px content widths. The code precedes the image, stays
readable, and causes no horizontal document overflow. The source equality,
DOM order, README hash and image loading checks are in
`marketplace-preview.json`; the adjacent PNGs show both reviewed sizes.
The existing native extension screenshot was not changed.

Both complete suites pass with the same counts as the baseline: 969
extension tests and 718 kernel tests. This is a README change; runtime code
and the captured extension UI retain their prior native verification.

To reproduce the page review with Chrome and the repository dependencies:

```sh
node docs/reviews/201-loop-source-before-visualization/preview.cjs "$PWD"
```

The helper writes a local preview under `/private/tmp/evalens-201`; it does
not publish the page. The prepared VSIX is refreshed separately from the
clean merged commit.
