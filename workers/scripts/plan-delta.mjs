#!/usr/bin/env node
/**
 * discover JSON と D1 を比較して「新しいもの」だけを書き出す。
 *
 * 入力: discover.json ({ year, lectures[], contents[] })
 * 出力: delta-lectures.txt / delta-contents.txt
 *   - delta-lectures.txt  … "CODE LL" を 1 行ずつ
 *   - delta-contents.txt … "CODE LL TYPE" を 1 行ずつ
 *
 * D1 に繋げない場合は全件を new として扱う（初回投入用）。
 * 使い方:
 *   node workers/scripts/plan-delta.mjs --discover discover.json --outdir .
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function arg(name, fallback = "") {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const discoverPath = arg("--discover", "discover.json");
const outdir = arg("--outdir", ".");
const db = arg("--db", "moocs-mcp");

const discover = JSON.parse(fs.readFileSync(discoverPath, "utf8"));

function d1Select(sql) {
  try {
    const out = execFileSync(
      "npx",
      ["wrangler", "d1", "execute", db, "--remote", "--json", "--command", sql],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const parsed = JSON.parse(out);
    const rows = parsed?.[0]?.results ?? [];
    return rows;
  } catch (e) {
    console.error(`[plan-delta] D1 query failed (${sql}): ${e.message}`);
    return null;
  }
}

const hasCloudflare =
  process.env.CLOUDFLARE_API_TOKEN && process.env.CLOUDFLARE_ACCOUNT_ID;

let existingLectures = new Set();
let existingContents = new Set();

if (hasCloudflare) {
  const lecRows = d1Select("SELECT id FROM lectures");
  const contRows = d1Select("SELECT id FROM contents");
  if (lecRows && contRows) {
    existingLectures = new Set(lecRows.map((r) => r.id));
    existingContents = new Set(contRows.map((r) => r.id));
  } else {
    console.error("[plan-delta] D1 が読めないため全件を new として扱います");
  }
} else {
  console.error("[plan-delta] CLOUDFLARE_* 未設定 → 全件を new として扱います");
}

const newLectures = [];
for (const lec of discover.lectures ?? []) {
  if (!existingLectures.has(lec.id)) {
    newLectures.push(`${lec.code} ${lec.number}`);
  }
}

const newContents = [];
for (const c of discover.contents ?? []) {
  if (!existingContents.has(c.id)) {
    newContents.push(`${c.code} ${c.number} ${c.type}`);
  }
}

fs.mkdirSync(outdir, { recursive: true });
fs.writeFileSync(path.join(outdir, "delta-lectures.txt"), newLectures.join("\n") + (newLectures.length ? "\n" : ""));
fs.writeFileSync(path.join(outdir, "delta-contents.txt"), newContents.join("\n") + (newContents.length ? "\n" : ""));

console.error(
  `[plan-delta] lectures: ${newLectures.length}/${(discover.lectures ?? []).length} new, contents: ${newContents.length}/${(discover.contents ?? []).length} new`,
);
console.log(JSON.stringify({ newLectures: newLectures.length, newContents: newContents.length }));
