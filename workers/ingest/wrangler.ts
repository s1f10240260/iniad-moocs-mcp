/**
 * wrangler CLI 経由で D1 / R2 を操作する薄いラッパー。
 * --local（Miniflare の D1 / R2 モック）と --remote を同じコードで扱う。
 */

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const WRANGLER_JS = require.resolve("wrangler/bin/wrangler.js");
const WORKERS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export interface WranglerTarget {
  remote: boolean;
  /** --local 時の永続化ディレクトリ（テスト用）。未指定なら workers/.wrangler/state */
  persistTo?: string;
  /** wrangler.toml の D1 database_name */
  database: string;
  /** wrangler.toml の R2 bucket_name */
  bucket: string;
}

export class WranglerError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(message);
  }
}

function modeArgs(t: WranglerTarget): string[] {
  if (t.remote) return ["--remote"];
  return t.persistTo ? ["--local", "--persist-to", t.persistTo] : ["--local"];
}

export function runWrangler(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WRANGLER_JS, ...args], {
      cwd: WORKERS_DIR,
      env: { ...process.env, WRANGLER_SEND_METRICS: "false", NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new WranglerError(`wrangler ${args.slice(0, 3).join(" ")} failed (exit ${code})`, stderr + stdout));
    });
  });
}

interface D1Result<T> {
  results: T[];
  success: boolean;
}

/** SELECT を 1 文実行して行を返す */
export async function d1Query<T>(t: WranglerTarget, sql: string): Promise<T[]> {
  const out = await runWrangler(["d1", "execute", t.database, ...modeArgs(t), "--json", "--command", sql]);
  const parsed = JSON.parse(out) as D1Result<T>[];
  return parsed.flatMap((r) => r.results ?? []);
}

export async function d1ExecuteFile(t: WranglerTarget, file: string): Promise<void> {
  // リモートは確認プロンプトを出さないよう --yes を付ける
  const extra = t.remote ? ["--yes"] : [];
  await runWrangler(["d1", "execute", t.database, ...modeArgs(t), "--file", file, ...extra]);
}

export async function r2Put(t: WranglerTarget, key: string, file: string, contentType: string): Promise<void> {
  await runWrangler([
    "r2",
    "object",
    "put",
    `${t.bucket}/${key}`,
    ...modeArgs(t),
    "--file",
    file,
    "--content-type",
    contentType,
  ]);
}

export async function r2Get(t: WranglerTarget, key: string, dest: string): Promise<void> {
  await runWrangler(["r2", "object", "get", `${t.bucket}/${key}`, ...modeArgs(t), "--file", dest]);
}
