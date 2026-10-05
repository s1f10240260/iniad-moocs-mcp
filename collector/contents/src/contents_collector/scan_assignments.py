"""コース内の assignment / quiz id を一覧してクイズの有無を探す。"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = "https://moocs.iniad.org"
ASSIGN_RE = re.compile(r"/assignments/(\d+)/([A-Za-z0-9_-]+)/([A-Za-z0-9_-]+)")


def main() -> int:
    user = os.environ.get("MOOCS_USERNAME")
    password = os.environ.get("MOOCS_PASSWORD")
    year = int(os.environ.get("MOOCS_YEAR", "2026"))
    course = os.environ.get("SCAN_COURSE", "INI201")
    if not user or not password:
        print("need creds", file=sys.stderr)
        return 2

    rows = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        page.goto(f"{BASE}/auth/iniad", wait_until="domcontentloaded")
        page.wait_for_timeout(800)
        page.fill("input#username, input[name=username]", user)
        page.fill("input#password, input[name=password]", password)
        page.click("input[type=submit], button[type=submit]")
        page.wait_for_timeout(2500)

        page.goto(f"{BASE}/courses/{year}/{course}", wait_until="networkidle")
        hrefs = page.eval_on_selector_all(
            "a[href]", "els => els.map(e => e.getAttribute('href'))"
        )
        lec_paths = sorted(
            {
                h
                for h in hrefs
                if h
                and h.startswith(f"/courses/{year}/{course}/")
                and h.count("/") == 4
            }
        )
        print(f"lectures: {len(lec_paths)}", file=sys.stderr)
        for lp in lec_paths:
            page.goto(BASE + lp, wait_until="networkidle")
            html = page.content()
            found = sorted(set(ASSIGN_RE.findall(html)))
            slug = lp.rsplit("/", 1)[-1]
            for y, c, aid in found:
                rows.append({"lecture": slug, "year": y, "course": c, "id": aid})
            print(f"{slug}: {len(found)} ids", file=sys.stderr)

        browser.close()

    out = Path(__file__).resolve().parents[3] / "tools" / "fixtures" / "assignment_ids.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")

    quizzes = [r for r in rows if "quiz" in r["id"].lower()]
    print(f"total ids: {len(rows)}  quiz-like: {len(quizzes)}")
    for r in quizzes:
        print(" QUIZ", r)
    # 代表例
    for r in rows[:15]:
        print(" ", r["lecture"], r["id"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
