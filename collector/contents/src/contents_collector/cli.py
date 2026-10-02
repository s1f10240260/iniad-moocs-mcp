"""非対話 CLI エントリポイント。

対話入力は行わない。引数不足は exit 2、実行時失敗は exit 1。
JSON Lines イベントは collect-headless と同じ契約:
  start / done / error / skip / summary / auth_ok
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from .contract import (
    CONTENT_TYPES,
    assign_lecture_numbers,
    course_code,
    rel_content_path,
    LectureRef,
)
from .rate_limit import DEFAULT_DAILY_LIMIT, DailyBudget, RateLimitExceeded

EXIT_USAGE = 2
EXIT_RUNTIME = 1


def emit(json_mode: bool, quiet: bool, event: dict, human: str) -> None:
    if json_mode:
        print(json.dumps(event, ensure_ascii=False), flush=True)
    elif not quiet:
        print(human, file=sys.stderr, flush=True)


def fail(
    json_mode: bool, quiet: bool, code: str, message: str, exit_code: int
) -> int:
    emit(
        json_mode,
        quiet,
        {"event": "error", "code": code, "message": message},
        f"error: {message}",
    )
    return exit_code


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="contents-collector",
        description="Moocs クイズ・課題の非対話収集（対話プロンプトなし）",
    )
    p.add_argument("--year", type=int, help="対象年度 (例: 2026) [env: MOOCS_YEAR]")
    p.add_argument("--path", type=Path, help="出力ディレクトリ [env: MOOCS_OUT]")
    p.add_argument("--all", action="store_true", help="全講義を一括収集")
    p.add_argument("--course", help="コース CODE の完全一致（例: INI201）")
    p.add_argument("--lecture", help="LL の数値、または slug 部分一致")
    p.add_argument(
        "--types",
        default="quiz,assignment",
        help="収集対象 (comma 区分: quiz,assignment)",
    )
    p.add_argument(
        "--username",
        default=os.environ.get("MOOCS_USERNAME"),
        help="ユーザー名（学籍番号）[env: MOOCS_USERNAME]",
    )
    p.add_argument(
        "--password",
        default=os.environ.get("MOOCS_PASSWORD"),
        help="パスワード。env MOOCS_PASSWORD 推奨",
    )
    p.add_argument("--retries", type=int, default=3)
    p.add_argument(
        "--rate-limit-file",
        type=Path,
        default=Path(".contents-collector-rate.json"),
        help="日次リクエスト予算の保存先",
    )
    p.add_argument("--dry-run", action="store_true", help="収集せず計画のみ")
    p.add_argument("--json", action="store_true", help="JSON Lines で進捗出力")
    p.add_argument("--quiet", action="store_true")
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    json_mode = args.json
    quiet = args.quiet

    if args.year is None or args.path is None:
        return fail(
            json_mode,
            quiet,
            "usage",
            "--year と --path は必須です（対話入力は行いません）",
            EXIT_USAGE,
        )
    if not 2000 <= args.year <= 2100:
        return fail(
            json_mode,
            quiet,
            "usage",
            f"--year は 2000–2100 で指定してください（got {args.year}）",
            EXIT_USAGE,
        )
    if not args.all and not args.course:
        return fail(
            json_mode,
            quiet,
            "usage",
            "--all か --course のどちらかを指定してください",
            EXIT_USAGE,
        )
    if args.username is None or args.password is None:
        return fail(
            json_mode,
            quiet,
            "usage",
            "認証情報がありません。MOOCS_USERNAME / MOOCS_PASSWORD を指定してください",
            EXIT_USAGE,
        )

    types = [t.strip() for t in args.types.split(",") if t.strip()]
    for t in types:
        if t not in CONTENT_TYPES:
            return fail(
                json_mode, quiet, "usage", f"--types に不正な値: {t}", EXIT_USAGE
            )
    if not types:
        return fail(json_mode, quiet, "usage", "--types が空です", EXIT_USAGE)

    budget = DailyBudget(args.rate_limit_file, DEFAULT_DAILY_LIMIT)
    emit(
        json_mode,
        quiet,
        {
            "event": "rate_budget",
            "used": budget.used(),
            "limit": budget.limit,
            "remaining": budget.remaining(),
        },
        f"rate budget: {budget.remaining()}/{budget.limit} left today",
    )

    if args.dry_run:
        emit(
            json_mode,
            quiet,
            {
                "event": "planned",
                "year": args.year,
                "path": str(args.path),
                "all": args.all,
                "course": args.course,
                "lecture": args.lecture,
                "types": types,
                "note": "dry-run — collection not implemented yet (Phase 2 WIP)",
            },
            "dry-run: planned (collection not implemented)",
        )
        return 0

    import anyio

    from .rate_limit import RateLimitExceeded as _RLE
    from .runner import run_collect

    def _emit(event: dict, human: str) -> None:
        emit(json_mode, quiet, event, human)

    async def _run() -> int:
        try:
            await run_collect(
                username=args.username,
                password=args.password,
                year=args.year,
                root=args.path,
                code_filter=args.course,
                lecture_filter=args.lecture,
                types=types,
                budget=budget,
                emit=_emit,
            )
            return 0
        except _RLE as e:
            return fail(json_mode, quiet, "rate_limit", str(e), EXIT_RUNTIME)
        except Exception as e:  # noqa: BLE001 — CLI boundary
            return fail(json_mode, quiet, "collect_failed", str(e), EXIT_RUNTIME)

    return anyio.run(_run)


if __name__ == "__main__":
    raise SystemExit(main())
