import { describe, expect, it } from "vitest";

import { mcpToolList } from "../../src/mcp/tools.js";

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
