/**
 * Cloudflare Workers — MCP Server + REST API
 * 詳細: ../DESIGN.md 「MCP Server設計」
 *
 * - GET /health（認証不要）
 * - GET /api/courses
 * - GET /api/search?q=
 * - GET /api/slides/{year}/{CODE}/{LL}
 * - POST /mcp  JSON-RPC (initialize / tools/list / tools/call)
 *
 * 認証: INIAD Keycloak (OIDC) の Bearer トークン
 */

import { iniadFormLogin } from "./auth/form-login.js";
import { issueSessionToken } from "./auth/session.js";
import { unauthorized, verifyBearer } from "./auth/verify.js";
import { mcpCallTool, mcpToolList } from "./mcp/tools";
import { listCourses, searchContents } from "./search/query";

export interface Env {
  DB: D1Database;
  SLIDES: R2Bucket;
  MOOCS_YEAR: string;
  AUTH_SECRET: string;
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

interface JsonRpcReq {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: Record<string, unknown>;
}

async function handleMcp(request: Request, env: Env): Promise<Response> {
  let body: JsonRpcReq;
  try {
    body = (await request.json()) as JsonRpcReq;
  } catch {
    return json({ error: "invalid JSON-RPC body" }, 400);
  }
  const id = body.id ?? null;
  const method = body.method ?? "";

  const result = async (value: unknown) => json({ jsonrpc: "2.0", id, result: value });
  const error = (code: number, message: string) =>
    json({ jsonrpc: "2.0", id, error: { code, message } });

  if (method === "initialize") {
    return result({
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "moocs-mcp", version: "0.1.0" },
    });
  }
  if (method === "notifications/initialized" || method === "initialized") {
    return result({ ok: true });
  }
  if (method === "tools/list") {
    return result(mcpToolList());
  }
  if (method === "tools/call") {
    const params = body.params ?? {};
    const name = String(params.name ?? "");
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    try {
      const data = await mcpCallTool(env, name, args);
      return result({ content: [{ type: "text", text: JSON.stringify(data) }] });
    } catch (e) {
      return result({ content: [{ type: "text", text: String(e) }], isError: true });
    }
  }
  return error(-32601, `Method not found: ${method}`);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (path === "/health") {
      return json({ ok: true, year: env.MOOCS_YEAR });
    }

    if (path === "/login" && request.method === "POST") {
      let creds: { username?: string; password?: string };
      try {
        creds = (await request.json()) as { username?: string; password?: string };
      } catch {
        return json({ error: "invalid JSON body" }, 400);
      }
      const username = String(creds.username ?? "");
      const password = String(creds.password ?? "");
      if (!username || !password) {
        return json({ error: "username and password required" }, 400);
      }
      try {
        const result = await iniadFormLogin(username, password);
        if (!result.ok) {
          return json({ error: "login_failed", detail: result.error, url: result.finalUrl }, 401);
        }
        const token = await issueSessionToken(env.AUTH_SECRET, username);
        return json({ token_type: "Bearer", access_token: token, expires_in: 86400 });
      } catch (e) {
        return json({ error: "login_exception", detail: String(e) }, 500);
      }
    }

    const auth = await verifyBearer(request, env.AUTH_SECRET);
    if (!auth.ok) return unauthorized(auth.error ?? "unauthorized");

    if (path === "/mcp") {
      return handleMcp(request, env);
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

    const slideMatch = path.match(/^\/api\/slides\/(\d{4})\/([A-Za-z0-9_-]+)\/(\d{1,3})$/);
    if (slideMatch) {
      const [, year, code, ll] = slideMatch;
      const key = `${year}/${code}/${String(Number(ll)).padStart(2, "0")}/slides.pdf`;
      const obj = await env.SLIDES.get(key);
      if (!obj) return json({ error: "not_found", key }, 404);
      return new Response(obj.body, {
        headers: {
          "content-type": "application/pdf",
          "cache-control": "private, max-age=3600",
        },
      });
    }

    return json({ error: "not_found", path }, 404);
  },
};
