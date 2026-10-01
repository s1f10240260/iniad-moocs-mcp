# 仕事割り振り（2名体制）

前提・全体設計は [../DESIGN.md](../DESIGN.md)、フェーズ定義は [ROADMAP.md](ROADMAP.md)。

## ざっくりした切り方

**データ収集** と **クラウド配信** で分ける。インターフェース（出力パス・ID 体系・スキーマ）は先に固定してあるので、以降は並行して進められる。

| | メンバー A（あなた） | メンバー B |
|--|-------------------|-----------|
| **役割** | Collector 側 | Cloud / MCP 側 |
| **担当** | Phase 1–2 | Phase 3–4 |
| **共同** | Phase 5（GitHub Actions 本番投入） | |
| **主言語** | Rust / Python | TypeScript / SQL |
| **成果物** | `out/` 配下のスライド PDF・クイズ HTML | D1 + R2 + Workers MCP |

技術的な得意不得意があれば **A ↔ B の入替可**。境界だけは守る。

---

## メンバー A — Collector（Phase 1–2）

### Phase 1: `collect-headless`（`collector/slides/`）

- [ ] `collect` crate の public API 調査（`lib.rs` / `service` / `repository`）
- [x] 依存ピン（Cargo.toml に rev = 2ed9a33）して Cargo が解決することを確認
- [ ] 非対話 CLI の実装（骨格は `src/main.rs` にあり）
  - `--year` / `--path` / `--all` / `--course` / `--lecture` / `--retries` / `--json`
  - **対話プロンプト禁止**。不足は exit code `2`
- [ ] ヘッドレス認証
  - `MOOCS_SESSION_COOKIE` / `--cookie-jar`
  - ローカル用 `login` サブコマンド（Cookie 保存）
- [x] 1 レクチャー PDF 生成の E2E
- [x] リトライ（一時障害のみ）→ スキップ → JSON Lines サマリ

**完了条件:** Ubuntu 上で `--all --json` が非対話で完走し、`out/{year}/{COURSE}/{LL}/slides.pdf` が並ぶ

### Phase 2: `contents-collector`（`collector/contents/`）

- [ ] Moocs の `/problem` 系 AJAX API を観察（リクエスト・レスポンスを fixture 保存）
- [ ] Playwright セッションでのクイズ / 課題取得
- [ ] HTML 本文（LaTeX 保持）+ メタ JSON の出力
- [ ] レート制限 100 回/日を守るスロットリング

**完了条件:** ミニクイズ 1 件・課題 1 件が HTML 付きで落ちる

### 運用まわり（A 主担当）

- [ ] ログイン失敗・追加確認時の runbook（Secrets 更新、Phase 5 前に Actions で uth-check 疎通確認）
- [ ] 開発用アカウントでのセッション維持方法の整理

---

## メンバー B — Cloud / MCP（Phase 3–4）

### Phase 3: データ基盤（`db/`, アップロード）

- [ ] `db/migrations/` を実 D1 / ローカル D1 に適用し、FTS5 の日本語部分一致を検証（アプリ側バイグラムに変更。ローカル済み・実 D1 未）
- [x] `courses` / `lectures` / `contents` の upsert スクリプト（冪等）→ [INGEST.md](INGEST.md)
  - 入力: A の `out/` レイアウト + JSONL
  - R2 キー: `{year}/{course}/{lecture}/slides.pdf`
- [x] FTS テーブルへの同期（external content + トリガー）
- [x] 再実行で二重登録されないことのテスト（`npm run test:integration`）

**完了条件:** サンプル 1 コース分がローカル D1 + R2 mock に入り、SQL で検索できる

### Phase 4: Workers（`workers/`）

- [ ] REST API: `list_courses` / `get_lecture_info` / `get_contents` / `search_content`
- [ ] `get_slides` — R2 から PDF を返す（署名 URL or 直接）
- [ ] MCP ツール 5 種を `@modelcontextprotocol/sdk` で公開
  - `list_courses` / `get_lecture_info` / `get_slides` / `get_contents` / `search_content`
- [ ] INIAD Keycloak (OIDC) 認証
- [ ] Claude Desktop の `url` 設定だけで tools が見えることの確認

**完了条件:** DESIGN のユースケース 1–3 を Claude から自然に実行できる

### ドキュメンタッチ（B 副担当）

- [ ] ユーザー向けセットアップ（`claude_desktop_config.json` の 1 行設定）を README に

---

## 共有インターフェース（勝手に変えない）

以下は DESIGN.md に書いてある通り固定。変更する場合は **両者合意 + DESIGN.md 更新**。

| 項目 | 形式 |
|------|------|
| コース ID | `{year}/{CODE}` 例: `2026/INI201` |
| レクチャー ID | `{year}/{CODE}/{LL}` 例: `2026/INI201/02` |
| スライドパス | `{path}/{year}/{CODE}/{LL}/slides.pdf` |
| 進捗ログ | JSON Lines（`start` / `done` / `error`） |
| contents の type | `quiz` \| `assignment` \| `slide` |
| 認証 env | `MOOCS_SESSION_COOKIE` / `MOOCS_COOKIE_JAR` |
| exit code | 成功 0 / 実行時失敗 1 / 引数不足・対話要求 2 |

### 成果物の受け渡し

```
A: collector 実行
      │  out/2026/...           ← PDF / HTML
      │  collect-*.jsonl        ← 進捗・メタ
      ▼
B: upsert (D1 + R2)
      │
      ▼
B: Workers MCP / API
```

B は A の最終出力レイアウトが固まるまで fixture で開発してよい。fixture は `tests/fixtures/sample-out/` に置く。

---

## 週次の同期ポイント

| いつ | 何を決める |
|------|-----------|
| 並行開始時点 | この割りでよいか、ID / パス体系の最終確認 |
| A: Phase 1 E2E 通過時点 | 実 `out/` サンプルを B に渡す |
| B: Phase 3 upsert 完了時点 | 実データ投入の可否・スキーマ微調整 |
| Phase 5 手前 | Secrets（MOOCS_USERNAME / MOOCS_PASSWORD / CF トークン）の持ち方、失敗通知先 |

---

## リスクの担当

| リスク | 担当 | 対応 |
|--------|------|------|
| `collect` crate API 変更 | A | 依存ピン / フォーク検討 |
| Google ログインのブロック・追加確認 | A | Phase 5 前に Actions で uth-check 疎通確認 / Secrets 更新 |
| Moocs AJAX 変更 | A | fixture 回帰で検知 |
| D1 / R2 無料枠 | B | 月次容量チェック |
| Keycloak 認証実装 | B | ローカル疎通 → staging |
| 著作権（PDF を git に入れない） | 両者 | `.gitignore` + レビュー |

---

## 入替用スプリット（スキル都合で A/B を入れ替える場合）

**B が Collector、A が Cloud** なら以下だけ差し替える。境界は同じ。

- A の担当 → Phase 3–4（TypeScript / SQL / MCP）
- B の担当 → Phase 1–2（Rust / Python / Playwright）
- Phase 5 は「ビルドと deploy を作った側が主、Cookie を扱う側が副」
