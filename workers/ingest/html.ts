/**
 * Moocs から取得した HTML の前処理。正規表現ではなく HTML パーサー（htmlparser2）で読む。
 * 正規表現では `<img/onerror=...>`・文字参照・属性値中の `>`・閉じタグ無しの <script> などを取りこぼすため。
 *
 * - sanitizeHtml: D1 に保存し MCP で返す表示用 HTML。許可したタグ・属性・URL スキームだけを残す
 *   （採点用スクリプトや data-* 属性に答えが含まれている可能性もあるため）。
 * - htmlToText: 検索・スニペット用のプレーンテキスト。LaTeX（\( ... \) など）は文字列のまま残す。
 */

import { Parser } from "htmlparser2";
import sanitize from "sanitize-html";

/** 中身ごと捨てる要素。閉じタグが無くても、以降はこの要素の中身として扱われる */
const DROP_WITH_CONTENT = ["script", "style", "noscript", "template", "textarea"];

const SANITIZE_OPTIONS: sanitize.IOptions = {
  // 既定（p / div / table / ol / li / code / pre / h1-6 / sub / sup など）に画像とラベルを足す
  allowedTags: [...sanitize.defaults.allowedTags, "img", "label"],
  allowedAttributes: {
    "*": ["class", "lang", "dir", "title"],
    a: ["href", "name"],
    img: ["src", "alt", "width", "height"],
    td: ["colspan", "rowspan"],
    th: ["colspan", "rowspan", "scope"],
    ol: ["start", "type"],
  },
  allowedSchemes: ["http", "https", "mailto"],
  allowedSchemesByTag: { img: ["http", "https", "data"] },
  // 既定の nonTextTags は option も捨てるが、選択肢の文言は残したいので明示する
  nonTextTags: DROP_WITH_CONTENT,
};

function stripNul(html: string): string {
  return html.replace(/\u0000/g, "");
}

export function sanitizeHtml(html: string): string {
  return sanitize(stripNul(html), SANITIZE_OPTIONS);
}

export function htmlToText(html: string): string {
  const out: string[] = [];
  let skipDepth = 0;
  const parser = new Parser(
    {
      onopentagname(name) {
        if (DROP_WITH_CONTENT.includes(name)) skipDepth++;
        out.push(" ");
      },
      onclosetag(name) {
        if (DROP_WITH_CONTENT.includes(name)) skipDepth = Math.max(0, skipDepth - 1);
        out.push(" ");
      },
      ontext(text) {
        if (skipDepth === 0) out.push(text);
      },
    },
    { decodeEntities: true, lowerCaseTags: true },
  );
  parser.write(stripNul(html));
  parser.end();
  return out.join("").replace(/\s+/g, " ").trim();
}
