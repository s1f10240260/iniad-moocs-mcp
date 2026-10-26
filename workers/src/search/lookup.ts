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

/** 講義 ID を正規化する。"2026/INI201/2" → "2026/INI201/02" など。 */
export function normalizeLectureId(raw: string): string {
  const s = raw.trim().replace(/\\/g, "/");
  const m = s.match(/^(\d{4})\/([A-Za-z0-9]+)\/(\d{1,2})$/);
  if (m) return `${m[1]}/${m[2].toUpperCase()}/${m[3].padStart(2, "0")}`;
  return s;
}

/**
 * lecture_id / course_id / code のどれでも受け付けて解決する。
 * - "2026/INI201/02" → その講義 1 件
 * - "2026/INI201" / "INI201" → そのコースの講義一覧
 */
export async function resolveLecture(
  db: D1Database,
  rawId: string,
): Promise<
  | { kind: "lecture"; row: LectureRow }
  | { kind: "course"; course: { id: string; year: number; code: string; name: string }; lectures: LectureRow[] }
  | { kind: "missing"; id: string }
> {
  const id = normalizeLectureId(rawId);
  const lec = await getLectureInfo(db, id);
  if (lec) return { kind: "lecture", row: lec };

  // course_id 形式 "2026/INI201"
  let courseId = id;
  if (!/^\d{4}\/[A-Za-z0-9]+$/.test(courseId)) {
    // code のみ "INI201" → 最新年のコースを探す
    const byCode = await db
      .prepare("SELECT id, year, code, name FROM courses WHERE code = ?1 ORDER BY year DESC LIMIT 1")
      .bind(id.toUpperCase())
      .all<{ id: string; year: number; code: string; name: string }>();
    const c = byCode.results?.[0];
    if (!c) return { kind: "missing", id: rawId };
    courseId = c.id;
  }

  const courseRes = await db
    .prepare("SELECT id, year, code, name FROM courses WHERE id = ?1")
    .bind(courseId)
    .all<{ id: string; year: number; code: string; name: string }>();
  const course = courseRes.results?.[0];
  if (!course) return { kind: "missing", id: rawId };

  const lecRes = await db
    .prepare(
      "SELECT id, course_id, number, title FROM lectures WHERE course_id = ?1 ORDER BY number",
    )
    .bind(course.id)
    .all<LectureRow>();
  return { kind: "course", course, lectures: lecRes.results ?? [] };
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
