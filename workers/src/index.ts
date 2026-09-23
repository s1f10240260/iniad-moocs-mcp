/**
 * Cloudflare Workers — MCP Server + REST API
 * 詳細: ../DESIGN.md 「MCP Server設計」
 *
 * Phase 4 で実装する。現状は疎通確認用スタブ。
 */

export interface Env {
  DB: D1Database;
  SLIDES: R2Bucket;
  MOOCS_YEAR: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ ok: true, year: env.MOOCS_YEAR });
    }

    // TODO(phase-4):
    // - /api/*        REST (list_courses / get_lecture_info / ...)
    // - /mcp          MCP streamable HTTP
    // - INIAD Keycloak (OIDC) 認証
    return Response.json(
      {
        error: "not_implemented",
        note: "Phase 4 — see docs/ROADMAP.md",
        path: url.pathname,
      },
      { status: 501 },
    );
  },
};
