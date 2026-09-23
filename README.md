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
