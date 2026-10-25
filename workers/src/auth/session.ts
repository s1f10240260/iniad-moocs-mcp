/**
 * フォームログイン成功後に発行する自前セッション（HMAC トークン）。
 * AUTH_SECRET で署名する。OIDC は使わない。
 */

const enc = new TextEncoder();

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return b64url(sig);
}

export interface SessionToken {
  sub: string;
  exp: number;
}

export async function issueSessionToken(
  secret: string,
  sub: string,
  ttlSeconds = 86400,
): Promise<string> {
  const payload: SessionToken = { sub, exp: Math.floor(Date.now() / 1000) + ttlSeconds };
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig = await hmac(secret, body);
  return `${body}.${sig}`;
}

export async function verifySessionToken(
  secret: string,
  token: string,
): Promise<SessionToken | null> {
  const i = token.lastIndexOf(".");
  if (i <= 0) return null;
  const body = token.slice(0, i);
  const sig = token.slice(i + 1);
  const expect = await hmac(secret, body);
  if (sig !== expect) return null;
  try {
    const json = JSON.parse(new TextDecoder().decode(
      Uint8Array.from(atob(body.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)),
    )) as SessionToken;
    if (typeof json.exp !== "number" || json.exp < Date.now() / 1000) return null;
    return json;
  } catch {
    return null;
  }
}
