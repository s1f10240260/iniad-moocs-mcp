/**
 * MCP tools (JSON-RPC over HTTP).
 * DESIGN: list_courses / get_lecture_info / get_contents / get_slides / search_content
 */

import {
  getContentById,
  getContentsByLecture,
  getLectureInfo,
  getSlidesMeta,
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
    description: "登録済みコース一覧を返す",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_lecture_info",
    description: "講義メタデータを取得する",
    inputSchema: {
      type: "object",
      properties: {
        lecture_id: { type: "string", description: "例: 2026/INI201/02" },
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
    return { courses: await listCourses(env.DB) };
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
    const row = await getLectureInfo(env.DB, id);
    if (!row) throw new Error(`lecture not found: ${id}`);
    return row;
  }
  if (name === "get_contents") {
    const id = args.id ? String(args.id) : undefined;
    const lectureId = args.lecture_id ? String(args.lecture_id) : undefined;
    if (id) {
      const row = await getContentById(env.DB, id);
      if (!row) throw new Error(`content not found: ${id}`);
      return row;
    }
    if (!lectureId) throw new Error("id or lecture_id is required");
    return { items: await getContentsByLecture(env.DB, lectureId) };
  }
  if (name === "get_slides") {
    const id = String(args.lecture_id ?? "");
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
