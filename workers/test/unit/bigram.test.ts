import { describe, expect, it } from "vitest";

import { toBigramQuery, toBigramText } from "../../src/search/bigram.js";

describe("toBigramText", () => {
  it("2 文字ずつに分け、区間の末尾 1 文字も入れる", () => {
    expect(toBigramText("データ基礎")).toBe("デー ータ タ基 基礎 礎");
  });

  it("記号・空白で区間を切り、区間をまたぐバイグラムは作らない", () => {
    expect(toBigramText("KL (P‖Q)")).toBe("kl l p q");
  });

  it("NFKC + 小文字化で全角・半角を揃える", () => {
    expect(toBigramText("第２回 ＩＣＴ ｶﾅ")).toBe(toBigramText("第2回 ict カナ"));
  });

  it("サロゲートペアを 1 文字として扱う", () => {
    expect(toBigramText("𠮷野家")).toBe("𠮷野 野家 家");
  });

  it("空文字・記号だけなら空", () => {
    expect(toBigramText("")).toBe("");
    expect(toBigramText("（）・、。")).toBe("");
  });
});

describe("toBigramQuery", () => {
  it("2 文字以上は連続バイグラムのフレーズ", () => {
    expect(toBigramQuery("課題")).toBe('"課題"');
    expect(toBigramQuery("サイエンス")).toBe('"サイ イエ エン ンス"');
  });

  it("1 文字は前方一致", () => {
    expect(toBigramQuery("問")).toBe('"問"*');
  });

  it("区切られた語は AND", () => {
    expect(toBigramQuery("ICT論B　第３回")).toBe('"ic ct t論 論b" AND "第3 3回"');
  });

  it("FTS5 の構文文字は検索語に入らない（インジェクション対策）", () => {
    expect(toBigramQuery('a" OR "b')).toBe('"a"* AND "or" AND "b"*');
    expect(toBigramQuery("NEAR(x y) * ^")).toBe('"ne ea ar" AND "x"* AND "y"*');
  });

  it("検索できる文字が無ければ null", () => {
    expect(toBigramQuery("  ？！ ")).toBeNull();
  });
});
