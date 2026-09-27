/**
 * 実際の wrangler ローカル D1 / R2（Miniflare）に対して ingest を流す結合テスト。
 * Phase 3 の完了条件「サンプル 1 コース分がローカル D1 + R2 mock に入り、SQL で検索できる」を検証する。
 * 検索は Phase 4 の Workers と同じく toBigramQuery() で MATCH 式を作る。
 *
 * 注意: Windows のパス長制限を避けるため、永続化先は workers/.wrangler/ 配下の短いパスにする。
 */

import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { run } from "../../ingest/cli.js";
import { toBigramQuery } from "../../src/search/bigram.js";
import { d1Query, runWrangler, type WranglerTarget } from "../../ingest/wrangler.js";

const WORKERS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FIXTURE = path.resolve(WORKERS, "../tests/fixtures/sample-out");
const SCHEMA = path.resolve(WORKERS, "../db/schema.sql");

let persistTo: string;
let target: WranglerTarget;

/** ingest を実行し、exit code と stdout に出た JSON イベントを返す */
async function ingest(outDir: string, extra: string[] = []) {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    lines.push(String(chunk));
    return true;
  });
  try {
    const code = await run([
      "--out",
      outDir,
      "--jsonl",
      path.join(outDir, "collect-slides.jsonl"),
      "--jsonl",
      path.join(outDir, "collect-contents.jsonl"),
      "--aliases",
      path.join(outDir, "aliases.json"),
      "--persist-to",
      persistTo,
      ...extra,
    ]);
    const events = lines
      .join("")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    return { code, events, summary: events.find((e) => e.event === "summary") };
  } finally {
    spy.mockRestore();
  }
}

const q = <T = Record<string, unknown>>(sql: string) => d1Query<T>(target, sql);

/** 検索語を Workers と同じ toBigramQuery で MATCH 式にして引く */
async function search(table: "courses_fts" | "lectures_fts" | "contents_fts", query: string, where = ""): Promise<string[]> {
  const base = table.replace("_fts", "");
  const match = toBigramQuery(query);
  if (match === null) return [];
  const rows = await q<{ id: string }>(
    `SELECT b.id FROM ${table} f JOIN ${base} b ON b.rid = f.rowid WHERE ${table} MATCH '${match.replace(/'/g, "''")}' ${where} ORDER BY b.id`,
  );
  return rows.map((r) => r.id);
}

beforeAll(async () => {
  await mkdir(path.join(WORKERS, ".wrangler"), { recursive: true });
  persistTo = await mkdtemp(path.join(WORKERS, ".wrangler", "t-"));
  target = { remote: false, persistTo, database: "moocs-mcp", bucket: "moocs-slides" };
  await runWrangler(["d1", "execute", "moocs-mcp", "--local", "--persist-to", persistTo, "--file", SCHEMA]);
});

afterAll(async () => {
  await rm(persistTo, { recursive: true, force: true });
});

describe("ingest (local D1 + R2)", () => {
  let firstSnapshot: unknown[];

  it("fixture 1 コース分を投入できる", async () => {
    const { code, summary } = await ingest(FIXTURE);
    expect(code).toBe(0);
    expect(summary).toMatchObject({ courses: 1, lectures: 3, contents: 5, uploaded: 2, collector_errors: 1 });

    const [counts] = await q(
      "SELECT (SELECT count(*) FROM courses) c, (SELECT count(*) FROM lectures) l, (SELECT count(*) FROM contents) n",
    );
    expect(counts).toEqual({ c: 1, l: 3, n: 5 });

    const [course] = await q("SELECT id, code, name, aliases FROM courses");
    expect(course).toEqual({
      id: "2026/INI201",
      code: "INI201",
      name: "データサイエンス基礎",
      aliases: "DS基礎,データサイエンス",
    });

    // スライド取得に失敗したレクチャーも、contents 側があればレクチャー行はできる（タイトルは空）
    const [l3] = await q("SELECT title FROM lectures WHERE id = '2026/INI201/03'");
    expect(l3).toEqual({ title: "" });

    firstSnapshot = await q("SELECT 'c' t, rid, id, updated_at FROM courses UNION ALL SELECT 'l', rid, id, updated_at FROM lectures UNION ALL SELECT 'n', rid, id, updated_at FROM contents ORDER BY 1, 2");
  });

  it("R2 モックに PDF が入り、D1 の r2_key / sha256 と一致する", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "r2-"));
    try {
      const dest = path.join(tmp, "slides.pdf");
      await runWrangler(["r2", "object", "get", "moocs-slides/2026/INI201/02/slides.pdf", "--local", "--persist-to", persistTo, "--file", dest]);
      const got = createHash("sha256").update(await readFile(dest)).digest("hex");
      const [row] = await q<{ r2_key: string; sha256: string }>("SELECT r2_key, sha256 FROM contents WHERE id = '2026/INI201/02/slide'");
      expect(row.r2_key).toBe("2026/INI201/02/slides.pdf");
      expect(got).toBe(row.sha256);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("再実行しても二重登録されず、rid も updated_at も変わらない", async () => {
    const { code, summary } = await ingest(FIXTURE);
    expect(code).toBe(0);
    expect(summary).toMatchObject({ uploaded: 0, unchanged_slides: 2 });

    const again = await q("SELECT 'c' t, rid, id, updated_at FROM courses UNION ALL SELECT 'l', rid, id, updated_at FROM lectures UNION ALL SELECT 'n', rid, id, updated_at FROM contents ORDER BY 1, 2");
    expect(again).toEqual(firstSnapshot);

    // FTS 側にも重複が無い
    const [fts] = await q("SELECT (SELECT count(*) FROM contents_fts) n, (SELECT count(*) FROM lectures_fts) l");
    expect(fts).toEqual({ n: 5, l: 3 });
  });

  describe("バイグラム FTS で日本語部分一致できる", () => {
    it.each([
      ["courses_fts", "サイエンス基", ["2026/INI201"]],
      ["courses_fts", "ds基礎", ["2026/INI201"]], // 別名・大文字小文字無視
      ["courses_fts", "ＩＮＩ２０１", ["2026/INI201"]], // 全角英数字も NFKC で一致
      ["lectures_fts", "ダイバージェンス", ["2026/INI201/02"]],
      ["lectures_fts", "第２回", ["2026/INI201/02"]], // 2 文字 + 全角数字
      ["contents_fts", "ダイバージェンス", ["2026/INI201/02/quiz"]],
      ["contents_fts", "迷惑メール", ["2026/INI201/03/assignment"]],
      ["contents_fts", "課題", ["2026/INI201/02/assignment", "2026/INI201/03/assignment"]], // 2 文字
      ["contents_fts", "乱数", ["2026/INI201/02/assignment"]], // 2 文字（本文）
      ["contents_fts", "問", ["2026/INI201/02/quiz"]], // 1 文字は前方一致
      ["contents_fts", "ベイズ 確率", ["2026/INI201/03/assignment"]], // 空白区切りは AND
      ["contents_fts", "mathrm", ["2026/INI201/02/quiz"]], // LaTeX も索引される
      ["contents_fts", "メールフィルタ判定", []], // 連続していない並びはヒットしない
      ["contents_fts", "answer", []], // <script> の中身は索引しない
      ["contents_fts", "problem", []], // HTML の属性値も索引しない
    ] as const)("%s: %s", async (table, query, expected) => {
      expect(await search(table, query)).toEqual(expected);
    });

    it("type で絞り込める", async () => {
      expect(await search("contents_fts", "なさい", "AND b.type = 'assignment'")).toEqual([
        "2026/INI201/02/assignment",
        "2026/INI201/03/assignment",
      ]);
    });
  });

  it("タイトルや PDF の変更が本体・FTS・R2 に反映される", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sample-out-"));
    try {
      await cp(FIXTURE, dir, { recursive: true });
      const slides = path.join(dir, "collect-slides.jsonl");
      await writeFile(slides, (await readFile(slides, "utf8")).replace("確率分布とKLダイバージェンス", "エントロピーと情報量"));
      const pdf = path.join(dir, "2026/INI201/01/slides.pdf");
      await writeFile(pdf, Buffer.concat([await readFile(pdf), Buffer.from("% updated\n")]));

      const { code, summary } = await ingest(dir);
      expect(code).toBe(0);
      expect(summary).toMatchObject({ uploaded: 1, unchanged_slides: 1 });

      expect(await search("lectures_fts", "エントロピー")).toEqual(["2026/INI201/02"]);
      expect(await search("lectures_fts", "ダイバージェンス")).toEqual([]);
      // 本体の *_bg と FTS が一致している（external content の整合性チェック）
      await q("INSERT INTO lectures_fts (lectures_fts, rank) VALUES ('integrity-check', 1)");

      const [counts] = await q("SELECT (SELECT count(*) FROM lectures) l, (SELECT count(*) FROM lectures_fts) f");
      expect(counts).toEqual({ l: 3, f: 3 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("契約違反の行があれば、正常分は反映したうえで exit 1", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sample-out-"));
    try {
      await cp(FIXTURE, dir, { recursive: true });
      const contents = path.join(dir, "collect-contents.jsonl");
      await writeFile(
        contents,
        (await readFile(contents, "utf8")) +
          JSON.stringify({ event: "done", year: 2026, course: "INI201", lecture: 1, type: "quiz", file: "../../secret.html" }) +
          "\n",
      );

      const { code, events, summary } = await ingest(dir);
      expect(code).toBe(1);
      expect(events.some((e) => e.event === "rejected")).toBe(true);
      expect(summary).toMatchObject({ rejected: 1, contents: 5 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
