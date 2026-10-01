# INIAD Moocs MCP Server 設計書

## 概要

### プロジェクト背景

東洋大学 情報連携学部では、**Moocs**（https://moocs.iniad.org）という学部専用のLMSを使用して教育を行っている。

情報連携学部の学生の多くがGPTやClaudeなどのAIツールを使用しているが、Moocsの課題やスライド情報にAIから直接アクセスする手段が無いため、スクリーンショットを撮って貼り付けるなどの手間が掛かっている。

### プロジェクト目的

Moocsの情報をClaude AIで直接取得・検索できるMCPサーバーを開発し、学生の学習効率を向上させる。

### システム概要

```
┌─────────────────────────────────────────────────────────────────┐
│  データ収集層                                                    │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  GitHub Actions (毎日0時自動実行)                       │    │
│  │  - moocs-collect CLIを実行                             │    │
│  │  - MoocsからスライドPDFを生成                          │    │
│  │  - 課題・クイズ情報を取得                               │    │
│  └─────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│  クラウド層 (Cloudflare)                                        │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  R2 (オブジェクトストレージ)                            │    │
│  │  - スライドPDFファイル                                  │    │
│  │  - 10GB無料枠                                          │    │
│  └─────────────────────────────────────────────────────────┘    │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  D1 (SQLiteデータベース)                                │    │
│  │  - 講義メタデータ                                       │    │
│  │  - 課題情報                                             │    │
│  │  - 5GB無料枠                                           │    │
│  └─────────────────────────────────────────────────────────┘    │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  Workers (MCP Server + API)                             │    │
│  │  - MCPプロトコル対応                                    │    │
│  │  - REST API                                             │    │
│  │  - 認証 (INIAD Keycloak)                               │    │
│  │  - 10万リクエスト/日無料                                │    │
│  └─────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
                              ↑
                              │ HTTPS (MCPプロトコル)
                              │
┌─────────────────────────────────────────────────────────────────┐
│  ユーザーのPC                                                   │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  Claude Desktop / Claude Code                           │    │
│  │  - 設定ファイルでURLを指定するだけ                      │    │
│  │  - インストール不要                                     │    │
│  └─────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
```

### ユーザーのセットアップ

ユーザーは以下の設定ファイルを編集するだけで利用可能:

```json
// ~/.claude/claude_desktop_config.json
{
  "mcpServers": {
    "moocs": {
      "url": "https://moocs-mcp.your-name.workers.dev"
    }
  }
}
```

### 運用設定

| 項目 | 設定 |
|------|------|
| **対象年度** | 2026のみ |
| **対象講義** | 全講義 |
| **更新頻度** | 毎日0:00 |
| **障害対応** | 3回リトライ → スキップ |
| **レート制限** | 100回/日 |

### 費用

| サービス | 無料枠 | 見積もり使用量 | 月額 |
|---------|--------|--------------|------|
| GitHub Actions | 2,000分/月 | 900分 | ¥0 |
| Cloudflare R2 | 10GB | 5GB | ¥0 |
| Cloudflare D1 | 5GB | 100MB | ¥0 |
| Cloudflare Workers | 10万リクエスト/日 | 5万リクエスト/日 | ¥0 |
| **合計** | | | **¥0** |

## 取得可能なデータ

### 1. スライドPDF

| 項目 | 内容 |
|------|------|
| **取得方法** | moocs-collect CLI (SVG→PDF変換) |
| **品質** | 高品質 (テキスト・図表・数式を保持) |
| **保存先** | Cloudflare R2 |
| **更新頻度** | 毎日0:00 |
| **対象** | 2026年度 全講義 |

**取得フロー:**
```
Moocs → Google Slides embed → SVG抽出 → PDF変換 → R2保存
```

### 2. ミニクイズ

| 項目 | 内容 |
|------|------|
| **取得方法** | Moocs AJAX API (`/problem`) |
| **形式** | HTML |
| **保存先** | Cloudflare D1 |
| **内容** | 選択式・記述式問題、数式 (LaTeX) |

### 3. 課題

| 項目 | 内容 |
|------|------|
| **取得方法** | Moocs AJAX API (`/problem`) |
| **形式** | HTML |
| **保存先** | Cloudflare D1 |
| **内容** | 必修課題・発展課題 |

## 検索設計

### 検索対象

| テーブル | 検索対象フィールド | 用途 |
|---------|-------------------|------|
| **courses** | code, name, aliases | コース特定 |
| **lectures** | number, title | レクチャー特定 |
| **contents** | type, title, content_html | コンテンツ特定 |

### 検索方式: trigram (Cloudflare D1 FTS5)

```sql
-- コース検索
CREATE VIRTUAL TABLE courses_fts USING fts5(
    code,
    name,
    aliases,
    tokenize='trigram'
);

-- レクチャー検索
CREATE VIRTUAL TABLE lectures_fts USING fts5(
    number,
    title,
    tokenize='trigram'
);

-- コンテンツ検索
CREATE VIRTUAL TABLE contents_fts USING fts5(
    type,
    title,
    content_html,
    tokenize='trigram'
);
```

**trigramを選んだ理由:**
- 日本語の部分一致検索に対応
- 形態素解析が不要（シンプル）
- Cloudflare D1で無料利用可能
- 高速

## ユースケース

### ユースケース1: スライドの内容確認

```
ユーザー: 「データサイエンス基礎の第２回の内容について、
          KL divergenceの説明は合っていますか？」

処理:
1. courses_fts → "データサイエンス基礎" → INI201特定
2. lectures_fts → "第２回" → lecture_id特定
3. R2からPDF取得
4. ClaudeがPDFを読み込んで回答

回答:
「第２回のスライドp.15によると、KL divergenceの定義は...
 合っていますが、補足として...」
```

### ユースケース2: 課題内容の確認

```
ユーザー: 「ICT論Bの第３回の課題の内容を教えてください」

処理:
1. courses_fts → "ICT論B" → course_id特定
2. lectures_fts → "第３回" → lecture_id特定
3. contents → type='assignment' → 課題HTML取得
4. ClaudeがHTMLを読み込んで回答

回答:
「第３回の課題は、以下の内容です...
 ① ... ② ...」
```

### ユースケース3: ミニクイズの問題確認

```
ユーザー: 「データサイエンス基礎の第５回のミニクイズの問題は？」

処理:
1. courses_fts → "データサイエンス基礎" → INI201特定
2. lectures_fts → "第５回" → lecture_id特定
3. contents → type='quiz' → クイズHTML取得
4. ClaudeがHTMLを読み込んで回答

回答:
「第５回のミニクイズは以下の問題です...
 問1: ... 問2: ...」
```

## MCP Server設計

### 概要

クラウド上で動作するMCP Server。ユーザーはURLを指定するだけで利用可能。

### セットアップ（ユーザー側）

```json
// Claude Desktopの設定ファイル
{
  "mcpServers": {
    "moocs": {
      "url": "https://moocs-mcp.your-name.workers.dev"
    }
  }
}
```

### ツール一覧

| ツール名 | 機能 | 入力 | 出力 |
|---------|------|------|------|
| `list_courses` | 講義一覧取得 | year (任意) | コード、名前 |
| `get_lecture_info` | 講義詳細取得 | course_code | レクチャー一覧 |
| `get_slides` | スライドPDF取得 | course, lecture | PDF |
| `get_contents` | コンテンツ取得 | course, lecture, type | HTML |
| `search_content` | 全文検索 | query | 該当する講義・スライド |

## 認証設計

### 1. データ収集（GitHub Actions）

| 項目 | 内容 |
|------|------|
| **認証方式** | INIAD (Keycloak) + Google (SAML) |
| **アカウント** | 開発者1名のINIAD + Googleアカウント |
| **用途** | Moocsからスライド・課題を取得 |

### 2. データ利用（ユーザー）

| 項目 | 内容 |
|------|------|
| **認証方式** | INIAD (学籍番号+パスワード) |
| **アカウント** | 全ユーザーのINIADアカウント |
| **有効期限** | 無期限 |

## 技術スタック

| コンポーネント | 技術 |
|--------------|------|
| PDF生成（コア） | moocs-collect `collect` crate (Rust) |
| 非対話収集ラッパー | collect-headless (Rust, 本プロジェクト) |
| コンテンツ収集 | contents-collector (Python + Playwright) |
| MCP Server | Cloudflare Workers |
| API | Cloudflare Workers |
| データベース | Cloudflare D1 (FTS5: trigram) |
| ストレージ | Cloudflare R2 |
| CI/CD | GitHub Actions |
| 認証 | INIAD Keycloak |

## プログラミング言語・ライブラリ

### 1. データ収集 (GitHub Actions)

| コンポーネント | 言語 | ライブラリ/ツール |
|--------------|------|------------------|
| **スライドPDF取得** | Rust | `collect` crate + collect-headless（非対話ラッパー） |
| **クイズ・課題取得** | Python | Playwright, requests（contents-collector） |
| **CI オーケストレーション** | YAML / shell | GitHub Actions |

### 2. クラウド (Cloudflare Workers)

| コンポーネント | 言語 | ライブラリ/ツール |
|--------------|------|------------------|
| **MCP Server** | TypeScript | @modelcontextprotocol/sdk, agents-sdk |
| **API** | TypeScript | Cloudflare Workers API |
| **データベース** | SQL | Cloudflare D1 (SQLite) |

## 用語集

### moocs-collect

INIAD学部生が開発した「MoocsのスライドをPDFに保存する」オープンソースツール。

| 項目 | 内容 |
|------|------|
| **リポジトリ** | https://github.com/yu7400ki/moocs-collect |
| **開発言語** | Rust |
| **機能** | Google Slides embedからSVGを抽出し、PDFに変換 |
| **認証** | INIAD (Keycloak) + Google (SAML) が必要 |
| **使用方法** | CLI版、デスクトップアプリ版あり |
| **本プロジェクトでの利用** | 公式 CLI ではなく `collect` ライブラリを直接依存し、`collect-headless` としてラップ |

**動作原理:**
```
MoocsのGoogle Slides embed → HTMLからSVGを抽出 → svg2pdfでPDF変換
```

**利点:**
- 高品質なPDF生成（テキスト・図表・数式を保持）
- 画像埋め込み対応
- テキスト埋め込み対応（検索可能）

**アーキテクチャ:**

| レイヤー | 内容 | ヘッドレス可否 |
|---------|------|--------------|
| `collect` (Rust lib) | 認証・一覧取得・SVG抽出・PDF変換 | **可** |
| `collect-cli` (公式) | デスクトップ用途の対話 CLI | 不可（授業・講義を対話選択） |
| `collect-headless` (本プロジェクト) | CI 向け非対話ラッパー | **可** |

公式 CLI は `--path` / `--year` のみで、実行後に授業・講義・ページを対話選択する。
GitHub Actions での自動収集には使えないため、**コアライブラリを直接叩く非対話ラッパー `collect-headless` を自前で用意する**。
コアライブラリ自体は UI 非依存のため、この方式で問題ない。

### データ収集ラッパー設計 (`collect-headless`)

公式 CLI を使わず、`collect` クレート（モジュール `domain` / `repository` / `service` / `pdf`）を依存として使う非対話バイナリ。

```
GitHub Actions
      │
      ├─► collect-headless  ──(collect lib)──► Moocs / Google Slides
      │         │                                    │
      │         └─ slides/*.pdf ─────────────────────┘
      │
      └─► contents-collector (Python + Playwright)
                │
                └─ quizzes / assignments ──► JSON / HTML
```

**CLI インターフェース（非対話前提）:**

```bash
# 全講義・全レクチャーを一括収集（CI 本番）
collect-headless \
  --year 2026 \
  --path ./out \
  --all \
  --json

# 特定コースのみ（デバッグ）
collect-headless --year 2026 --path ./out --course INI201 --json

# 特定レクチャーのみ
collect-headless --year 2026 --path ./out --course INI201 --lecture 2 --json
```

| フラグ | 必須 | 説明 |
|-------|------|------|
| `--year` | ○ | 対象年度 |
| `--path` | ○ | 出力ディレクトリ |
| `--all` | ※ | 全講義を非対話で一括取得（CI 用） |
| `--course` | ※ | コースコード（`--all` か `--course` はどちらか必須） |
| `--lecture` |  | レクチャー番号。省略時は該当コース全件 |
| `--types` |  | `slides` のみ現状対応（contents は別プロセス） |
| `--retries` |  | 障害時リトライ回数（既定 3） |
| `--json` |  | 進捗・結果を JSON Lines で stdout へ |
| `--quiet` |  | ログ抑制（JSON 出力と併用） |

※ 対話プロンプトは**一切出さない**。選択情報が不足している場合は終了コード `2` で失敗させる。

**認証（ヘッドレス）:**

現行 `collect` crate（`Credentials` / `authenticate`）が **ユーザー名 + パスワード** のみ受け付けるため、Cookie ジャー方式は使わない。

| 方式 | 用途 | 備考 |
|------|------|------|
| 環境変数 `MOOCS_USERNAME` / `MOOCS_PASSWORD` | CI | Secrets から注入。ログ・JSONL に出さない |
| `--username` / `--password` | 非推奨 | プロセス一覧・履歴に残る。env `MOOCS_USERNAME` / `MOOCS_PASSWORD` を使うこと |
| `collect-headless auth-check` | 疎通確認 | 収集せず認証のみ（成功 0 / 失敗 1） |

Google (SAML) / Moocs セッションは実行ごとに認証して再取得する。失効時は Workflow を fail し、Secrets を更新する運用とする。

**出力レイアウト:**

```
out/
└── 2026/
    └── INI201/
        └── 02/
            └── slides.pdf
```

### 実際の lecture slug 例（2026 / INI201）

`collect` crate の `lecture.key.slug` は URL エンコードされていることがある。

| slug（生） | デコード後 | LL 導出 |
|---|---|---|
| `02` | `02` | 2 |
| `%E7%AC%AC7%E5%9B%9E` | `第7回` | 7 |
| `Week15` | `Week15` | 15 |
| `%E7%AC%AC15%E5%9B%9E` | `第15回` | 15（衝突 → スキップ、Issue #7） |
| `00` / `-00` | — | 1..=999 外 → スキップ |

CODE はコース slug が `[A-Za-z0-9_-]{1,32}` のときだけ使う（例: `INI201`）。

**JSON 進捗例:**

`course` は CODE（`[A-Za-z0-9_-]{1,32}`）、`lecture` は数値、`file` は `out/` からの相対パス。
`course_name` / `lecture_title` は任意（無い場合は省略可。取り込み側は既存値を上書きしない）。

```json
{"event":"start","year":2026,"course":"INI201","lecture":2}
{"event":"done","year":2026,"course":"INI201","lecture":2,"file":"2026/INI201/02/slides.pdf","pages":42,"course_name":"データサイエンス基礎","lecture_title":"第2回 確率分布とKLダイバージェンス"}
{"event":"error","year":2026,"course":"XXX999","lecture":1,"code":"auth_expired","message":"..."}
```

### INIAD Keycloak

INIAD（情報連携学部）が独自に運用している認証システム。

| 項目 | 内容 |
|------|------|
| **URL** | https://accounts.iniad.org |
| **認証方式** | OpenID Connect |
| **Client ID** | iniad-moocs |
| **ユーザー** | INIAD学部生（学籍番号） |

**認証フロー:**
```
1. Moocsにアクセス → INIAD Keycloakにリダイレクト
2. 学籍番号+パスワードを入力
3. 認証成功 → Moocsにリダイレクト
4. セッション開始
```

**使用箇所:**
- **データ収集**: 開発者がMoocsにログインする際
- **ユーザー認証**: MCPサーバーでユーザーを認証する際

## 制約・注意点

1. **Google認証**: moocs-collectはGoogleアカウントが必要（開発者のみ）
2. **セッション**: Googleセッションは有効期限あり（再認証が必要な場合あり）
3. **著作権**: スライドは教授の著作物（学内利用のみ）
4. **アップデート**: MoocsのUI変更に追従が必要
5. **公式CLIの非対話不可**: `collect-cli` は `--path` / `--year` のみで実行後に対話選択するため CI に使えない。**`collect-headless` ラッパーで代替する**
6. **ラッパー破壊的変更**: `collect` crate の内部 API はセマンティックバージョン外の変更があり得る。依存バージョンをピン留めし、破損時はフォークも検討する

