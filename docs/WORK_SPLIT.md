# 仕事割り振り

前提・全体設計は [../DESIGN.md](../DESIGN.md)、フェーズ定義は [ROADMAP.md](ROADMAP.md)。

## 決定済みアサイン

**データ収集** と **クラウド配信** で分ける。インターフェース（出力パス・ID 体系・スキーマ）は先に固定してあるので、以降は並行して進められる。

| | s1f10240260（リード） | s1F10240055 |
|--|---------------------|-------------|
| **役割** | **Collector 側** | **Cloud / MCP 側** |
| **担当** | Phase 1–2 | Phase 3–4 |
| **共同** | Phase 5（GitHub Actions 本番投入） | |
| **主言語** | Rust / Python | TypeScript / SQL |
| **成果物** | `out/` 配下のスライド PDF・クイズ HTML | D1 + R2 + Workers MCP |

### 観察者（開発参加なし）

| GitHub | 状態 |
|--------|------|
| [Yuji181181](https://github.com/Yuji181181) | **ウォッチのみ** — コード変更・Issue 担当なし |
| [Ryosuke-Asano](https://github.com/Ryosuke-Asano) | **ウォッチのみ** — コード変更・Issue 担当なし |

- **実装・PR・Issue 担当はしない**（ウォッチ / コメントのみ）
- 権限は個人リポジトリの制約で write 表示だが、**push しないこと**
- 進捗確認や議論へのコメントは歓迎。実装タスクは #1 / #2 の 2 名に集約

境界（ID 体系・`out/` パス・JSONL・exit code）は変更しない。

---

## s1f10240260 — Collector（Phase 1–2）

### Phase 1: `collect-headless`（`collector/slides/`）

- [x] `collect` crate の public API 調査（`lib.rs` / `service` / `repository`）
- [x] 依存ピン（git tag or commit）して Cargo が解決することを確認（`2ed9a33`）
- [x] 非対話 CLI の実装（`src/main.rs`）
  - `--year` / `--path` / `--all` / `--course` / `--lecture` / `--retries` / `--json`
  - **対話プロンプト禁止**。不足は exit code `2`
- [x] ヘッドレス認証（現行 `collect` crate はユーザー名 + パスワードのみ）
  - `MOOCS_USERNAME` / `MOOCS_PASSWORD`（または `--username` / `--password`）
  - `auth-check` サブコマンド（認証のみ疎通確認）
  - ※ Cookie ジャーは crate 非対応のため不採用（DESIGN を更新）
- [x] 出力契約: `out/{year}/{CODE}/{LL:02}/slides.pdf` + JSONL（`course`=CODE / `lecture`=数値 / `file`=相対）
- [ ] 1 レクチャー PDF 生成の E2E（実アカウント）
- [x] リトライ（指数バックオフ）→ スキップ → JSON Lines サマリ
- [ ] `cargo test` 実行（ヘルパー単体テスト追加済み。実行には `dlltool` 必要）

**完了条件:** Ubuntu 上で `--all --json` が非対話で完走し、`out/{year}/{COURSE}/{LL}/slides.pdf` が並ぶ

### Phase 2: `contents-collector`（`collector/contents/`）

- [ ] Moocs の `/problem` 系 AJAX API を観察（リクエスト・レスポンスを fixture 保存）
- [ ] Playwright セッションでのクイズ / 課題取得
- [ ] HTML 本文（LaTeX 保持）+ メタ JSON の出力
- [ ] レート制限 100 回/日を守るスロットリング

**完了条件:** ミニクイズ 1 件・課題 1 件が HTML 付きで落ちる

### 運用まわり（A 主担当）

- [ ] Cookie 失効時の差し替え runbook（README or docs/）
- [ ] 開発用アカウントでのセッション維持方法の整理

---

## s1F10240055 — Cloud / MCP（Phase 3–4）

### Phase 3: データ基盤（`db/`, アップロード）

- [ ] `db/schema.sql` を実 D1 / ローカル D1 に適用し、FTS5 trigram の日本語部分一致を検証
- [ ] `courses` / `lectures` / `contents` の upsert スクリプト（冪等）
  - 入力: A の `out/` レイアウト + JSONL
  - R2 キー: `{year}/{course}/{lecture}/slides.pdf`
- [ ] FTS テーブルへの同期（本体 or トリガー方針を決めて実装）
- [ ] 再実行で二重登録されないことのテスト

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
| 認証 env | `MOOCS_USERNAME` / `MOOCS_PASSWORD`（Secrets。平文出力禁止） |
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
| 並行開始時点 | ID / パス体系の最終確認 |
| Collector: Phase 1 E2E 通過時点 | 実 `out/` サンプルを s1F10240055 に渡す |
| Cloud: Phase 3 upsert 完了時点 | 実データ投入の可否・スキーマ微調整 |
| Phase 5 手前 | Secrets（Cookie / CF トークン）の持ち方、失敗通知先 |

---

## リスクの担当

| リスク | 担当 | 対応 |
|--------|------|------|
| `collect` crate API 変更 | s1f10240260 | 依存ピン / フォーク検討 |
| Google セッション失効 | s1f10240260 | runbook どおり差し替え |
| Moocs AJAX 変更 | s1f10240260 | fixture 回帰で検知 |
| D1 / R2 無料枠 | s1F10240055 | 月次容量チェック |
| Keycloak 認証実装 | s1F10240055 | ローカル疎通 → staging |
| 著作権（PDF を git に入れない） | 両者 | `.gitignore` + レビュー |

---

## 補足

- 開発は **s1f10240260（Collector）+ s1F10240055（Cloud/MCP）の 2 名**
- Yuji181181 / Ryosuke-Asano は観察のみ（実装・PR はしない運用）
- GitHub 個人リポジトリの API 制約で、collaborator 権限は write のみ付与可能。**真の read-only が必要なら Org へ移行**（docs/WORK_SPLIT.md の運用ルールで抑止中）
- 上記は実力向上目的で s1f10240260 が Collector（Rust 側）を希望した結果
