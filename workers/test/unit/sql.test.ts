import { describe, expect, it } from "vitest";

import { addJsonl, emptyManifest } from "../../ingest/manifest.js";
import { buildAliasStatements, buildStatements, MAX_STATEMENT_BYTES, sqlLiteral, type ContentRow } from "../../ingest/sql.js";

describe("sqlLiteral", () => {
  it("シングルクォートをエスケープする", () => {
    expect(sqlLiteral("it's '; DROP TABLE courses; --")).toBe("'it''s ''; DROP TABLE courses; --'");
  });
  it("NULL と数値", () => {
    expect(sqlLiteral(null)).toBe("NULL");
    expect(sqlLiteral(2026)).toBe("2026");
    expect(() => sqlLiteral(Number.NaN)).toThrow();
  });
});

describe("buildStatements", () => {
  const manifestWith = (event: Record<string, unknown>) => {
    const m = emptyManifest();
    addJsonl(m, "t", JSON.stringify({ event: "done", year: 2026, course: "INI201", lecture: 2, file: "2026/INI201/02/slides.pdf", ...event }));
    return m;
  };

  it("名前が分からないコース・レクチャーは既存行を上書きしない（DO NOTHING）", () => {
    const { statements } = buildStatements(manifestWith({}), []);
    expect(statements[0]).toMatch(/^INSERT INTO courses .* ON CONFLICT\(id\) DO NOTHING;$/);
    expect(statements[1]).toMatch(/^INSERT INTO lectures .* ON CONFLICT\(id\) DO NOTHING;$/);
  });

  it("名前があれば、変わったときだけ更新する", () => {
    const { statements } = buildStatements(manifestWith({ course_name: "データサイエンス基礎" }), []);
    expect(statements[0]).toContain("DO UPDATE SET name = excluded.name, name_bg = excluded.name_bg,");
    expect(statements[0]).toContain("WHERE courses.name IS NOT excluded.name");
    expect(statements[0]).toContain("'デー ータ タサ サイ イエ エン ンス ス基 基礎 礎'");
  });

  it("コースの upsert は別名に触れない（別名は buildAliasStatements が正本）", () => {
    const { statements } = buildStatements(manifestWith({ course_name: "データサイエンス基礎" }), []);
    expect(statements[0]).not.toContain("aliases");
  });

  it("D1 の文長上限を超える contents は oversized に回す", () => {
    const row = (id: string, html: string): ContentRow => ({
      id,
      lectureId: "2026/INI201/02",
      type: "quiz",
      contentHtml: html,
      contentText: "",
      r2Key: null,
      sha256: null,
    });
    const { statements, oversized } = buildStatements(emptyManifest(), [
      row("small", "<p>ok</p>"),
      row("huge", "あ".repeat(MAX_STATEMENT_BYTES / 3 + 1)),
    ]);
    expect(oversized).toEqual(["huge"]);
    expect(statements).toHaveLength(1);
  });
});

describe("buildAliasStatements", () => {
  it("ファイルにあるコードは別名を設定し、無いコードは空にする", () => {
    const stmts = buildAliasStatements(new Map([["INI201", ["DS基礎", "データサイエンス"]]]));
    expect(stmts[0]).toContain("SET aliases = 'DS基礎,データサイエンス'");
    expect(stmts[0]).toContain("WHERE code = 'INI201'");
    expect(stmts.at(-1)).toContain("AND code NOT IN ('INI201')");
  });

  it("空のファイルなら全コースの別名を空にする", () => {
    expect(buildAliasStatements(new Map())).toEqual([
      "UPDATE courses SET aliases = '', aliases_bg = '', updated_at = datetime('now') WHERE (aliases <> '' OR aliases_bg <> '');",
    ]);
  });
});
