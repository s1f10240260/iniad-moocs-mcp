import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { run } from "../../ingest/cli.js";

const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../tests/fixtures/sample-out");

async function dryRun(dir: string) {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((c) => (out.push(String(c)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((c) => (err.push(String(c)), true));
  const code = await run([
    "--out", dir,
    "--jsonl", path.join(dir, "collect-slides.jsonl"),
    "--jsonl", path.join(dir, "collect-contents.jsonl"),
    "--dry-run",
  ]);
  return { code, stdout: out.join(""), stderr: err.join("") };
}

afterEach(() => vi.restoreAllMocks());

describe("ingest --dry-run（D1 / R2 に触れない）", () => {
  it("正常な fixture は exit 0 で SQL だけを stdout に出す", async () => {
    const { code, stdout } = await dryRun(FIXTURE);
    expect(code).toBe(0);
    expect(stdout.trim().split("\n").every((l) => l.startsWith("INSERT ") || l.startsWith("UPDATE ") || !l.startsWith("{"))).toBe(true);
    expect(stdout).not.toContain("var answer"); // 保存する HTML から script を落としている
  });

  it("契約違反があれば通常実行と同じく exit 1", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sample-out-"));
    try {
      await cp(FIXTURE, dir, { recursive: true });
      const f = path.join(dir, "collect-contents.jsonl");
      await writeFile(f, `${await readFile(f, "utf8")}{"event":"done","year":2026,"course":"INI201","lecture":1,"type":"quiz","file":"../x.html"}\n`);
      const { code, stderr } = await dryRun(dir);
      expect(code).toBe(1);
      expect(stderr).toContain('"event":"rejected"');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("引数不足は exit 2", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(await run(["--out", FIXTURE])).toBe(2);
    expect(await run(["--out", FIXTURE, "--jsonl", "x", "--retries", "-1"])).toBe(2);
  });
});
