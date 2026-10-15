/// <reference types="@cloudflare/workers-types" />

export interface LectureRow {
  id: string;
  course_id: string;
  number: number;
  title: string;
}

export interface ContentRow {
  id: string;
  lecture_id: string;
  type: string;
  title: string;
  content_html: string;
  r2_key: string | null;
}

export async function getLectureInfo(
  db: D1Database,
  lectureId: string,
): Promise<LectureRow | null> {
  const res = await db
    .prepare("SELECT id, course_id, number, title FROM lectures WHERE id = ?1")
    .bind(lectureId)
    .all<LectureRow>();
  return res.results?.[0] ?? null;
}

export async function getContentsByLecture(
  db: D1Database,
  lectureId: string,
): Promise<ContentRow[]> {
  const res = await db
    .prepare(
      "SELECT id, lecture_id, type, title, content_html, r2_key FROM contents WHERE lecture_id = ?1 ORDER BY type, id",
    )
    .bind(lectureId)
    .all<ContentRow>();
  return res.results ?? [];
}

export async function getContentById(
  db: D1Database,
  id: string,
): Promise<ContentRow | null> {
  const res = await db
    .prepare(
      "SELECT id, lecture_id, type, title, content_html, r2_key FROM contents WHERE id = ?1",
    )
    .bind(id)
    .all<ContentRow>();
  return res.results?.[0] ?? null;
}

export function slidesR2Key(lectureId: string): string {
  // lectures.id = {year}/{CODE}/{LL} → slides.pdf
  return `${lectureId}/slides.pdf`;
}

export async function getSlidesMeta(
  db: D1Database,
  lectureId: string,
): Promise<{ id: string; r2_key: string | null; title: string } | null> {
  const res = await db
    .prepare(
      "SELECT id, r2_key, title FROM contents WHERE lecture_id = ?1 AND type = 'slide' LIMIT 1",
    )
    .bind(lectureId)
    .all<{ id: string; r2_key: string | null; title: string }>();
  return res.results?.[0] ?? null;
}
