/**
 * manifest から冪等な upsert SQL を組み立てる。
 *
 * - `INSERT ... ON CONFLICT(id) DO UPDATE ... WHERE <値が変わった>` にして、
 *   再実行しても行数・rid が変わらず、変更のない行には書き込みも FTS 更新も発生させない。
 * - Collector が出さなかった値（講義名など）は更新対象から外し、既存値を残す。
 * - 検索用の *_bg 列は元の列と必ずセットで入れる・更新する（片方だけ変わると検索がずれる）。
 */

import { toBigramText } from "../src/search/bigram.js";
import type { ContentType, Manifest } from "./manifest.js";

/** D1 の 1 SQL 文あたりの上限（100KB）。余裕を持たせる */
export const MAX_STATEMENT_BYTES = 95_000;

export interface ContentRow {
  id: string;
  lectureId: string;
  type: ContentType;
  title?: string;
  contentHtml: string;
  contentText: string;
  r2Key: string | null;
  sha256: string | null;
}

export interface BuildResult {
  statements: string[];
  /** D1 の文長制限を超えるため投入しなかった contents の id */
  oversized: string[];
}

type SqlValue = string | number | null;

export function sqlLiteral(v: SqlValue): string {
  if (v === null) return "NULL";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error(`non-finite number: ${v}`);
    return String(v);
  }
  return `'${v.replace(/'/g, "''")}'`;
}

/**
 * @param insert INSERT 時に入れる全カラム
 * @param managed 既存行があるときに上書きするカラム（insert のサブセット）
 */
function upsert(table: string, insert: Record<string, SqlValue>, managed: string[]): string {
  const cols = Object.keys(insert);
  const head =
    `INSERT INTO ${table} (${cols.join(", ")}) ` +
    `VALUES (${cols.map((c) => sqlLiteral(insert[c])).join(", ")}) ON CONFLICT(id) DO `;
  if (managed.length === 0) return `${head}NOTHING;`;
  const set = managed.map((c) => `${c} = excluded.${c}`).join(", ");
  const changed = managed.map((c) => `${table}.${c} IS NOT excluded.${c}`).join(" OR ");
  return `${head}UPDATE SET ${set}, updated_at = datetime('now') WHERE ${changed};`;
}

/** 元の列と、そのバイグラム列 `${col}_bg` */
function withBigram(col: string, value: string): Record<string, string> {
  return { [col]: value, [`${col}_bg`]: toBigramText(value) };
}

export function buildStatements(
  manifest: Manifest,
  contents: ContentRow[],
  aliases: ReadonlyMap<string, string[]> = new Map(),
): BuildResult {
  const statements: string[] = [];
  const oversized: string[] = [];

  for (const c of manifest.courses.values()) {
    const managed: string[] = [];
    if (c.name !== undefined) managed.push("name", "name_bg");
    const alias = aliases.get(c.code);
    if (alias !== undefined) managed.push("aliases", "aliases_bg");
    statements.push(
      upsert(
        "courses",
        {
          id: c.id,
          year: c.year,
          ...withBigram("code", c.code),
          ...withBigram("name", c.name ?? c.code),
          ...withBigram("aliases", alias?.join(",") ?? ""),
        },
        managed,
      ),
    );
  }

  for (const l of manifest.lectures.values()) {
    statements.push(
      upsert(
        "lectures",
        { id: l.id, course_id: l.courseId, number: l.number, ...withBigram("title", l.title ?? "") },
        l.title !== undefined ? ["title", "title_bg"] : [],
      ),
    );
  }

  for (const c of contents) {
    const managed = ["content_html", "content_text", "text_bg", "r2_key", "sha256"];
    if (c.title !== undefined) managed.unshift("title", "title_bg");
    const stmt = upsert(
      "contents",
      {
        id: c.id,
        lecture_id: c.lectureId,
        type: c.type,
        ...withBigram("title", c.title ?? ""),
        content_html: c.contentHtml,
        content_text: c.contentText,
        text_bg: toBigramText(c.contentText),
        r2_key: c.r2Key,
        sha256: c.sha256,
      },
      managed,
    );
    if (Buffer.byteLength(stmt, "utf8") > MAX_STATEMENT_BYTES) {
      oversized.push(c.id);
      continue;
    }
    statements.push(stmt);
  }

  return { statements, oversized };
}
