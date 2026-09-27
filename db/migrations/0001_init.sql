-- INIAD Moocs MCP — Cloudflare D1 schema (migration 0001)
-- 詳細設計: ../../DESIGN.md 「検索設計」 / ../../docs/INGEST.md
--
-- スキーマ変更は既存ファイルを編集せず、0002_xxx.sql のように新しい migration を追加すること。
-- 適用: cd workers && npm run db:local（本番は npm run db:remote）
--
-- 設計メモ
-- - 各テーブルは内部キー rid (INTEGER PRIMARY KEY) を持ち、FTS5 の rowid と一致させる。
--   暗黙 rowid は VACUUM で変わり得るため、明示的な INTEGER PRIMARY KEY を使う。
-- - 公開 ID は id (TEXT UNIQUE)。例: "2026/INI201/02"。外部キーも id を参照する。
-- - *_fts は external content テーブル。本体の変更はトリガーで同期する。
-- - 検索はアプリ側バイグラム（workers/src/search/bigram.ts）。*_bg 列にバイグラム化した
--   テキストを入れ、FTS5 は unicode61 で空白区切りのトークンとして索引する。
--   *_bg は必ず同じ行の元の列から toBigramText() で作ること（ingest が担当）。
-- - upsert は `INSERT ... ON CONFLICT(id) DO UPDATE` を使うこと。
--   `INSERT OR REPLACE` は rid が変わり、FTS 同期トリガーも正しく動かない。

-- 外部キーは D1 では常に有効（migration はトランザクション内で走るため PRAGMA foreign_keys は効かない）

CREATE TABLE IF NOT EXISTS courses (
    rid         INTEGER PRIMARY KEY,
    id          TEXT NOT NULL UNIQUE,      -- 例: "2026/INI201"
    year        INTEGER NOT NULL,
    code        TEXT NOT NULL,             -- 例: "INI201"
    name        TEXT NOT NULL,
    aliases     TEXT NOT NULL DEFAULT '',  -- カンマ区切りの略称・別名
    code_bg     TEXT NOT NULL DEFAULT '',  -- 以下 *_bg は検索用バイグラム
    name_bg     TEXT NOT NULL DEFAULT '',
    aliases_bg  TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (year, code)
);

CREATE TABLE IF NOT EXISTS lectures (
    rid         INTEGER PRIMARY KEY,
    id          TEXT NOT NULL UNIQUE,      -- 例: "2026/INI201/02"
    course_id   TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    number      INTEGER NOT NULL,          -- レクチャー番号
    title       TEXT NOT NULL DEFAULT '',
    title_bg    TEXT NOT NULL DEFAULT '',
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (course_id, number)
);

CREATE TABLE IF NOT EXISTS contents (
    rid          INTEGER PRIMARY KEY,
    id           TEXT NOT NULL UNIQUE,     -- 例: "2026/INI201/02/quiz"
    lecture_id   TEXT NOT NULL REFERENCES lectures(id) ON DELETE CASCADE,
    type         TEXT NOT NULL CHECK (type IN ('quiz', 'assignment', 'slide')),
    title        TEXT NOT NULL DEFAULT '',
    content_html TEXT NOT NULL DEFAULT '', -- 表示・MCP 返却用（LaTeX 保持）
    content_text TEXT NOT NULL DEFAULT '', -- HTML タグ除去済みテキスト（スニペット表示用）
    title_bg     TEXT NOT NULL DEFAULT '',
    text_bg      TEXT NOT NULL DEFAULT '', -- content_text のバイグラム
    r2_key       TEXT,                     -- slides.pdf など R2 オブジェクトキー
    sha256       TEXT,                     -- R2 オブジェクトのハッシュ（差分アップロード判定）
    updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (lecture_id, type)
);

CREATE INDEX IF NOT EXISTS idx_lectures_course ON lectures (course_id);
CREATE INDEX IF NOT EXISTS idx_contents_lecture ON contents (lecture_id);
CREATE INDEX IF NOT EXISTS idx_contents_type ON contents (type);

-- ---------------------------------------------------------------------------
-- 全文検索（アプリ側バイグラム + unicode61）
-- 2 文字の語は連続バイグラムのフレーズ、1 文字は前方一致で引く（toBigramQuery）。
-- 注意: FTS5 の snippet() / highlight() はバイグラム列を返すので使わない。
--       スニペットは content_text からアプリ側で作る。
-- ---------------------------------------------------------------------------

CREATE VIRTUAL TABLE IF NOT EXISTS courses_fts USING fts5(
    code_bg,
    name_bg,
    aliases_bg,
    content = 'courses',
    content_rowid = 'rid',
    tokenize = 'unicode61 remove_diacritics 0'
);

-- レクチャー番号は数値で引く（「第２回」→ 2 の正規化はアプリ側）。FTS はタイトルのみ。
CREATE VIRTUAL TABLE IF NOT EXISTS lectures_fts USING fts5(
    title_bg,
    content = 'lectures',
    content_rowid = 'rid',
    tokenize = 'unicode61 remove_diacritics 0'
);

-- type は FTS に入れず contents.type で絞り込む。HTML ではなく content_text 由来のバイグラムを索引する。
CREATE VIRTUAL TABLE IF NOT EXISTS contents_fts USING fts5(
    title_bg,
    text_bg,
    content = 'contents',
    content_rowid = 'rid',
    tokenize = 'unicode61 remove_diacritics 0'
);

-- courses ⇄ courses_fts
CREATE TRIGGER IF NOT EXISTS courses_fts_ai AFTER INSERT ON courses BEGIN
    INSERT INTO courses_fts (rowid, code_bg, name_bg, aliases_bg)
    VALUES (new.rid, new.code_bg, new.name_bg, new.aliases_bg);
END;

CREATE TRIGGER IF NOT EXISTS courses_fts_ad AFTER DELETE ON courses BEGIN
    INSERT INTO courses_fts (courses_fts, rowid, code_bg, name_bg, aliases_bg)
    VALUES ('delete', old.rid, old.code_bg, old.name_bg, old.aliases_bg);
END;

CREATE TRIGGER IF NOT EXISTS courses_fts_au AFTER UPDATE OF code_bg, name_bg, aliases_bg ON courses BEGIN
    INSERT INTO courses_fts (courses_fts, rowid, code_bg, name_bg, aliases_bg)
    VALUES ('delete', old.rid, old.code_bg, old.name_bg, old.aliases_bg);
    INSERT INTO courses_fts (rowid, code_bg, name_bg, aliases_bg)
    VALUES (new.rid, new.code_bg, new.name_bg, new.aliases_bg);
END;

-- lectures ⇄ lectures_fts
CREATE TRIGGER IF NOT EXISTS lectures_fts_ai AFTER INSERT ON lectures BEGIN
    INSERT INTO lectures_fts (rowid, title_bg) VALUES (new.rid, new.title_bg);
END;

CREATE TRIGGER IF NOT EXISTS lectures_fts_ad AFTER DELETE ON lectures BEGIN
    INSERT INTO lectures_fts (lectures_fts, rowid, title_bg) VALUES ('delete', old.rid, old.title_bg);
END;

CREATE TRIGGER IF NOT EXISTS lectures_fts_au AFTER UPDATE OF title_bg ON lectures BEGIN
    INSERT INTO lectures_fts (lectures_fts, rowid, title_bg) VALUES ('delete', old.rid, old.title_bg);
    INSERT INTO lectures_fts (rowid, title_bg) VALUES (new.rid, new.title_bg);
END;

-- contents ⇄ contents_fts
CREATE TRIGGER IF NOT EXISTS contents_fts_ai AFTER INSERT ON contents BEGIN
    INSERT INTO contents_fts (rowid, title_bg, text_bg)
    VALUES (new.rid, new.title_bg, new.text_bg);
END;

CREATE TRIGGER IF NOT EXISTS contents_fts_ad AFTER DELETE ON contents BEGIN
    INSERT INTO contents_fts (contents_fts, rowid, title_bg, text_bg)
    VALUES ('delete', old.rid, old.title_bg, old.text_bg);
END;

CREATE TRIGGER IF NOT EXISTS contents_fts_au AFTER UPDATE OF title_bg, text_bg ON contents BEGIN
    INSERT INTO contents_fts (contents_fts, rowid, title_bg, text_bg)
    VALUES ('delete', old.rid, old.title_bg, old.text_bg);
    INSERT INTO contents_fts (rowid, title_bg, text_bg)
    VALUES (new.rid, new.title_bg, new.text_bg);
END;
