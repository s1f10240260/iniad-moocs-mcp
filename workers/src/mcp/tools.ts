/**
 * MCP tools (JSON-RPC over HTTP).
 * DESIGN: list_courses / get_contents / search_content を公開。
 */

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
  throw new Error(`unknown tool: ${name}`);
}
