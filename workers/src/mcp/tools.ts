/**
 * MCP tools (JSON-RPC over HTTP).
 * DESIGN: list_courses / get_lecture_info / get_contents / get_slides / search_content
 */

import {
  getContentById,
  getContentsByLecture,
  getSlidesMeta,
  normalizeLectureId,
  resolveLecture,
  slidesR2Key,
} from "../search/lookup.js";
import { listCourses, searchContents } from "../search/query.js";

export interface Env {
  DB: D1Database;
  SLIDES: R2Bucket;
  MOOCS_YEAR: string;
}

const TOOLS = [
  {
    name: "search_content",
    description: "講義コンテンツ（クイズ・課題）を日本語部分一致で検索する",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string", description: "検索語（2文字以上の部分一致可）" },
        type: { type: "string", enum: ["quiz", "assignment"] },
        course: { type: "string", description: "コース CODE 例: INI201" },
        limit: { type: "number", description: "最大件数 1-50" },
      },
      required: ["q"],
    },
  },
  {
    name: "list_courses",
    description: "登録済みコースと講義 ID 一覧を返す（講義 ID は 2026/CODE/LL 形式）",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_lecture_info",
    description:
      "講義メタデータを取得する。lecture_id には講義 ID（2026/INI201/02）またはコース ID（2026/INI201）・コード（INI201）を渡せる。コース指定なら講義一覧を返す。",
    inputSchema: {
      type: "object",
      properties: {
        lecture_id: {
          type: "string",
          description: "例: 2026/INI201/02（講義） / 2026/INI201 または INI201（コース一覧）",
        },
      },
      required: ["lecture_id"],
    },
  },
  {
    name: "get_contents",
    description: "講義のクイズ・課題 HTML を取得する",
    inputSchema: {
      type: "object",
      properties: {
        lecture_id: { type: "string", description: "例: 2026/INI201/02" },
        id: { type: "string", description: "例: 2026/INI201/02/assignment" },
      },
    },
  },
  {
    name: "get_slides",
    description: "講義スライド PDF の情報を返す（ダウンロード URL パス含む）",
    inputSchema: {
      type: "object",
      properties: {
        lecture_id: { type: "string", description: "例: 2026/INI201/02" },
      },
      required: ["lecture_id"],
    },
  },
] as const;

export function mcpToolList() {
  return { tools: TOOLS };
}

export async function mcpCallTool(
  env: Env,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  if (name === "list_courses") {
    const courses = await listCourses(env.DB);
    const out: {
      id: string;
      year: number;
      code: string;
      name: string;
      lectures: { id: string; number: number; title: string }[];
    }[] = [];
    for (const c of courses) {
      const lec = await env.DB.prepare(
        "SELECT id, number, title FROM lectures WHERE course_id = ?1 ORDER BY number",
      )
        .bind(c.id)
        .all<{ id: string; number: number; title: string }>();
      out.push({ ...c, lectures: lec.results ?? [] });
    }
    return { courses: out };
  }
  if (name === "search_content") {
    const q = String(args.q ?? "");
    if (!q) throw new Error("q is required");
    const hits = await searchContents(env.DB, q, {
      type: args.type ? String(args.type) : undefined,
      course: args.course ? String(args.course) : undefined,
      limit: typeof args.limit === "number" ? args.limit : undefined,
    });
    return { count: hits.length, hits };
  }
  if (name === "get_lecture_info") {
    const id = String(args.lecture_id ?? "");
    if (!id) throw new Error("lecture_id is required");
    const r = await resolveLecture(env.DB, id);
    if (r.kind === "missing") {
      throw new Error(
        `lecture not found: ${id}（講義 ID は 2026/CODE/LL 形式。list_courses で一覧を確認できます）`,
      );
    }
    if (r.kind === "course") {
      return {
        course: r.course,
        lecture_count: r.lectures.length,
        lectures: r.lectures,
        hint: "講義 1 件の詳細は lecture_id に 2026/CODE/LL を渡してください",
      };
    }
    return r.row;
  }
  if (name === "get_contents") {
    const id = args.id ? String(args.id) : undefined;
    const lectureId = args.lecture_id ? normalizeLectureId(String(args.lecture_id)) : undefined;
    if (id) {
      const row = await getContentById(env.DB, id);
      if (!row) throw new Error(`content not found: ${id}`);
      return row;
    }
    if (!lectureId) throw new Error("id or lecture_id is required");
    return { items: await getContentsByLecture(env.DB, lectureId) };
  }
  if (name === "get_slides") {
    const id = normalizeLectureId(String(args.lecture_id ?? ""));
    const meta = await getSlidesMeta(env.DB, id);
    const key = meta?.r2_key ?? slidesR2Key(id);
    return {
      lecture_id: id,
      r2_key: key,
      download_path: `/api/slides/${id}`,
    };
  }
  throw new Error(`unknown tool: ${name}`);
}
