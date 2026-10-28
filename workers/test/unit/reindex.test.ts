import { describe, expect, it } from "vitest";

import { buildReindexStatements } from "../../ingest/sql.js";

describe("buildReindexStatements", () => {
  it("emits UPDATE with recalculated *_bg only", () => {
    const sql = buildReindexStatements("lectures", [
      { id: "2026/INI201/02", sources: { title: "確率" } },
    ]);
    expect(sql).toHaveLength(1);
    expect(sql[0]).toContain("UPDATE lectures SET title_bg =");
    expect(sql[0]).toContain("WHERE id = '2026/INI201/02'");
    expect(sql[0]).toContain("lectures.title_bg IS NOT");
  });

  it("covers courses multi-column sources", () => {
    const sql = buildReindexStatements("courses", [
      { id: "2026/INI201", sources: { code: "INI201", name: "情報基礎", aliases: "" } },
    ]);
    expect(sql).toHaveLength(1);
    expect(sql[0]).toContain("code_bg =");
    expect(sql[0]).toContain("name_bg =");
    expect(sql[0]).toContain("aliases_bg =");
  });
});
