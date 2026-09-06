"""The protocol uses VS Code UTF-16 coordinates, including non-ASCII code."""
import unittest

from test_kernel import KernelProcess


def column(text):
    return len(text.encode("utf-16-le")) // 2


class Coordinates(unittest.TestCase):
    def setUp(self):
        self.k = KernelProcess(control=False)
        self.addCleanup(self.k.close)

    def test_cursor_selects_the_pointed_statement_after_unicode(self):
        for prefix in ("é = 1; ", "变量 = 1; ", "s = '😀'; "):
            with self.subTest(prefix=prefix):
                source = prefix + "target = 42"
                result = self.k.evaluate(source, 0, character=column(prefix))
                self.assertTrue(result["ok"], result)
                self.assertEqual(result["display"], "target")
                self.assertEqual(result["value"], "42")
                self.assertEqual(result["range"], {
                    "start": {"line": 0, "character": column(prefix)},
                    "end": {"line": 0, "character": column(source)},
                })

    def test_outline_and_file_ranges_are_utf16(self):
        source = "é = '😀'; target = '中'\n"
        outline = self.k.send(op="outline", source=source)
        loaded = self.k.send(op="eval_file", source=source)
        self.assertEqual(outline["statements"][-1]["range"]["end"]["character"],
                         column(source.rstrip("\n")))
        self.assertEqual(
            [s["range"] for s in outline["statements"]],
            [s["range"] for s in loaded["results"]])

    def test_above_and_watch_preserve_source_for_ranges_and_anchors(self):
        source = "for 字 in ['😀']:\n    # explanation\n    value = 字\npass\n"
        watched = self.k.watch(source, 2, "字", character=4)
        above = self.k.send(op="eval_above", source=source, line=3)
        for result in (watched, above["results"][0]):
            self.assertTrue(result["ok"], result)
            self.assertEqual(result.get("anchor"), 0)
            self.assertEqual(result["range"]["end"]["character"],
                             column("    value = 字"))

    def test_syntax_error_offsets_count_astral_characters_twice(self):
        source = "x = '😀'; y = )\n"
        result = self.k.evaluate(source, 0)
        self.assertFalse(result["ok"])
        self.assertEqual(result["range"]["start"]["character"],
                         column(source[:source.index(")")]))
