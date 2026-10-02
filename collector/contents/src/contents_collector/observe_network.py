"""Moocs の /problem 系 AJAX を観察する（開発用・一度きりの調査）。

使い方:
  $env:MOOCS_USERNAME=...; $env:MOOCS_PASSWORD=...
  .venv/Scripts/python -m contents_collector.observe_network

JSON を tools/fixtures/ に保存する。認証情報はログに出さない。
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = "https://moocs.iniad.org"
FIXTURES = Path(__file__).resolve().parents[3] / "tools" / "fixtures"


def main() -> int:
    user = os.environ.get("MOOCS_USERNAME")
    password = os.environ.get("MOOCS_PASSWORD")
    if not user or not password:
        print("error: MOOCS_USERNAME / MOOCS_PASSWORD が必要です", file=sys.stderr)
        return 2

    FIXTURES.mkdir(parents=True, exist_ok=True)
    captured: list[dict] = []

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context()
        page = ctx.new_page()

        def on_response(resp):
            url = resp.url
            ctype = resp.headers.get("content-type", "")
            interesting = (
                any(k in url.lower() for k in ("problem", "quiz", "assign", "/api/", "ajax"))
                or ("json" in ctype and "moocs" in url)
                or (resp.request.resource_type in ("xhr", "fetch"))
            )
            if not interesting:
                return
            try:
                body = resp.text()[:20000]
            except Exception:
                body = ""
            captured.append(
                {
                    "method": resp.request.method,
                    "url": url,
                    "status": resp.status,
                    "resource_type": resp.request.resource_type,
                    "content_type": ctype,
                    "body_snippet": body,
                }
            )

        page.on("response", on_response)

        # INIAD / Keycloak ログインへ
        page.goto(f"{BASE}/auth/iniad", wait_until="domcontentloaded")
        page.wait_for_timeout(1500)
        # フォームがあれば埋める（Keycloak の定型）
        try:
            page.fill("input#username, input[name=username]", user)
            page.fill("input#password, input[name=password]", password)
            page.click("input[type=submit], button[type=submit]")
            page.wait_for_timeout(3000)
        except Exception as e:
            print(f"warn: login form not matched: {type(e).__name__}", file=sys.stderr)

        print(f"url after login: {page.url}", file=sys.stderr)

        # 講義ページを 1 つ開く
        page.goto(f"{BASE}/courses/2026/INI201", wait_until="networkidle")
        page.wait_for_timeout(1500)

        # リンクから lecture / problem らしいものを探す
        hrefs = page.eval_on_selector_all(
            "a[href]",
            "els => els.map(e => e.getAttribute('href')).filter(Boolean)",
        )
        (FIXTURES / "ini201_links.json").write_text(
            json.dumps(hrefs, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        print(f"links: {len(hrefs)}", file=sys.stderr)

        # 講義ページを開いて problem 系 AJAX / DOM を観察する
        lecture_hrefs = [
            h
            for h in hrefs
            if isinstance(h, str)
            and h.startswith("/courses/2026/INI201/")
            and h.count("/") == 4
        ]
        # 代表 2 件に絞る（レート制限）
        for href in lecture_hrefs[:2]:
            try:
                page.goto(BASE + href, wait_until="networkidle")
                page.wait_for_timeout(1200)
                html = page.content()
                name = href.rstrip("/").split("/")[-1]
                (FIXTURES / f"lecture_{name}.html").write_text(html, encoding="utf-8")
                # problem / quiz らしいノード
                info = page.evaluate(
                    """() => {
                      const pick = (sel) => Array.from(document.querySelectorAll(sel))
                        .slice(0, 20)
                        .map(e => ({tag: e.tagName, cls: e.className, id: e.id, text: (e.innerText||'').slice(0,80)}));
                      return {
                        iframes: pick('iframe'),
                        problem: pick('[class*=problem], [id*=problem], [class*=quiz], [class*=assign]'),
                        dataAttrs: pick('[data-url], [data-problem], [data-api]'),
                      };
                    }"""
                )
                (FIXTURES / f"lecture_{name}_dom.json").write_text(
                    json.dumps(info, ensure_ascii=False, indent=2), encoding="utf-8"
                )
            except Exception as e:
                print(f"warn: {href}: {e}", file=sys.stderr)

        browser.close()

    out = FIXTURES / "network_capture.json"
    out.write_text(json.dumps(captured, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"captured {len(captured)} responses -> {out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
