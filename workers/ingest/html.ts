/**
 * Moocs から取得した HTML の前処理。
 *
 * - sanitizeHtml: D1 に保存し MCP で返す表示用 HTML。実行されうる要素・属性を落とす
 *   （採点用スクリプトに答えが含まれている可能性もあるため）。
 * - htmlToText: 検索・スニペット用のプレーンテキスト。LaTeX（\( ... \) など）は文字列のまま残す。
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

const COMMENT = /<!--[\s\S]*?-->/g;
const UNSAFE_ELEMENT = /<(script|style|noscript|template|iframe|object|embed)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const UNSAFE_VOID = /<\/?(script|style|noscript|template|iframe|object|embed|link|meta|base)\b[^>]*>/gi;
// 本物のタグだけに一致させる。`\(x < y\)` のような素の `<` はタグとみなさない
const TAG = /<\/?[A-Za-z][^>]*>|<![^>]*>|<\?[^>]*>/g;
const EVENT_ATTR = /\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;
const JS_URL_ATTR = /\s+(href|src|action|formaction|xlink:href)\s*=\s*(["']?)\s*javascript:[^"'\s>]*\2/gi;

export function sanitizeHtml(html: string): string {
  return html
    .replace(COMMENT, "")
    .replace(UNSAFE_ELEMENT, "")
    .replace(UNSAFE_VOID, "")
    .replace(/<[A-Za-z][^>]*>/g, (tag) => tag.replace(EVENT_ATTR, "").replace(JS_URL_ATTR, ""));
}

export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(COMMENT, " ")
      .replace(UNSAFE_ELEMENT, " ")
      .replace(TAG, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (m, body: string) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      // NUL・サロゲート単体は D1 に入れると壊れるので捨てる
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return " ";
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? m;
  });
}
