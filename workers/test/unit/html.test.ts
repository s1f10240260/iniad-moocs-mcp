import { describe, expect, it } from "vitest";

import { htmlToText } from "../../ingest/html.js";

describe("htmlToText", () => {
  it("タグを除去し、LaTeX はそのまま残す", () => {
    expect(htmlToText("<p>KL ダイバージェンス \\(D_{\\mathrm{KL}}(P \\| Q)\\)</p><p>問2</p>")).toBe(
      "KL ダイバージェンス \\(D_{\\mathrm{KL}}(P \\| Q)\\) 問2",
    );
  });

  it("script / style / コメントの中身は索引しない", () => {
    expect(htmlToText("<style>.a{}</style><!-- x --><script>var answer = 2;</script>本文")).toBe("本文");
  });

  it("文字参照をデコードする", () => {
    expect(htmlToText("a &amp; b &lt;c&gt; &#x3042;&#12354;&nbsp;&unknown;")).toBe("a & b <c> ああ &unknown;");
  });
});
