import { describe, expect, it } from "vitest";

import { mcpToolList } from "../../src/mcp/tools.js";

describe("mcp tools", () => {
  it("lists search_content and list_courses", () => {
    const { tools } = mcpToolList();
    const names = tools.map((t) => t.name);
    expect(names).toContain("search_content");
    expect(names).toContain("list_courses");
  });
});
