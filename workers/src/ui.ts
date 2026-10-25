/**
 * 検索 UI（1 ページ）。ログイン → 検索 → 結果。
 */

export function indexHtml(): Response {
  const html = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Moocs 検索</title>
<style>
:root { color-scheme: light dark; font-family: system-ui, sans-serif; }
body { max-width: 42rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; }
h1 { font-size: 1.35rem; }
input, button, select { font: inherit; padding: .5rem .75rem; }
input[type=text], input[type=password] { width: 100%; box-sizing: border-box; }
form, .row { display: grid; gap: .5rem; margin: 1rem 0; }
button { cursor: pointer; }
.card { border: 1px solid #8884; border-radius: 8px; padding: .75rem 1rem; margin: .75rem 0; }
.meta { opacity: .75; font-size: .85rem; }
pre { white-space: pre-wrap; word-break: break-word; }
.hidden { display: none; }
</style>
</head>
<body>
  <h1>Moocs 講義検索</h1>
  <section id="login">
    <p>INIAD の学籍番号とパスワードでログインしてください。</p>
    <form id="loginForm">
      <label>学籍番号 <input type="text" id="username" autocomplete="username" required></label>
      <label>パスワード <input type="password" id="password" autocomplete="current-password" required></label>
      <button type="submit">ログイン</button>
    </form>
    <p class="meta" id="loginMsg"></p>
  </section>

  <section id="app" class="hidden">
    <form id="searchForm" class="row">
      <input type="text" id="q" placeholder="検索語（例: 課題）" required>
      <select id="type">
        <option value="">すべて</option>
        <option value="quiz">クイズ</option>
        <option value="assignment">課題</option>
      </select>
      <button type="submit">検索</button>
    </form>
    <p class="meta" id="searchMsg"></p>
    <div id="results"></div>
  </section>

<script>
let token = sessionStorage.getItem("moocs_token") || "";
const $ = (id) => document.getElementById(id);
function showApp(on) {
  $("login").classList.toggle("hidden", on);
  $("app").classList.toggle("hidden", !on);
}
if (token) showApp(true);

$("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("loginMsg").textContent = "ログイン中…";
  const res = await fetch("/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: $("username").value,
      password: $("password").value,
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    $("loginMsg").textContent = "ログイン失敗: " + (data.detail || data.error || res.status);
    return;
  }
  token = data.access_token;
  sessionStorage.setItem("moocs_token", token);
  showApp(true);
});

$("searchForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("searchMsg").textContent = "検索中…";
  $("results").innerHTML = "";
  const q = encodeURIComponent($("q").value);
  const type = $("type").value ? "&type=" + encodeURIComponent($("type").value) : "";
  const res = await fetch("/api/search?q=" + q + type, {
    headers: { authorization: "Bearer " + token },
  });
  if (res.status === 401) {
    token = "";
    sessionStorage.removeItem("moocs_token");
    showApp(false);
    return;
  }
  const data = await res.json();
  $("searchMsg").textContent = data.count + " 件";
  for (const hit of data.hits || []) {
    const el = document.createElement("div");
    el.className = "card";
    el.innerHTML = "<strong></strong><div class='meta'></div><pre></pre>";
    el.querySelector("strong").textContent = hit.id;
    el.querySelector(".meta").textContent = hit.type + " · " + (hit.title || "");
    el.querySelector("pre").textContent = hit.snippet || "";
    $("results").appendChild(el);
  }
});
</script>
</body>
</html>`;
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}
