/**
 * 検索 API 用の D1 クエリ。
 * FTS5 は bigram.ts の toBigramQuery() で組み立てる（ingest と共有）。
 */

/// <reference types="@cloudflare/workers-types" />
import { toBigramQuery } from "./bigram.js";

export interface SearchHit {
  id: string;
  type: string;
  title: string;
  course: string;
  lecture: string;
  snippet: string;
}

function sqlLiteral(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

/** content_text から短いスニペットを作る（FTS snippet はバイグラム列を返すため使わない） */
export function makeSnippet(text: string, query: string, width = 120): string {
  const norm = text.normalize("NFKC").toLowerCase();
  const q = query.normalize("NFKC").toLowerCase().slice(0, 24);
  const idx = q ? norm.indexOf(q) : 0;
  const start = Math.max(0, idx < 0 ? 0 : idx - 20);
  const s = text.slice(start, start + width).replace(/\s+/g, " ").trim();
  return start > 0 ? `…${s}` : s;
}

interface ContentRow {
  id: string;
  type: string;
  title: string;
  content_text: string;
}

export async function searchContents(
  db: D1Database,
  query: string,
  opts: { type?: string; course?: string; limit?: number } = {},
): Promise<SearchHit[]> {
  const match = toBigramQuery(query);
  if (!match) return [];
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 50);

  const where: string[] = [`contents_fts MATCH ${sqlLiteral(match)}`];
  if (opts.type) where.push(`c.type = ${sqlLiteral(opts.type)}`);
  if (opts.course) {
    where.push(`l.course_id LIKE ${sqlLiteral(`%/${opts.course.toUpperCase()}`)}`);
  }

  const sql = `
    SELECT c.id, c.type, c.title, c.content_text
    FROM contents_fts f
    JOIN contents c ON c.rid = f.rowid
    JOIN lectures l ON l.id = c.lecture_id
    WHERE ${where.join(" AND ")}
    ORDER BY c.id
    LIMIT ${limit}
  `;
  const res = await db.prepare(sql).bind().all<ContentRow>();
  const rows = res.results ?? [];
  return rows.map((r: ContentRow) => {
    const parts = r.id.split("/");
    return {
      id: r.id,
      type: r.type,
      title: r.title,
      course: parts[1] ?? "",
      lecture: parts[2] ?? "",
      snippet: makeSnippet(r.content_text ?? r.title ?? "", query),
    };
  });
}

export async function listCourses(
  db: D1Database,
): Promise<{ id: string; year: number; code: string; name: string }[]> {
  const res = await db
    .prepare("SELECT id, year, code, name FROM courses ORDER BY id")
    .bind()
    .all<{ id: string; year: number; code: string; name: string }>();
  return (res.results ?? []) as never;
}
