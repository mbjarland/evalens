# Error guidance verification — #158

Implemented on top of #157's stale provenance change (`953571d`) on
2026-09-06. The error hover appends factual explanations for exactly the
original built-in `NameError` and `ValueError` classes. The kernel identifies
those classes by captured identity references in the existing error
formatter; names, modules, messages and tracebacks are not used to guess.

The original type, message and traceback remain intact. Explanation text
appears outside the traceback's literal fence and does not lengthen inline
annotations. The NameError paragraph names Evaluate Above Cursor as an
explicit option and describes its reset/execution cost, without creating a
command link. Existing stale provenance text and source navigation remain.

Automated verification passed: **831 extension tests** (baseline 825) and
**678 kernel tests** (baseline 674). Added tests exercise structured errors,
missing/mismatched metadata, real-pipe builtin classification, custom classes
with builtin-looking names/modules, subclasses, file outcomes, single and
file-load hovers, and literal escaping. Repeatedly opening a real captured
error hover generated zero additional kernel pipe writes.

A real macOS Extension Development Host was subsequently checked with
`missing_name`, `int("hello")`, and an unrelated `ZeroDivisionError`. The
NameError and ValueError hovers contained their original Python tracebacks
and factual guidance; the unrelated error kept its existing presentation.
The pointer opened the native NameError hover, and both implementation and
review agents inspected the [captured screenshot](2026-09-06-error-name.png):
the original traceback and explanatory paragraphs are readable and distinct.

Physical keyboard hover access and screen-reader behavior were not verified.
The live visual check does not establish assistive technology behavior or
learner comprehension.
