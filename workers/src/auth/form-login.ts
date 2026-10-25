/**
 * INIAD のログインフォームを HTTP で操作する（OIDC トークン検証はしない）。
 *
 * フロー（Moocs と同じ）:
 *   GET  https://moocs.iniad.org/auth/iniad
 *     → Keycloak ログインフォームへ 302
 *   POST login-actions/authenticate (username / password)
 *     → Moocs へ戻る
 */

const MOOCS_AUTH_START = "https://moocs.iniad.org/auth/iniad";

export interface CookieJar {
  [name: string]: string;
}

export function cookieHeader(jar: CookieJar): string {
  return Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

export function absorbSetCookie(jar: CookieJar, res: Response): void {
  const raw = typeof (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie === "function"
    ? (res.headers as unknown as { getSetCookie: () => string[] }).getSetCookie()
    : [res.headers.get("set-cookie") ?? ""].filter(Boolean);
  for (const line of raw) {
    const nv = line.split(";")[0] ?? "";
    const i = nv.indexOf("=");
    if (i <= 0) continue;
    const name = nv.slice(0, i).trim();
    const value = nv.slice(i + 1).trim();
    if (value === "" || value.toLowerCase() === "deleted") delete jar[name];
    else jar[name] = value;
  }
}

export interface FormLoginResult {
  ok: boolean;
  finalUrl: string;
  error?: string;
}

export async function iniadFormLogin(
  username: string,
  password: string,
): Promise<FormLoginResult> {
  const jar: CookieJar = {};

  // 1) ログインフォームへ
  const start = await fetch(MOOCS_AUTH_START, {
    redirect: "manual",
    headers: { cookie: cookieHeader(jar) },
  });
  absorbSetCookie(jar, start);
  let location = start.headers.get("location") ?? MOOCS_AUTH_START;
  let res: Response = start;
  for (let hop = 0; hop < 6 && (res.status >= 300 && res.status < 400); hop++) {
    res = await fetch(location, {
      redirect: "manual",
      headers: { cookie: cookieHeader(jar) },
    });
    absorbSetCookie(jar, res);
    location = res.headers.get("location") ?? location;
    if (!res.headers.get("location")) break;
  }

  const html = res.ok ? await res.text() : "";
  const action = /<form[^>]*action="([^"]+)"/i.exec(html)?.[1]?.replaceAll("&amp;", "&");
  if (!action) {
    return { ok: false, finalUrl: res.url, error: "login form not found" };
  }

  // hidden input を拾う
  const body = new URLSearchParams();
  for (const m of html.matchAll(/<input[^>]*type="hidden"[^>]*>/gi)) {
    const tag = m[0];
    const name = /name="([^"]*)"/i.exec(tag)?.[1];
    const value = /value="([^"]*)"/i.exec(tag)?.[1] ?? "";
    if (name) body.set(name, value);
  }
  body.set("username", username);
  body.set("password", password);
  body.set("rememberMe", "on");
  body.set("login", "LOG IN");

  // 2) フォーム POST
  let loginRes = await fetch(action, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: cookieHeader(jar),
    },
    body: body.toString(),
  });
  absorbSetCookie(jar, loginRes);

  // 3) リダイレクトをたどる（Moocs 側へ）
  for (let hop = 0; hop < 8; hop++) {
    if (loginRes.status < 300 || loginRes.status >= 400) break;
    const next = loginRes.headers.get("location");
    if (!next) break;
    loginRes = await fetch(next, {
      redirect: "manual",
      headers: { cookie: cookieHeader(jar) },
    });
    absorbSetCookie(jar, loginRes);
  }

  const failed = loginRes.ok && (await loginRes.clone().text()).includes("kc-form-login");
  if (failed) {
    return { ok: false, finalUrl: loginRes.url, error: "invalid username or password" };
  }
  if (!loginRes.ok) {
    return { ok: false, finalUrl: loginRes.url, error: `login failed: ${loginRes.status}` };
  }
  return { ok: true, finalUrl: loginRes.url };
}
