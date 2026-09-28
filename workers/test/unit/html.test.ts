import { Parser } from "htmlparser2";
import { describe, expect, it } from "vitest";

import { htmlToText, sanitizeHtml } from "../../ingest/html.js";

describe("htmlToText", () => {
  it("タグを除去し、LaTeX はそのまま残す", () => {
    expect(htmlToText("<p>KL ダイバージェンス \\(D_{\\mathrm{KL}}(P \\| Q)\\)</p><p>問2</p>")).toBe(
      "KL ダイバージェンス \\(D_{\\mathrm{KL}}(P \\| Q)\\) 問2",
    );
  });

  it("script / style / コメントの中身は索引しない", () => {
    expect(htmlToText("<style>.a{}</style><!-- x --><script>var answer = 2;</script>本文")).toBe("本文");
  });

  it("閉じタグの無い <script> の中身も索引しない", () => {
    expect(htmlToText("<p>本文</p><script>var answer = 2;")).toBe("本文");
  });

  // `a<b` のように < の直後が英字だとブラウザでもタグ扱いになるので対象外（HTML では &lt; が正しい）
  it("直後が英字でない < はタグとみなさず本文を残す", () => {
    expect(htmlToText("<p>\\(x < y\\) のとき 1<2 が成り立つ</p><p>次の文</p>")).toBe(
      "\\(x < y\\) のとき 1<2 が成り立つ 次の文",
    );
  });

  it("属性値の中の > で本文が崩れない", () => {
    expect(htmlToText('<img alt="a>b" src="x.png">本文')).toBe("本文");
  });

  it("文字参照をデコードする", () => {
    expect(htmlToText("a &amp; b &lt;c&gt; &#x3042;&#12354;&nbsp;&unknown;")).toBe("a & b <c> ああ &unknown;");
  });

  it("NUL・サロゲート単体は D1 を壊さない文字に置き換わる", () => {
    const text = htmlToText("a&#0;b&#xD800;c\u0000d");
    expect(text).not.toMatch(/[\u0000\ud800-\udfff]/);
    expect(text).toBe("a�b�cd");
  });
});

/**
 * 出力をブラウザと同じ規則でパースし直し、実行されうる要素・属性が残っていないかを返す。
 * 文字列の部分一致で見ると `<img src="x/onerror=...">`（onerror は src の値の一部で無害）などを誤検知するため。
 */
function findUnsafe(html: string): string[] {
  const found: string[] = [];
  const parser = new Parser(
    {
      onopentagname(name) {
        if (["script", "style", "iframe", "object", "embed", "svg", "math", "template"].includes(name)) found.push(`<${name}>`);
      },
      onattribute(name, value) {
        if (name.startsWith("on") || name === "style" || name.startsWith("data-")) found.push(`${name}=`);
        // ブラウザは URL 前後の空白と途中のタブ・改行を無視する
        if (/^javascript:/i.test(value.replace(/[\u0000- ]/g, ""))) found.push(`${name}=javascript:`);
      },
    },
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true },
  );
  parser.write(html);
  parser.end();
  return found;
}

describe("sanitizeHtml", () => {
  it("許可したタグと本文・LaTeX は残す", () => {
    const html =
      '<div class="problem"><h3>問1</h3><p>\\(x < y\\) のとき</p><ol start="2"><li>選択肢</li></ol>' +
      '<table><tr><td colspan="2">表</td></tr></table><img src="https://example.com/a.png" alt="図"></div>';
    const out = sanitizeHtml(html);
    expect(out).toContain('<div class="problem"><h3>問1</h3>');
    expect(out).toContain("\\(x &lt; y\\) のとき"); // 素の < は正しい HTML としてエスケープされる
    expect(out).toContain('<ol start="2"><li>選択肢</li></ol>');
    expect(out).toContain('<td colspan="2">表</td>');
    expect(out).toContain('<img src="https://example.com/a.png" alt="図" />');
  });

  it("script / style / iframe とコメントを中身ごと落とす", () => {
    expect(
      sanitizeHtml('<div><!-- x --><script>var answer = 2;</script><style>p{}</style><iframe src="a"></iframe><p>本文</p></div>'),
    ).toBe("<div><p>本文</p></div>");
  });

  it("閉じタグの無い <script> の中身も落とす", () => {
    expect(sanitizeHtml("<p>ok</p><script>var answer = 2;")).toBe("<p>ok</p>");
  });

  it("選択肢（option）の文言は残し、data-* 属性は落とす", () => {
    expect(sanitizeHtml('<select><option data-correct="1">選択肢A</option></select>')).toBe("選択肢A");
  });

  // PR #4 レビューで挙がった回避パターンと、追加で見つかったもの
  it.each([
    // レビュー例の `<img/src=x/onerror=...>` は onerror が src の値の一部になり無害。引用符で閉じた形が本当の回避パターン
    ["/ 区切りのイベント属性", '<img/src="x"/onerror=alert(1)>'],
    ["/ 区切りの svg onload", "<svg/onload=alert(1)>"],
    ["文字参照で隠した javascript:", '<a href="javas&#99;ript:alert(1)">t</a>'],
    ["style 属性内の javascript:", '<div style="background:url(javascript:alert(1))">t</div>'],
    ["タブを挟んだ javascript:", '<a href="java\tscript:alert(1)">t</a>'],
    ["大文字・前後空白の javascript:", '<a href=" JAVASCRIPT:alert(1)">t</a>'],
    ["属性値の中の >", '<img src=x onerror="a>b">'],
    ["大文字・空白入りの script", "<SCRIPT >alert(1)</SCRIPT >"],
  ])("%s を無害化する", (_, html) => {
    expect(findUnsafe(html).length).toBeGreaterThan(0); // 入力は検出器で危険と判定される（検出器自体の確認）
    expect(findUnsafe(sanitizeHtml(html))).toEqual([]);
  });
});
