"""非対話 CLI エントリポイント。

対話入力は行わない。引数不足は SystemExit(2) で失敗させる。
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

EXIT_USAGE = 2
EXIT_RUNTIME = 1


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="contents-collector",
        description="Moocs クイズ・課題の非対話収集（対話プロンプトなし）",
    )
    p.add_argument("--year", type=int, required=True, help="対象年度 (例: 2026)")
    p.add_argument("--path", type=Path, required=True, help="出力ディレクトリ")
    p.add_argument("--all", action="store_true", help="全講義を一括収集")
    p.add_argument("--course", help="コースコード (例: INI201)")
    p.add_argument("--lecture", type=int, help="レクチャー番号")
    p.add_argument(
        "--types",
        default="quiz,assignment",
        help="収集対象 (comma 区分: quiz,assignment)",
    )
    p.add_argument("--cookie-jar", type=Path, help="Cookie ジャー")
    p.add_argument(
        "--session-cookie",
        help="セッション Cookie 文字列 (env: MOOCS_SESSION_COOKIE でも可)",
    )
    p.add_argument("--retries", type=int, default=3)
    p.add_argument("--json", action="store_true", help="JSON Lines で進捗出力")
    p.add_argument("--quiet", action="store_true")
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    if not args.all and not args.course:
        print(
            "error: --all か --course のどちらかを指定してください（対話選択はありません）",
            file=sys.stderr,
        )
        return EXIT_USAGE

    if not args.session_cookie and not args.cookie_jar:
        print(
            "error: 認証情報がありません。--session-cookie か --cookie-jar を指定してください",
            file=sys.stderr,
        )
        return EXIT_USAGE

    # TODO(phase-2): Playwright + AJAX API でクイズ / 課題を取得する
    event = {
        "event": "planned",
        "year": args.year,
        "path": str(args.path),
        "all": args.all,
        "course": args.course,
        "lecture": args.lecture,
        "types": args.types,
        "note": "implementation pending — see docs/ROADMAP.md Phase 2",
    }
    if args.json:
        print(json.dumps(event, ensure_ascii=False))
    elif not args.quiet:
        print("contents-collector: 実装は Phase 2（docs/ROADMAP.md）", file=sys.stderr)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
