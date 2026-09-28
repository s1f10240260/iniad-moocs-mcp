# 開発ロードマップ

設計の詳細は [../DESIGN.md](../DESIGN.md) を参照。
本ドキュメントは実装の着手順と完了条件を定義する。

担当は [WORK_SPLIT.md](WORK_SPLIT.md) を参照（s1f10240260 = Collector / s1F10240055 = Cloud・MCP）。

## 前提（確定事項）

- 公式 `collect-cli` は非対話実行不可（`--path` / `--year` のみ、実行後に対話選択）
- コア `collect` crate はヘッドレス動作可能
- → **`collect-headless` ラッパー**を作り、CI から叩く
- クイズ・課題は別プロセスの Python + Playwright (`contents-collector`) で取得
- MCP / API は Cloudflare Workers + D1 + R2（無料枠内）

---

## Phase 0 — リポジトリ基盤（本フェーズ）

- [x] DESIGN.md にラッパー設計を反映
- [x] モノレポ骨格作成
- [ ] GitHub リポジトリ作成・初期 push
- [ ] Issue / Project ボード用ラベル定義（optional）

**完了条件:** リポジトリが共有でき、以降の Phase を並行開発できる

---

## Phase 1 — collect-headless（スライド収集ラッパー）

**場所:** `collector/slides/`

### 実装項目

1. `collect` crate への依存（git 依存、タグ or コミットピン）
2. 非対話 CLI（clap）:
   - `--year` / `--path` / `--all` / `--course` / `--lecture` / `--retries` / `--json` / `--quiet`
   - 対話プロンプト禁止。不足情報は exit code 2
3. ヘッドレス認証
   - `MOOCS_SESSION_COOKIE` 環境変数
   - `--cookie-jar <path>`
   - （ローカル用）`login` サブコマンドで Cookie 保存
4. 出力レイアウト: `{path}/{year}/{COURSE}/{LL}/slides.pdf`
5. JSON Lines 進捗出力
6. リトライ 3 回 → スキップ → サマリ終了コード

### 検証

- [ ] `--all` で 1 コース分が非対話で完走する
- [ ] セッション失効時に `auth_expired` で明示 fail する
- [ ] GitHub Actions ubuntu-latest 上でビルド・実行できる

**完了条件:** CI からスライド PDF 一式がローカル / Artifact に落ちる

---

## Phase 2 — contents-collector（クイズ・課題）

**場所:** `collector/contents/`

1. Playwright で Moocs `/problem` 関連の AJAX API を叩く
2. 出力: JSON（メタ）+ HTML（本文）
3. レート制限 100 回/日 を遵守
4. Phase 1 と同じ年度・コース ID 体系で命名

### 検証

- [ ] ミニクイズ 1 件・課題 1 件が HTML 付きで保存される
- [ ] 数式 (LaTeX) が壊れない

**完了条件:** スライドと同梱で contents バンドルが生成できる

---

## Phase 3 — データ基盤（D1 + R2）

**場所:** `db/`, アップロードスクリプト

1. D1 スキーマ: `courses` / `lectures` / `contents` + FTS5 (trigram)
2. R2 キー: `{year}/{course}/{lecture}/slides.pdf`
3. 収集物の upsert スクリプト（冪等）
4. ローカル D1（wrangler d1）での差分確認

### 検証

- [ ] trigram で日本語部分一致検索が通る
- [ ] 再実行で二重登録されない

**完了条件:** ローカル / staging D1 に実データが入る

---

## Phase 4 — Cloudflare Workers（MCP + API）

**場所:** `workers/`

1. REST API（list / get）
2. MCP ツール 5 種（`list_courses` / `get_lecture_info` / `get_slides` / `get_contents` / `search_content`）
3. 認証（INIAD Keycloak / OIDC）
4. Claude Desktop から URL 指定で疎通

### 検証

- [ ] Claude Desktop に tools が表示される
- [ ] ユースケース 1–3 が自然文で答えられる

**完了条件:** 学生が設定 1 行で利用開始できる

---

## Phase 5 — GitHub Actions 運用

1. 毎日 0:00 (UTC) 実行
2. Secrets: セッション Cookie / Cloudflare API Token
3. R2 / D1 へ反映
4. 失敗通知（GitHub Issues 自動起票 or Slack）

### 検証

- [ ] 手動 workflow_dispatch で一式が通る
- [ ] 3 回リトライ後のスキップがサマリに出る

**完了条件:** 人手なしで日次更新される

---

## 推奨着手順（今すぐ）

| 順 | 作業 | 担当領域 |
|----|------|---------|
| 1 | `collect` crate の public API 調査（lib.rs / service） | collector/slides |
| 2 | `collect-headless` の CLI 骨格 + 認証スタブ | collector/slides |
| 3 | 実際の 1 レクチャー PDF 生成の E2E | collector/slides |
| 4 | contents API の調査（/problem レスポンス観察） | collector/contents |
| 5 | D1 スキーマ草案 | db/ |

Phase 1 と Phase 4 は並行可能。Phase 3 は Phase 1 の出力形式が固まってからでよい。

---

## リスクと対応

| リスク | 影響 | 対応 |
|--------|------|------|
| `collect` crate の内部 API 変更 | ラッパー破損 | 依存をコミット/タグでピン。必要ならフォーク |
| Google セッション失効 | 収集停止 | Cookie 差し替え runbook を README に用意 |
| Moocs UI / AJAX 変更 | contents 収集破損 | レスポンス fixture を保存し回帰テスト |
| 著作権 | 配布不可 | 学内利用前提・公開リポジトリに PDF を commit しない |
| R2 / D1 無料枠超過 | 課金 | 容量メトリクスを月次で確認 |
