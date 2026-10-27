import { describe, expect, it } from "vitest";

import { mcpCallTool, mcpToolList } from "../../src/mcp/tools.js";

describe("mcp tools", () => {
  it("lists all five design tools", () => {
    const { tools } = mcpToolList();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "get_contents",
      "get_lecture_info",
      "get_slides",
      "list_courses",
      "search_content",
    ]);
  });
});

function fakeDb(rowsBySql: Record<string, Record<string, unknown>[]>) {
  return {
    prepare(sql: string) {
      return {
        bind(..._args: unknown[]) {
          return {
            async all() {
              for (const [needle, rows] of Object.entries(rowsBySql)) {
                if (sql.includes(needle)) return { results: rows };
              }
              return { results: [] };
            },
          };
        },
      };
    },
  } as never;
}

describe("get_slides edge cases", () => {
  it("rejects missing lecture", async () => {
    const env = {
      DB: fakeDb({ "FROM lectures": [] }),
      SLIDES: { head: async () => null },
      MOOCS_YEAR: "2026",
    } as never;
    await expect(
      mcpCallTool(env, "get_slides", { lecture_id: "2026/INI201/99" }),
    ).rejects.toThrow(/lecture not found/);
  });

  it("rejects lecture without uploaded pdf", async () => {
    const env = {
      DB: fakeDb({
        "FROM lectures": [{ ok: 1 }],
        "type = 'slide'": [],
      }),
      SLIDES: { head: async () => null },
      MOOCS_YEAR: "2026",
    } as never;
    await expect(
      mcpCallTool(env, "get_slides", { lecture_id: "2026/INI201/01" }),
    ).rejects.toThrow(/slides not found/);
  });

  it("returns size and uploaded when r2 object exists", async () => {
    const uploaded = new Date("2026-10-01T00:00:00Z");
    const env = {
      DB: fakeDb({
        "FROM lectures": [{ ok: 1 }],
        "type = 'slide'": [{ id: "x", r2_key: "2026/INI201/01/slides.pdf", title: "s" }],
      }),
      SLIDES: { head: async () => ({ size: 123, uploaded }) },
      MOOCS_YEAR: "2026",
    } as never;
    const out = (await mcpCallTool(env, "get_slides", {
      lecture_id: "2026/INI201/01",
    })) as { size: number; r2_key: string };
    expect(out.r2_key).toBe("2026/INI201/01/slides.pdf");
    expect(out.size).toBe(123);
  });
});

describe("get_contents id mismatch", () => {
  it("rejects conflicting id and lecture_id", async () => {
    const env = {
      DB: fakeDb({
        "FROM contents": [
          {
            id: "2026/SOF202/01/quiz",
            lecture_id: "2026/SOF202/01",
            type: "quiz",
            title: "t",
            content_html: "",
            r2_key: null,
          },
        ],
      }),
      SLIDES: { head: async () => null },
      MOOCS_YEAR: "2026",
    } as never;
    await expect(
      mcpCallTool(env, "get_contents", {
        id: "2026/SOF202/01/quiz",
        lecture_id: "2026/SOF202/02",
      }),
    ).rejects.toThrow(/mismatch/);
  });
});

describe("search_content limit", () => {
  it("rejects out-of-range limit", async () => {
    const env = {
      DB: fakeDb({}),
      SLIDES: { head: async () => null },
      MOOCS_YEAR: "2026",
    } as never;
    await expect(
      mcpCallTool(env, "search_content", { q: "x", limit: 100 }),
    ).rejects.toThrow(/limit must be 1-50/);
    await expect(
      mcpCallTool(env, "search_content", { q: "x", limit: 0 }),
    ).rejects.toThrow(/limit must be 1-50/);
  });
});

