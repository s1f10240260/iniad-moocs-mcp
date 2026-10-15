/**
 * INIAD Keycloak (OIDC) の Bearer トークンを検証する。
 * Issuer: https://accounts.iniad.org/auth/realms/master
 */

import { createRemoteJWKSet, jwtVerify } from "jose";

const ISSUER = "https://accounts.iniad.org/auth/realms/master";
const JWKS = createRemoteJWKSet(
  new URL("https://accounts.iniad.org/auth/realms/master/protocol/openid-connect/certs"),
);

export interface AuthResult {
  ok: boolean;
  sub?: string;
  email?: string;
  error?: string;
}

export async function verifyBearer(request: Request): Promise<AuthResult> {
  const h = request.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  if (!m) return { ok: false, error: "missing bearer token" };
  try {
    const { payload } = await jwtVerify(m[1], JWKS, { issuer: ISSUER });
    return {
      ok: true,
      sub: typeof payload.sub === "string" ? payload.sub : undefined,
      email: typeof payload.email === "string" ? payload.email : undefined,
    };
  } catch (e) {
    return { ok: false, error: `invalid token: ${String(e)}` };
  }
}

export function unauthorized(error: string): Response {
  return Response.json(
    { error: "unauthorized", detail: error },
    {
      status: 401,
      headers: {
        "www-authenticate": `Bearer realm="iniad-moocs", error="${error.replace(/"/g, "")}"`,
        "cache-control": "no-store",
      },
    },
  );
}
