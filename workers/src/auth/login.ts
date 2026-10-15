/**
 * OIDC PKCE でトークンを取得するヘルパー。
 * /login → Keycloak → /callback → トークン表示（コピー用）
 */

const ISSUER = "https://accounts.iniad.org/auth/realms/master";
const AUTH = `${ISSUER}/protocol/openid-connect/auth`;
const TOKEN = `${ISSUER}/protocol/openid-connect/token`;
const CLIENT_ID = "iniad-moocs";

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: b64url(digest) };
}

function html(body: string): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>moocs-mcp login</title>
     <style>body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem}
     input,textarea{width:100%;box-sizing:border-box;font:14px ui-monospace,monospace}
     button{margin:1rem 0;padding:.5rem 1rem}</style>${body}`,
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );
}

export async function handleLogin(url: URL): Promise<Response> {
  const redirectUri = `${url.origin}/callback`;
  const { verifier, challenge } = await pkce();
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const authUrl = new URL(AUTH);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", "openid");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");

  const headers = new Headers({ location: authUrl.toString() });
  headers.append(
    "set-cookie",
    `ocx_pkce=${verifier}; HttpOnly; Secure; Path=/callback; SameSite=Lax; Max-Age=600`,
  );
  headers.append(
    "set-cookie",
    `ocx_state=${state}; HttpOnly; Secure; Path=/callback; SameSite=Lax; Max-Age=600`,
  );
  return new Response(null, { status: 302, headers });
}

export async function handleCallback(request: Request, url: URL): Promise<Response> {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookies = Object.fromEntries(
    (request.headers.get("cookie") ?? "").split(/;\s*/).filter(Boolean).map((c) => {
      const i = c.indexOf("=");
      return [c.slice(0, i), c.slice(i + 1)];
    }),
  );
  const verifier = cookies.ocx_pkce;
  const expected = cookies.ocx_state;
  if (!code || !verifier || !state || state !== expected) {
    return html("<p>ログインに失敗しました（state / code が不正）。<a href='/login'>再試行</a></p>");
  }

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: CLIENT_ID,
    code,
    redirect_uri: `${url.origin}/callback`,
    code_verifier: verifier,
  });
  const res = await fetch(TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = (await res.json()) as { access_token?: string; error?: string; error_description?: string };
  if (!res.ok || !data.access_token) {
    return html(
      `<p>トークン取得に失敗: ${data.error ?? res.status} ${data.error_description ?? ""}</p><p><a href="/login">再試行</a></p>`,
    );
  }

  return html(`
    <h1>ログイン成功</h1>
    <p>以下のトークンをコピーして API / MCP で使ってください。</p>
    <textarea id="tok" rows="6" readonly>${data.access_token}</textarea>
    <button onclick="navigator.clipboard.writeText(document.getElementById('tok').value)">コピー</button>
    <p><a href="/api/courses">コース一覧を試す</a>（Authorization ヘッダが必要です）</p>
  `);
}
