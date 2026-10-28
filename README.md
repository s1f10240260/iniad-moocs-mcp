# INIAD Moocs MCP Server

東洋大学 情報連携学部の LMS「Moocs」の情報を、Claude などの AI から直接取得・検索できる MCP サーバー。

詳細設計は [DESIGN.md](./DESIGN.md) を参照。

## 構成

```
iniad_mcp_dev/
├── DESIGN.md                 # 設計書
├── docs/ROADMAP.md           # 開発ロードマップ
├── docs/WORK_SPLIT.md        # 2名体制の仕事割り
├── collector/
│   ├── slides/               # collect-headless (Rust) — 非対話スライド収集ラッパー
│   └── contents/             # contents-collector (Python) — クイズ・課題収集
├── workers/                  # Cloudflare Workers (MCP + REST API)
├── db/                       # D1 スキーマ・マイグレーション
└── .github/workflows/        # 毎日 0:00 の収集ジョブ
```

## なぜラッパーが必要か

moocs-collect の公式 CLI (`collect-cli`) は `--path` と `--year` のみを受け取り、**実行後に対話形式で授業・講義を選択する**。GitHub Actions 等の非対話環境では使えない。

一方、コアの `collect` crate は UI 非依存のライブラリとしてヘッドレスに動作する。
そのため本プロジェクトでは公式 CLI を叩かず、**非対話ラッパー `collect-headless`** を自前で用意して自動収集を行う。

## クイックスタート（開発準備中）

```bash
# collector (slides) — Rust
cd collector/slides
cargo build

# collector (contents) — Python
cd collector/contents
uv sync   # または venv + pip install -e .

# workers — TypeScript
cd workers
npm install
```

現時点では骨格のみ。実装順は [docs/ROADMAP.md](./docs/ROADMAP.md) を参照。

## AI / MCP 接続手順

Claude Desktop などから Moocs を検索・取得するための手順。

### 1. セッショントークンを取る

```bash
curl -sS -X POST https://moocs-mcp.s1f102402608.workers.dev/login \
  -H 'content-type: application/json' \
  -d '{"username":"s1f102402608","password":"<Moocs パスワード>"}'
# → {"token_type":"Bearer","access_token":"...","expires_in":2592000}（30日）
```

`access_token` をコピーする。チャットや PR に貼らないこと。

### 2. MCP サーバーを登録

**Claude Desktop**（`%LOCALAPPDATA%\Claude-3p\configLibrary\<id>.json` の `managedMcpServers` など）:

```json
{
  "name": "iniad-moocs",
  "transport": "http",
  "url": "https://moocs-mcp.s1f102402608.workers.dev/mcp",
  "headers": {
    "Authorization": "Bearer <access_token>"
  }
}
```

- サーバー名は `moocs` にしないこと（管理側の予約名と衝突し、ツールがブロックされる）
- `command` / `args` の stdio 形式でも `npx mcp-remote <url> --header "Authorization: Bearer <token>"` で接続可

### 3. ツール一覧

| ツール | 役割 |
|---|---|
| `list_courses` | コースと講義 ID（`2026/CODE/LL`）一覧 |
| `get_lecture_info` | 講義詳細。`2026/INI201/02` / `2026/INI201` / `INI201` |
| `search_content` | クイズ・課題本文の部分一致検索（`limit` は 1–50） |
| `get_contents` | クイズ・課題 HTML |
| `get_slides` | スライド PDF の R2 キーとダウンロードパス |

### 4. 既知の制限

- トークンは **30 日**で失効。切れたら `/login` で取り直し
- スライド PDF は画像のため本文検索対象外（メタデータ＋ダウンロードのみ）
- REST: `GET /health`（公開）、`GET /api/search` / `/api/courses` / `/api/slides/...`（Bearer 必須）
