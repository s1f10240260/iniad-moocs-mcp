"""固定インターフェースの ID / パス導出（collect-headless と ingest の契約に合わせる）。

- CODE: `[A-Za-z0-9_-]{1,32}`（slug がそのまま使えるときだけ。推測しない）
- LL: 1..=999
- contents パス: `{year}/{CODE}/{LL:02}/{type}.html`（type は quiz | assignment）
- JSONL: `course` は CODE、`lecture` は数値、`file` は out/ からの相対パス
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from urllib.parse import unquote

CODE_RE = re.compile(r"^[A-Za-z0-9_-]{1,32}$")
CONTENT_TYPES = frozenset({"quiz", "assignment"})


def course_code(slug: str) -> str:
    """CODE を返す。使える形でなければ ValueError。"""
    upper = slug.strip().upper()
    if CODE_RE.fullmatch(upper):
        return upper
    raise ValueError(
        f"course slug {slug!r} は CODE（[A-Za-z0-9_-]{{1,32}}）として使えません"
    )


def first_number(text: str) -> int | None:
    """デコード後の最初の数字列（URL エンコードの 16 進を誤認しない）。"""
    decoded = unquote(text)
    m = re.search(r"\d+", decoded)
    return int(m.group()) if m else None


def slug_ll(slug: str) -> int | None:
    n = first_number(slug)
    return n if n is not None and 1 <= n <= 999 else None


def rel_content_path(year: int, code: str, lecture_no: int, type_: str) -> str:
    if type_ not in CONTENT_TYPES:
        raise ValueError(f"unknown content type: {type_!r}")
    return f"{year}/{code}/{lecture_no:02}/{type_}.html"


def out_content_path(root, year: int, code: str, lecture_no: int, type_: str):
    from pathlib import Path

    return Path(root) / str(year) / code / f"{lecture_no:02}" / f"{type_}.html"


@dataclass(frozen=True)
class LectureRef:
    slug: str
    flat_index: int  # コース内一覧の通し番号（1 始まり）


def assign_lecture_numbers(entries: list[LectureRef]) -> tuple[list[int | None], list[str]]:
    """collect-headless と同じ LL 割当。戻り値は (ll or None, errors)。"""
    used: set[int] = set()
    results: list[int | None] = [None] * len(entries)
    errors: list[str] = []

    # Pass 1: slug 数字が一意なら採用（先勝ち）
    pending: list[bool] = [True] * len(entries)
    for i, e in enumerate(entries):
        ll = slug_ll(e.slug)
        if ll is not None and ll not in used:
            used.add(ll)
            results[i] = ll
            pending[i] = False

    # Pass 2: 残りは一覧位置を起点に最小の空き
    for i, e in enumerate(entries):
        if not pending[i]:
            continue
        start = min(max(e.flat_index, 1), 999)
        ll = start
        found = False
        for _ in range(999):
            if ll not in used:
                used.add(ll)
                results[i] = ll
                found = True
                break
            ll = 1 if ll >= 999 else ll + 1
        if not found:
            errors.append(f"lecture slug {e.slug!r} に振れる空き LL がありません")

    return results, errors
