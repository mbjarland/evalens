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

At this commit, a real Extension Development Host has not yet been inspected
for #158. Hover appearance, keyboard hover access and screen-reader behavior
still require live verification. Automated tests establish the content and
absence of requests; they do not establish visual readability or assistive
technology behavior.
