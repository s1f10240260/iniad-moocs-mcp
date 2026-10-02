"""Moocs のレート制限（100 回/日）を守るための簡易カウンタ。

状態は `path`（JSON）に保存する。CI ではワークスペース配下に置き、
日付（UTC）が変わったらリセットする。
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import date, datetime, timezone
from pathlib import Path

DEFAULT_DAILY_LIMIT = 100


class RateLimitExceeded(RuntimeError):
    def __init__(self, used: int, limit: int) -> None:
        super().__init__(f"rate limit exceeded: {used}/{limit} in one UTC day")
        self.used = used
        self.limit = limit


@dataclass
class DailyBudget:
    path: Path
    limit: int = DEFAULT_DAILY_LIMIT

    def _load(self) -> dict:
        if not self.path.exists():
            return {}
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}
        return data if isinstance(data, dict) else {}

    def _save(self, data: dict) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(
            json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )

    def _today(self) -> str:
        return datetime.now(timezone.utc).date().isoformat()

    def used(self) -> int:
        data = self._load()
        if data.get("date") != self._today():
            return 0
        return int(data.get("count", 0))

    def remaining(self) -> int:
        return max(0, self.limit - self.used())

    def consume(self, n: int = 1) -> None:
        """n 回分消費する。上限超過なら RateLimitExceeded（状態は進めない）。"""
        data = self._load()
        today = self._today()
        count = 0 if data.get("date") != today else int(data.get("count", 0))
        if count + n > self.limit:
            raise RateLimitExceeded(count, self.limit)
        self._save({"date": today, "count": count + n, "limit": self.limit})

    def reset(self) -> None:
        self._save({"date": self._today(), "count": 0, "limit": self.limit})
