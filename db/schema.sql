-- INIAD Moocs MCP — Cloudflare D1 schema
-- 詳細設計: ../DESIGN.md 「検索設計」

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS courses (
    id          TEXT PRIMARY KEY,          -- 例: "2026/INI201"
    year        INTEGER NOT NULL,
    code        TEXT NOT NULL,             -- 例: "INI201"
    name        TEXT NOT NULL,
    aliases     TEXT NOT NULL DEFAULT '',  -- カンマ区切りの略称・別名
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (year, code)
);

CREATE TABLE IF NOT EXISTS lectures (
    id          TEXT PRIMARY KEY,          -- 例: "2026/INI201/02"
    course_id   TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    number      INTEGER NOT NULL,          -- レクチャー番号
    title       TEXT NOT NULL DEFAULT '',
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (course_id, number)
);

CREATE TABLE IF NOT EXISTS contents (
    id           TEXT PRIMARY KEY,         -- 例: "2026/INI201/02/quiz"
    lecture_id   TEXT NOT NULL REFERENCES lectures(id) ON DELETE CASCADE,
    type         TEXT NOT NULL,            -- 'quiz' | 'assignment' | 'slide'
    title        TEXT NOT NULL DEFAULT '',
    content_html TEXT NOT NULL DEFAULT '',
    r2_key       TEXT,                     -- slides.pdf など R2 オブジェクトキー
    updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (lecture_id, type)
);

-- 日本語部分一致のため trigram
CREATE VIRTUAL TABLE IF NOT EXISTS courses_fts USING fts5(
    code,
    name,
    aliases,
    tokenize = 'trigram'
);

CREATE VIRTUAL TABLE IF NOT EXISTS lectures_fts USING fts5(
    number,
    title,
    tokenize = 'trigram'
);

CREATE VIRTUAL TABLE IF NOT EXISTS contents_fts USING fts5(
    type,
    title,
    content_html,
    tokenize = 'trigram'
);

CREATE INDEX IF NOT EXISTS idx_lectures_course ON lectures (course_id);
CREATE INDEX IF NOT EXISTS idx_contents_lecture ON contents (lecture_id);
CREATE INDEX IF NOT EXISTS idx_contents_type ON contents (type);
CREATE INDEX IF NOT EXISTS idx_courses_year_code ON courses (year, code);
