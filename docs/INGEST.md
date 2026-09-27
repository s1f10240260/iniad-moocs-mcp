# ingest — Collector 出力を D1 / R2 に反映する

Phase 3 の成果物。Collector（Phase 1–2）の `out/` と JSON Lines を読み、D1 と R2 に**冪等に** upsert する。

- コード: [`workers/ingest/`](../workers/ingest/)
- スキーマ: [`db/schema.sql`](../db/schema.sql)
- fixture: [`tests/fixtures/sample-out/`](../tests/fixtures/sample-out/)

## 使い方

```bash
cd workers
npm install

# ローカル D1 にスキーマを適用（初回のみ・何度流しても安全）
npm run db:local

# fixture を投入（ローカル D1 + R2 モック）
npm run ingest:fixture

# 実データ
npm run ingest -- \
  --out ../out \
  --jsonl ../collect-slides.jsonl \
  --jsonl ../collect-contents.jsonl \
  [--aliases ../db/aliases.json] [--remote] [--dry-run]
```

| オプション | 説明 |
|---|---|
| `--out` | Collector の出力ルート（`{year}/{CODE}/{LL}/...`） |
| `--jsonl` | `collect-*.jsonl`（複数可） |
| `--aliases` | コース別名 `{"INI201": ["DS基礎"]}`。指定したコースだけ `courses.aliases` を上書き |
| `--remote` | 本番 D1 / R2 に反映（既定はローカル） |
| `--persist-to` | ローカル D1 / R2 の保存先（テスト用） |
| `--force-upload` | ハッシュが同じ PDF も再アップロード |
| `--concurrency` | R2 アップロード並列数（既定: ローカル 1 / リモート 4） |
| `--dry-run` | D1 / R2 に触れず SQL を stdout に出す（イベントは stderr） |

出力は JSON Lines（`uploaded` / `rejected` / `missing_file` / `oversized` / `summary`）。

exit code は Collector と同じ契約: **成功 0 / 実行時失敗 1 / 引数不足 2**。
契約違反の行（`rejected`）・ファイル欠落・D1 文長超過があった場合は、正常分を反映したうえで 1 を返す。
Collector の `error` イベント（3 回リトライ後スキップ）は想定内として 0。そのレクチャーは前回のデータが残る。

## 処理の流れ

1. JSONL の `done` イベントから course / lecture / content を組み立てる（同じキーは後勝ち）
2. `file` が契約どおりのパスか検証（それ以外は `rejected`。パストラバーサル対策も兼ねる）
3. スライド PDF の sha256 を D1 の既存値と比べ、**変わったものだけ** R2 にアップロード
4. R2 → D1 の順で反映（D1 が存在しない R2 オブジェクトを指さないように）
5. D1 は `INSERT ... ON CONFLICT(id) DO UPDATE ... WHERE <値が変わった>` で upsert
   - 再実行しても行数・`rid`・`updated_at` が変わらない
   - 変更のない行には書き込みも FTS 更新も起きない（D1 の書き込み行数を節約）
   - Collector が値を出さなかった項目（講義名など）は既存値を残す

## スキーマ上の決定（Phase 3）

- **FTS は external content + トリガー同期。** `*_fts` の `rowid` = 本体の `rid`（明示的な `INTEGER PRIMARY KEY`）。
  暗黙 rowid は VACUUM で変わり得るため使わない。検索結果は `JOIN ... ON b.rid = f.rowid` で本体に戻す。
- upsert は必ず `ON CONFLICT(id) DO UPDATE`。`INSERT OR REPLACE` は `rid` が変わり FTS 同期が壊れるので禁止。
- `contents.content_text`（HTML タグ除去済み）を追加。`<script>` の中身や属性値は検索対象にならない。LaTeX は文字列として残る。表示用は `content_html`。
- `contents.sha256` を追加（R2 差分アップロード判定）。
- `lectures_fts` はタイトルのみ。レクチャー番号は数値列で引く。
- `contents.type` に CHECK 制約（`quiz` / `assignment` / `slide`）。

### 検索方式: アプリ側バイグラム

D1 は SQLite の拡張・カスタムトークナイザを読み込めず、組み込みは `unicode61` / `ascii` / `porter` / `trigram` のみ。
trigram は **2 文字以下の語（「課題」「統計」など）を検索できない**ため、アプリ側でバイグラム化する。

- [`workers/src/search/bigram.ts`](../workers/src/search/bigram.ts) を ingest と Workers で共有する（索引時と検索時の分割がずれると検索が壊れる）。
- 索引: `toBigramText()` で `データ基礎` → `デー ータ タ基 基礎 礎` にして `*_bg` 列に入れ、FTS5 は `unicode61` で空白区切りのトークンとして索引する。
- 検索: `toBigramQuery()` で MATCH 式にする。
  - 2 文字以上 → 連続バイグラムのフレーズ（`"サイ イエ エン ンス"`）。部分文字列一致と同じ意味になる。
  - 1 文字 → 前方一致（`"問"*`）。
  - 空白区切りの複数語 → AND。
  - 記号は区切りとして捨てるので、FTS5 の構文（`OR` / `NEAR` / `"` など）は注入されない。
- NFKC + 小文字化するので、`第２回` と `第2回`、`ＩＣＴ` と `ict` は一致する。
- FTS5 の `snippet()` / `highlight()` はバイグラム列を返すので使わない。スニペットは `content_text` からアプリ側で作る（Phase 4）。
- トレードオフ: 索引用の `*_bg` 列のぶん D1 の容量が増える（本文の約 2〜3 倍）。無料枠 5GB に対して問題ない見込み。

## Collector への入力契約（要合意）

`docs/WORK_SPLIT.md` の固定事項（ID・パス・`start`/`done`/`error`・exit code）は変えていない。
以下は **任意フィールドの追加と contents のファイル名**で、@s1f10240260 と合意が必要。

### collect-headless（スライド）

```json
{"event":"done","year":2026,"course":"INI201","lecture":2,"file":"2026/INI201/02/slides.pdf","pages":42,
 "course_name":"データサイエンス基礎","lecture_title":"第2回 確率分布とKLダイバージェンス"}
```

- `course_name` / `lecture_title` は任意。`collect` crate の `Course.name` / `Lecture.name` をそのまま出してほしい。
  無い場合、コース名はコードで仮登録し、既存の名前は上書きしない。

### contents-collector（クイズ・課題）

```json
{"event":"done","year":2026,"course":"INI201","lecture":2,"type":"quiz","file":"2026/INI201/02/quiz.html","title":"第2回 ミニクイズ"}
```

- `file` は `{year}/{CODE}/{LL}/{type}.html` 固定（`type` は `quiz` | `assignment`）。
- 1 レクチャーにつき type ごとに 1 ファイル（`contents` の `UNIQUE (lecture_id, type)`）。
  複数問ある場合は Collector 側で 1 つの HTML にまとめる。
- `title` は任意。

## 未決事項

- 本番 D1 での検索検証：`wrangler.toml` の `database_id` が `REPLACE_ME` のままなので、D1 作成後に `npm run db:remote` → `ingest --remote` で確認する。
- 1 回目の本番投入は全 PDF をアップロードするため時間がかかる（wrangler 1 プロセス / ファイル）。
  CI の 60 分に収まらなければ、R2 の S3 互換 API での一括アップロードに切り替える。
- スライド本文の全文検索（PDF → テキスト抽出）は未対応。`slide` 行の `content_text` は空。
- D1 の 1 文 100KB 制限を超える contents は `oversized` として投入しない。
  バイグラム列も同じ文に入るため、日本語本文でおよそ 7,000 字が上限の目安。
  実データで頻発するなら、D1 HTTP API のバインド変数での投入に切り替える（バインド値は 1 行 2MB まで）。
