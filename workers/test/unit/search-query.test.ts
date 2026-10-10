import { describe, expect, it } from "vitest";

import { toBigramQuery } from "../../src/search/bigram.js";
import { makeSnippet } from "../../src/search/query.js";

describe("makeSnippet", () => {
  it("keeps query text and collapses whitespace", () => {
    const text = "aaa  bbb\nKLダイバージェンス を説明する long tail";
    const s = makeSnippet(text, "ダイバージェンス", 40);
    expect(s).toContain("ダイバージェンス");
    expect(s).not.toMatch(/\n/);
  });
});

describe("toBigramQuery", () => {
  it("builds phrase match for Japanese words", () => {
    expect(toBigramQuery("課題")).toBe('"課題"');
    expect(toBigramQuery("問")).toBe('"問"*');
    expect(toBigramQuery("")).toBeNull();
  });
});
