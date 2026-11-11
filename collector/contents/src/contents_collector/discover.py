"""Moocs から講義 ID とコンテンツ ID の一覧だけ取得する（本体は取らない）。

新着検知用。出力 JSON を plan-delta に渡し、D1 との差分で「新しいもの」を決める。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

from .collect import classify_assignment
from .contract import rel_content_path, slug_ll

BASE = "https://moocs.iniad.org"
ASSIGN_RE = re.compile(r"/assignments/(\d+)/([A-Za-z0-9_-]+)/([A-Za-z0-9_-]+)")


def login(page, user: str, password: str) -> None:
    page.goto(f"{BASE}/auth/iniad", wait_until="domcontentloaded")
    page.wait_for_timeout(800)
    page.fill("input#username, input[name=username]", user)
    page.fill("input#password, input[name=password]", password)
    page.click("input[type=submit], button[type=submit]")
    page.wait_for_timeout(2500)


def discover_course(page, year: int, code: str) -> tuple[list[dict], list[dict]]:
    lectures: list[dict] = []
    contents: list[dict] = []

    page.goto(f"{BASE}/courses/{year}/{code}", wait_until="networkidle")
    hrefs = page.eval_on_selector_all(
        "a[href]", "els => els.map(e => e.getAttribute('href'))"
    )
    lec_paths = sorted(
        {
            h
            for h in hrefs
            if h
            and h.startswith(f"/courses/{year}/{code}/")
            and h.count("/") == 4
        }
    )

    for lp in lec_paths:
        slug = lp.rsplit("/", 1)[-1]
        ll = slug_ll(slug)
        if ll is None:
            continue
        lecture_id = f"{year}/{code}/{ll:02}"
        lectures.append({"id": lecture_id, "code": code, "number": ll})

        page.goto(BASE + lp, wait_until="networkidle")
        html = page.content()
        seen_types: set[str] = set()
        for y, c, aid in sorted(set(ASSIGN_RE.findall(html))):
            ctype = classify_assignment(aid)
            if ctype in seen_types:
                continue
            seen_types.add(ctype)
            cid = rel_content_path(year, code, ll, ctype).removesuffix(".html")
            contents.append(
                {
                    "id": cid,
                    "lecture_id": lecture_id,
                    "type": ctype,
                    "code": code,
                    "number": ll,
                }
            )

    return lectures, contents


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Moocs の ID 一覧を取得（新着検知用）")
    p.add_argument("--year", type=int, default=int(os.environ.get("MOOCS_YEAR", "2026")))
    p.add_argument("--out", type=Path, required=True)
    p.add_argument(
        "--courses",
        default="",
        help="カンマ区切り CODE。空なら ci/course-all.txt を読む",
    )
    p.add_argument("--repo-root", type=Path, default=Path(__file__).resolve().parents[4])
    args = p.parse_args(argv)

    user = os.environ.get("MOOCS_USERNAME")
    password = os.environ.get("MOOCS_PASSWORD")
    if not user or not password:
        print("error: MOOCS_USERNAME / MOOCS_PASSWORD が必要です", file=sys.stderr)
        return 2

    if args.courses.strip():
        codes = [c.strip().upper() for c in args.courses.split(",") if c.strip()]
    else:
        all_txt = args.repo_root / "ci" / "course-all.txt"
        codes = [c.strip().upper() for c in all_txt.read_text().replace("\n", ",").split(",") if c.strip()]

    year = args.year
    lectures: list[dict] = []
    contents: list[dict] = []

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        page = browser.new_page()
        login(page, user, password)
        for code in codes:
            try:
                lecs, conts = discover_course(page, year, code)
                lectures.extend(lecs)
                contents.extend(conts)
                print(f"discover {code}: lectures={len(lecs)} contents={len(conts)}", file=sys.stderr)
            except Exception as e:  # noqa: BLE001 — 1 コース失敗は続行
                print(f"discover {code} failed: {e}", file=sys.stderr)
        browser.close()

    payload = {"year": year, "lectures": lectures, "contents": contents}
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    print(f"wrote {args.out} lectures={len(lectures)} contents={len(contents)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
