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

  // `a<b` のように < の直後が英字だとブラウザでもタグ扱いになるので対象外（HTML では &lt; が正しい）
  it("直後が英字でない < はタグとみなさず本文を残す", () => {
    expect(htmlToText("<p>\\(x < y\\) のとき 1<2 が成り立つ</p><p>次の文</p>")).toBe(
      "\\(x < y\\) のとき 1<2 が成り立つ 次の文",
    );
  });

  it("文字参照をデコードする", () => {
    expect(htmlToText("a &amp; b &lt;c&gt; &#x3042;&#12354;&nbsp;&unknown;")).toBe("a & b <c> ああ &unknown;");
  });

  it("NUL・サロゲート単体の文字参照は捨てる", () => {
    expect(htmlToText("a&#0;b&#xD800;c")).toBe("a b c");
  });
});

describe("sanitizeHtml", () => {
  it("script / style / iframe とコメントを落とし、本文と LaTeX は残す", () => {
    expect(
      sanitizeHtml('<div><!-- x --><script>var answer = 2;</script><style>p{}</style><iframe src="a"></iframe><p>\\(x < y\\)</p></div>'),
    ).toBe("<div><p>\\(x < y\\)</p></div>");
  });

  it("イベント属性と javascript: URL を落とす", () => {
    expect(sanitizeHtml(`<a href="javascript:alert(1)" onclick='x()' class="c">t</a><img src=x onerror=alert(1)>`)).toBe(
      '<a class="c">t</a><img src=x>',
    );
  });
});
