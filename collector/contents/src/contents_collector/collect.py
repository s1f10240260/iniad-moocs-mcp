"""Moocs のクイズ・課題 HTML を取得する。

API（観察結果）:
  GET /assignments/{year}/{course}/{assignment_id}/problem?lang=ja
  → application/json  {"html": "<h3>...</h3>..."}
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path

from .contract import LectureRef, assign_lecture_numbers, rel_content_path
from .rate_limit import DailyBudget

ASSIGN_LINK_RE = re.compile(r"/assignments/(\d+)/([A-Za-z0-9_-]+)/([A-Za-z0-9_-]+)/")


@dataclass
class AssignmentHit:
    year: int
    course: str
    assignment_id: str
    kind: str  # quiz | assignment


def classify_assignment(assignment_id: str) -> str:
    low = assignment_id.lower()
    if "quiz" in low:
        return "quiz"
    return "assignment"


def parse_assignment_urls(urls: list[str]) -> list[AssignmentHit]:
    hits: dict[tuple[int, str, str], AssignmentHit] = {}
    for u in urls:
        m = ASSIGN_LINK_RE.search(u)
        if not m:
            continue
        year, course, aid = int(m.group(1)), m.group(2), m.group(3)
        hits[(year, course, aid)] = AssignmentHit(
            year, course, aid, classify_assignment(aid)
        )
    return list(hits.values())


async def fetch_problem_html(
    request, year: int, course: str, assignment_id: str
) -> str:
    """Playwright の APIRequestContext 等で problem HTML を取得する。"""
    url = f"https://moocs.iniad.org/assignments/{year}/{course}/{assignment_id}/problem?lang=ja"
    resp = await request.get(url)
    if not resp.ok:
        raise RuntimeError(f"problem fetch failed: {resp.status} {url}")
    data = json.loads(await resp.text())
    html = data.get("html")
    if not isinstance(html, str) or not html.strip():
        raise RuntimeError(f"problem html empty: {url}")
    return html


def write_content(
    root: Path,
    year: int,
    code: str,
    lecture_no: int,
    type_: str,
    html: str,
    title: str | None,
) -> str:
    rel = rel_content_path(year, code, lecture_no, type_)
    dest = root / rel
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(html, encoding="utf-8")
    return rel


def plan_lectures(slugs: list[str]) -> tuple[list[LectureRef], list[int | None], list[str]]:
    refs = [LectureRef(s, i + 1) for i, s in enumerate(slugs)]
    lls, errors = assign_lecture_numbers(refs)
    return refs, lls, errors


def consume_budget(budget: DailyBudget, n: int) -> None:
    budget.consume(n)
