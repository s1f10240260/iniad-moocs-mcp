"""Playwright で Moocs にログインし、講義ごとにクイズ / 課題 HTML を保存する。"""

from __future__ import annotations

import json
import re
from pathlib import Path

from .collect import (
    classify_assignment,
    fetch_problem_html,
    parse_assignment_urls,
    write_content,
)
from .contract import LectureRef, course_code
from .rate_limit import DailyBudget

BASE = "https://moocs.iniad.org"
ASSIGN_RE = re.compile(r"/assignments/(\d+)/([A-Za-z0-9_-]+)/([A-Za-z0-9_-]+)")


def extract_assignments_from_html(html: str) -> list[tuple[int, str, str]]:
    found: set[tuple[int, str, str]] = set()
    for m in ASSIGN_RE.finditer(html):
        found.add((int(m.group(1)), m.group(2), m.group(3)))
    return sorted(found)


def lecture_links_from_course_html(html: str, year: int, code: str) -> list[str]:
    pat = re.compile(
        rf'href="(/courses/{year}/{re.escape(code)}/[^"/#?]+)"'
    )
    return sorted(set(pat.findall(html)))


async def run_collect(
    *,
    username: str,
    password: str,
    year: int,
    root: Path,
    code_filter: str | None,
    lecture_filter: str | None,
    types: list[str],
    budget: DailyBudget,
    emit,
) -> int:
    """成功した件数を返す。失敗は emit 経由で報告し、例外は呼び出し側へ。"""
    from playwright.async_api import async_playwright

    ok = 0
    failed = 0
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        ctx = await browser.new_context()
        page = await ctx.new_page()

        # INIAD ログイン
        await page.goto(f"{BASE}/auth/iniad", wait_until="domcontentloaded")
        await page.wait_for_timeout(800)
        try:
            await page.fill("input#username, input[name=username]", username)
            await page.fill("input#password, input[name=password]", password)
            await page.click("input[type=submit], button[type=submit]")
            await page.wait_for_timeout(2500)
        except Exception as e:
            emit(
                {
                    "event": "error",
                    "code": "auth_error",
                    "message": f"login form: {type(e).__name__}: {e}",
                },
                f"auth error: {e}",
            )
            await browser.close()
            return 1

        if "/courses" not in page.url:
            emit(
                {"event": "error", "code": "auth_error", "message": f"unexpected url {page.url}"},
                f"auth failed: {page.url}",
            )
            await browser.close()
            return 1

        emit({"event": "auth_ok"}, "auth: ok")

        # 対象コース一覧（CODE 完全一致）
        await page.goto(f"{BASE}/courses/{year}", wait_until="networkidle")
        course_html = await page.content()
        course_pat = re.compile(rf'href="(/courses/{year}/([A-Za-z0-9_-]+))"')
        courses = sorted({(m.group(2), m.group(1)) for m in course_pat.finditer(course_html)})
        if code_filter:
            code = course_code(code_filter)
            courses = [(c, path) for c, path in courses if c.upper() == code]
        if not courses:
            emit({"event": "error", "code": "no_match", "message": "条件に合うコースがありません"}, "no course")
            await browser.close()
            return 1

        for slug, course_path in courses:
            code = course_code(slug)
            await page.goto(BASE + course_path, wait_until="networkidle")
            html = await page.content()
            lecture_paths = lecture_links_from_course_html(html, year, code)
            # LL は slides / Issue #7 と同じ割当（slug 数字優先、衝突・無効は空き番号）
            from .contract import assign_lecture_numbers

            refs = [LectureRef(p.rsplit("/", 1)[-1], i + 1) for i, p in enumerate(lecture_paths)]
            lls, ll_errors = assign_lecture_numbers(refs)
            for msg in ll_errors:
                emit(
                    {"event": "error", "code": "invalid_lecture_number", "course": code, "message": msg},
                    f"ll: {msg}",
                )
            for idx, lp in enumerate(lecture_paths):
                slug_lec = refs[idx].slug
                ll = lls[idx]
                if ll is None:
                    continue
                if lecture_filter and lecture_filter.isdigit() and ll != int(lecture_filter):
                    continue
                await page.goto(BASE + lp, wait_until="networkidle")
                lec_html = await page.content()
                assigns = extract_assignments_from_html(lec_html)
                for ay, ac, aid in assigns:
                    kind = classify_assignment(aid)
                    if kind not in types:
                        continue
                    budget.consume(1)
                    try:
                        problem_html = await fetch_problem_html(
                            ctx.request, year, ac, aid
                        )
                    except Exception as e:
                        failed += 1
                        emit(
                            {
                                "event": "error",
                                "code": "fetch_failed",
                                "course": code,
                                "lecture": ll,
                                "message": f"{aid}: {e}",
                            },
                            f"error {aid}: {e}",
                        )
                        continue
                    title_m = re.search(r"<h3[^>]*>(.*?)</h3>", problem_html, re.I | re.S)
                    title = (
                        re.sub(r"<[^>]+>", "", title_m.group(1)).strip() if title_m else None
                    )
                    rel = write_content(root, year, code, ll, kind, problem_html, title)
                    emit(
                        {
                            "event": "done",
                            "year": year,
                            "course": code,
                            "lecture": ll,
                            "file": rel,
                            "type": kind,
                            "title": title,
                            "assignment_id": aid,
                        },
                        f"done: {rel}",
                    )
                    ok += 1

        await browser.close()

    emit({"event": "summary", "ok": ok, "failed": failed}, f"summary ok={ok} failed={failed}")
    return ok if failed == 0 else 0
