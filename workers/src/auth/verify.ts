/**
 * 認証: フォームログインで発行した自前セッションを検証する。
 * （Keycloak の OIDC トークン検証はしない）
 */

import { verifySessionToken } from "./session.js";

export interface AuthResult {
  ok: boolean;
  sub?: string;
  error?: string;
}

export async function verifyBearer(
  request: Request,
  secret: string,
): Promise<AuthResult> {
  const h = request.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  if (!m) return { ok: false, error: "missing bearer token" };
  const sess = await verifySessionToken(secret, m[1]);
  if (!sess) return { ok: false, error: "invalid or expired session" };
  return { ok: true, sub: sess.sub };
}

export function unauthorized(error: string): Response {
  return Response.json(
    { error: "unauthorized", detail: error },
    {
      status: 401,
      headers: {
        "www-authenticate": `Bearer realm="moocs-mcp"`,
        "cache-control": "no-store",
      },
    },
  );
}
