"""契約・レート制限のユニットテスト。実ネットワーク不要。"""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from contents_collector.contract import (
    LectureRef,
    assign_lecture_numbers,
    course_code,
    first_number,
    rel_content_path,
    slug_ll,
)
from contents_collector.rate_limit import DailyBudget, RateLimitExceeded


class ContractTests(unittest.TestCase):
    def test_course_code(self):
        self.assertEqual(course_code("INI201"), "INI201")
        self.assertEqual(course_code("ini201"), "INI201")
        with self.assertRaises(ValueError):
            course_code("intro:INI201")
        with self.assertRaises(ValueError):
            course_code("日本語")

    def test_percent_decode_numbers(self):
        self.assertEqual(slug_ll("%E7%AC%AC7%E5%9B%9E"), 7)
        self.assertEqual(first_number("%E7%AC%AC12%E5%9B%9E"), 12)
        self.assertNotEqual(slug_ll("%E7%AC%AC9%E5%9B%9E"), 7)
        self.assertEqual(slug_ll("02"), 2)
        self.assertIsNone(slug_ll("0"))
        self.assertIsNone(slug_ll("intro"))

    def test_rel_content_path(self):
        self.assertEqual(
            rel_content_path(2026, "INI201", 2, "quiz"), "2026/INI201/02/quiz.html"
        )
        self.assertEqual(
            rel_content_path(2026, "INI201", 10, "assignment"),
            "2026/INI201/10/assignment.html",
        )
        with self.assertRaises(ValueError):
            rel_content_path(2026, "INI201", 1, "slide")

    def test_assign_reassigns_collisions(self):
        entries = [
            LectureRef("%E7%AC%AC15%E5%9B%9E", 15),
            LectureRef("Week15", 16),
            LectureRef("00", 1),
        ]
        results, errors = assign_lecture_numbers(entries)
        self.assertEqual(errors, [])
        self.assertEqual(results[0], 15)
        self.assertEqual(results[1], 16)
        self.assertEqual(results[2], 1)
        self.assertEqual(len(set(results)), 3)


class RateLimitTests(unittest.TestCase):
    def test_consume_and_exceed(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "budget.json"
            budget = DailyBudget(path, limit=3)
            budget.consume(2)
            self.assertEqual(budget.used(), 2)
            budget.consume(1)
            with self.assertRaises(RateLimitExceeded):
                budget.consume(1)
            self.assertEqual(budget.used(), 3)
            data = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(data["count"], 3)


if __name__ == "__main__":
    unittest.main()
