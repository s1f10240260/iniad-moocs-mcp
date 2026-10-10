/**
 * Cloudflare Workers — MCP Server + REST API
 * 詳細: ../DESIGN.md 「MCP Server設計」
 *
 * Phase 4: 検索 API を実装。MCP / 認証は後続。
 */

import { listCourses, searchContents } from "./search/query";

export interface Env {
  DB: D1Database;
  SLIDES: R2Bucket;
  MOOCS_YEAR: string;
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (path === "/health") {
      return json({ ok: true, year: env.MOOCS_YEAR });
    }

    if (path === "/api/courses") {
      return json({ courses: await listCourses(env.DB) });
    }

    if (path === "/api/search") {
      const q = url.searchParams.get("q") ?? "";
      if (!q.trim()) return json({ error: "q required" }, 400);
      const type = url.searchParams.get("type") ?? undefined;
      const course = url.searchParams.get("course") ?? undefined;
      const limit = Number(url.searchParams.get("limit") ?? "20");
      try {
        const hits = await searchContents(env.DB, q, { type, course, limit });
        return json({ q, type, course, count: hits.length, hits });
      } catch (e) {
        return json({ error: String(e) }, 500);
      }
    }

    return json(
      {
        error: "not_implemented",
        note: "Phase 4 — see docs/ROADMAP.md",
        path,
      },
      501,
    );
  },
};
