"""collect の URL 解析・出力パスのテスト。"""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from contents_collector.collect import (
    classify_assignment,
    parse_assignment_urls,
    write_content,
)


class CollectTests(unittest.TestCase):
    def test_classify(self):
        self.assertEqual(classify_assignment("ds-02-assignment1"), "assignment")
        self.assertEqual(classify_assignment("mini-quiz1"), "quiz")

    def test_parse_urls(self):
        urls = [
            "https://moocs.iniad.org/assignments/2026/INI201/ds-02-assignment1/problem?lang=ja",
            "https://moocs.iniad.org/assignments/2026/INI201/ds-02-assignment1/status",
            "https://moocs.iniad.org/courses/2026/INI201/02",
        ]
        hits = parse_assignment_urls(urls)
        self.assertEqual(len(hits), 1)
        self.assertEqual(hits[0].assignment_id, "ds-02-assignment1")
        self.assertEqual(hits[0].kind, "assignment")

    def test_write_content(self):
        with tempfile.TemporaryDirectory() as td:
            rel = write_content(Path(td), 2026, "INI201", 2, "quiz", "<p>hi</p>", "t")
            self.assertEqual(rel, "2026/INI201/02/quiz.html")
            self.assertTrue((Path(td) / rel).exists())


if __name__ == "__main__":
    unittest.main()
