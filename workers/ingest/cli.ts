/**
 * ingest — Collector の out/ + JSONL を D1 / R2 に冪等に反映する非対話 CLI。
 *
 *   npm run ingest -- --out ../out --jsonl ../collect-slides.jsonl --jsonl ../collect-contents.jsonl
 *
 * 詳細: ../../docs/INGEST.md
 * exit code: 成功 0 / 実行時失敗 1 / 引数不足 2（Collector と同じ契約）
 */

import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { htmlToText, sanitizeHtml } from "./html.js";
import { addJsonl, emptyManifest, type Manifest } from "./manifest.js";
import { pdfToText } from "./pdf.js";
import { buildAliasStatements, buildReindexStatements, buildStatements, type ContentRow, type ReindexRow } from "./sql.js";
import { toBigramText } from "../src/search/bigram.js";
import { d1ExecuteFile, d1Query, r2Get, r2Put, type WranglerTarget } from "./wrangler.js";

export const EXIT_RUNTIME = 1;
const EXIT_USAGE = 2;

const USAGE = `usage: ingest --out <dir> --jsonl <file> [--jsonl <file> ...] [options]

  --out <dir>          Collector の出力ルート（{year}/{CODE}/{LL}/... が並ぶ）
  --jsonl <file>       collect-*.jsonl（複数指定可）
  --aliases <file>     コース別名 JSON（{"INI201": ["DS基礎", ...]}）。このファイルが別名の正本になる
  --remote             本番の D1 / R2 に反映する（既定はローカル）
  --persist-to <dir>   ローカル D1 / R2 の永続化先
  --force-upload       ハッシュが同じ PDF も R2 に再アップロードする
  --backfill-slide-text  既存スライドの content_text を R2 の PDF から埋める（--out/--jsonl 不要）
  --reindex            D1 の全行の *_bg を元列から作り直す（--out/--jsonl 不要）
  --concurrency <n>    R2 アップロード並列数（既定: ローカル 1 / リモート 4）
  --retries <n>        wrangler 呼び出しの再試行回数（既定 3）
  --dry-run            D1 / R2 に触れず、生成した SQL を stdout に出す
  --database <name>    D1 database_name（既定 moocs-mcp）
  --bucket <name>      R2 bucket_name（既定 moocs-slides）`;

class UsageError extends Error {}

interface Options {
  out: string;
  jsonl: string[];
  aliases?: string;
  forceUpload: boolean;
  backfillSlideText: boolean;
  reindex: boolean;
  concurrency: number;
  retries: number;
  dryRun: boolean;
  target: WranglerTarget;
}

function parseOptions(argv: string[]): Options {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        out: { type: "string" },
        jsonl: { type: "string", multiple: true },
        aliases: { type: "string" },
        remote: { type: "boolean", default: false },
        "persist-to": { type: "string" },
        "force-upload": { type: "boolean", default: false },
        "backfill-slide-text": { type: "boolean", default: false },
        reindex: { type: "boolean", default: false },
        concurrency: { type: "string" },
        retries: { type: "string", default: "3" },
        "dry-run": { type: "boolean", default: false },
        database: { type: "string", default: "moocs-mcp" },
        bucket: { type: "string", default: "moocs-slides" },
        help: { type: "boolean", short: "h", default: false },
      },
    }));
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
  if (values.help) throw new UsageError("");
  const backfillSlideText = values["backfill-slide-text"] === true;
  const reindex = values.reindex === true;
  if (!backfillSlideText && !reindex) {
    if (!values.out) throw new UsageError("--out は必須です");
    if (!values.jsonl?.length) throw new UsageError("--jsonl を 1 つ以上指定してください");
  }
  if (values.remote && values["persist-to"]) throw new UsageError("--remote と --persist-to は併用できません");

  const concurrency = values.concurrency === undefined ? (values.remote ? 4 : 1) : Number(values.concurrency);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) {
    throw new UsageError("--concurrency は 1〜16 の整数で指定してください");
  }
  const retries = Number(values.retries);
  if (!Number.isInteger(retries) || retries < 0 || retries > 10) {
    throw new UsageError("--retries は 0〜10 の整数で指定してください");
  }

  // wrangler は workers/ を cwd に動くので、ユーザー指定パスは絶対パスにしておく
  return {
    out: path.resolve(values.out ?? "."),
    jsonl: (values.jsonl ?? []).map((p) => path.resolve(p)),
    aliases: values.aliases && path.resolve(values.aliases),
    forceUpload: values["force-upload"],
    backfillSlideText,
    reindex,
    concurrency,
    retries,
    dryRun: values["dry-run"],
    target: {
      remote: values.remote,
      persistTo: values["persist-to"] && path.resolve(values["persist-to"]),
      database: values.database,
      bucket: values.bucket,
    },
  };
}

async function loadAliases(file: string | undefined): Promise<Map<string, string[]> | undefined> {
  if (!file) return undefined;
  const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new UsageError(`${file}: {"CODE": ["別名", ...]} 形式の JSON にしてください`);
  }
  const map = new Map<string, string[]>();
  for (const [code, list] of Object.entries(parsed)) {
    if (!Array.isArray(list) || !list.every((a) => typeof a === "string")) {
      throw new UsageError(`${file}: "${code}" の値は文字列の配列にしてください`);
    }
    // 区切り文字のカンマは別名に含められない
    map.set(code, list.map((a) => a.replace(/,/g, " ").trim()).filter(Boolean));
  }
  return map;
}

/** 一時的な失敗（ネットワーク・API 5xx・wrangler 起動失敗）に備えて指数バックオフで再試行する */
async function withRetry<T>(retries: number, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= retries) throw e;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  });
  await Promise.all(workers);
}

/** content_text が空のスライドを R2 から埋める */
async function backfillSlideText(
  opts: Options,
  emit: (event: Record<string, unknown>) => void,
): Promise<number> {
  const rows = await withRetry(opts.retries, () =>
    d1Query<{ id: string; r2_key: string | null }>(
      opts.target,
      "SELECT id, r2_key FROM contents WHERE type = 'slide' AND (content_text IS NULL OR content_text = '')",
    ),
  );
  emit({ event: "backfill_start", targets: rows.length });
  const tmp = await mkdtemp(path.join(os.tmpdir(), "moocs-backfill-"));
  let updated = 0;
  let failed = 0;
  try {
    const statements: string[] = [];
    for (const r of rows) {
      const key = r.r2_key ?? `${r.id}/slides.pdf`;
      const dest = path.join(tmp, `${r.id.replace(/[\\/]/g, "_")}.pdf`);
      try {
        await withRetry(opts.retries, () => r2Get(opts.target, key, dest));
      } catch {
        emit({ event: "backfill_missing", id: r.id, key });
        failed++;
        continue;
      }
      const data = await readFile(dest);
      const text = await pdfToText(data);
      if (!text) {
        // 画像 PDF（テキストレイヤなし）は検索対象にできない
        emit({ event: "backfill_no_text_layer", id: r.id, key });
        failed++;
        continue;
      }
      const esc = (s: string) => s.replace(/'/g, "''");
      statements.push(
        `UPDATE contents SET content_text = '${esc(text)}', text_bg = '${esc(toBigramText(text))}' WHERE id = '${esc(r.id)}';`,
      );
      updated++;
      if (statements.length >= 20) {
        const f = path.join(tmp, `batch-${updated}.sql`);
        await writeFile(f, statements.join("\n"), "utf8");
        await withRetry(opts.retries, () => d1ExecuteFile(opts.target, f));
        statements.length = 0;
        emit({ event: "backfill_batch", updated });
      }
    }
    if (statements.length > 0) {
      const f = path.join(tmp, "batch-rest.sql");
      await writeFile(f, statements.join("\n"), "utf8");
      await withRetry(opts.retries, () => d1ExecuteFile(opts.target, f));
      emit({ event: "backfill_batch", updated });
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  emit({ event: "backfill_summary", targets: rows.length, updated, failed });
  return 0;
}

/** D1 全行の *_bg を元列から作り直す */
async function reindexBigram(
  opts: Options,
  emit: (event: Record<string, unknown>) => void,
): Promise<number> {
  const plans: {
    table: "courses" | "lectures" | "contents";
    select: string;
    sources: string[];
  }[] = [
    {
      table: "courses",
      select: "SELECT id, code, name, aliases FROM courses",
      sources: ["code", "name", "aliases"],
    },
    {
      table: "lectures",
      select: "SELECT id, title FROM lectures",
      sources: ["title"],
    },
    {
      table: "contents",
      select: "SELECT id, title, content_text FROM contents",
      sources: ["title", "content_text"],
    },
  ];
  let updated = 0;
  for (const p of plans) {
    const rows = await withRetry(opts.retries, () =>
      d1Query<Record<string, string | null>>(opts.target, p.select),
    );
    const reindexRows: ReindexRow[] = rows.map((r) => {
      const sources: Record<string, string> = {};
      for (const col of p.sources) sources[col] = r[col] ?? "";
      return { id: String(r.id), sources };
    });
    const statements = buildReindexStatements(p.table, reindexRows);
    const tmp = await mkdtemp(path.join(os.tmpdir(), "moocs-reindex-"));
    try {
      for (let i = 0; i < statements.length; i += 50) {
        const chunk = statements.slice(i, i + 50);
        const f = path.join(tmp, `${p.table}-${i}.sql`);
        await writeFile(f, chunk.join("\n"), "utf8");
        await withRetry(opts.retries, () => d1ExecuteFile(opts.target, f));
        updated += chunk.length;
        emit({ event: "reindex_batch", table: p.table, statements: chunk.length });
      }
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
    emit({ event: "reindex_table", table: p.table, rows: rows.length });
  }
  emit({ event: "reindex_summary", statements: updated });
  return 0;
}

export async function run(argv: string[]): Promise<number> {
  let opts: Options;
  try {
    opts = parseOptions(argv);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    if (e.message) process.stderr.write(`error: ${e.message}\n`);
    process.stderr.write(`${USAGE}\n`);
    return EXIT_USAGE;
  }

  // --dry-run では stdout を SQL 専用にし、進捗イベントは stderr へ
  const events = opts.dryRun ? process.stderr : process.stdout;
  const emit = (event: Record<string, unknown>) => events.write(`${JSON.stringify(event)}\n`);

  if (opts.backfillSlideText) {
    return backfillSlideText(opts, emit);
  }
  if (opts.reindex) {
    return reindexBigram(opts, emit);
  }

  const manifest: Manifest = emptyManifest();
  for (const file of opts.jsonl) {
    addJsonl(manifest, path.basename(file), await readFile(file, "utf8"));
  }
  const aliases = await loadAliases(opts.aliases);
  if (aliases?.size === 0) {
    // ファイルが正本なので空なら全コースの別名が消える。意図した操作でもありうるので止めずに警告だけ出す
    emit({ event: "warning", reason: "aliases file is empty; all course aliases will be cleared" });
  }
  for (const r of manifest.rejected) {
    emit({ event: "rejected", source: r.source, line: r.line, reason: r.reason });
  }

  // slide の既存ハッシュ（差分アップロード判定用）
  const known = new Map<string, string | null>();
  if (!opts.dryRun && !opts.forceUpload) {
    const rows = await withRetry(opts.retries, () =>
      d1Query<{ id: string; sha256: string | null }>(opts.target, "SELECT id, sha256 FROM contents WHERE type = 'slide'"),
    );
    for (const r of rows) known.set(r.id, r.sha256);
  }

  const rows: ContentRow[] = [];
  const uploads: { key: string; file: string; id: string }[] = [];
  const missing: string[] = [];

  for (const c of manifest.contents.values()) {
    const abs = path.join(opts.out, ...c.file.split("/"));
    let data: Buffer;
    try {
      data = await readFile(abs);
    } catch {
      missing.push(c.id);
      continue;
    }
    if (c.type === "slide") {
      const sha256 = createHash("sha256").update(data).digest("hex");
      if (known.get(c.id) !== sha256) uploads.push({ key: c.file, file: abs, id: c.id });
      const contentText = await pdfToText(data);
      rows.push({ ...c, contentHtml: "", contentText, r2Key: c.file, sha256 });
    } else {
      const html = data.toString("utf8");
      rows.push({ ...c, contentHtml: sanitizeHtml(html), contentText: htmlToText(html), r2Key: null, sha256: null });
    }
  }
  for (const id of missing) emit({ event: "missing_file", id });

  const { statements, oversized } = buildStatements(manifest, rows);
  // 別名は manifest に関係なくファイルの内容をそのまま反映する（courses の upsert の後に流す）
  if (aliases) statements.push(...buildAliasStatements(aliases));
  for (const id of oversized) emit({ event: "oversized", id });
  const sql = `${statements.join("\n")}\n`;
  // Collector との契約違反があれば CI で気付けるよう失敗扱いにする（正常分は反映する）。
  // collector_errors はリトライ後スキップの想定内なので成功扱い
  const exitCode = manifest.rejected.length + missing.length + oversized.length > 0 ? EXIT_RUNTIME : 0;

  if (opts.dryRun) {
    process.stdout.write(sql);
    return exitCode;
  }

  // R2 → D1 の順。D1 が存在しない R2 オブジェクトを指す瞬間を作らない
  await mapLimit(uploads, opts.concurrency, async (u) => {
    await withRetry(opts.retries, () => r2Put(opts.target, u.key, u.file, "application/pdf"));
    emit({ event: "uploaded", id: u.id, key: u.key });
  });

  const tmp = await mkdtemp(path.join(os.tmpdir(), "moocs-ingest-"));
  try {
    const sqlFile = path.join(tmp, "upsert.sql");
    await writeFile(sqlFile, sql, "utf8");
    // 文はすべて冪等なので、途中まで適用されてから失敗しても丸ごと再実行してよい
    if (statements.length > 0) await withRetry(opts.retries, () => d1ExecuteFile(opts.target, sqlFile));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }

  emit({
    event: "summary",
    target: opts.target.remote ? "remote" : "local",
    courses: manifest.courses.size,
    lectures: manifest.lectures.size,
    contents: rows.length - oversized.length,
    uploaded: uploads.length,
    unchanged_slides: rows.filter((r) => r.type === "slide").length - uploads.length,
    collector_errors: manifest.collectorErrors,
    rejected: manifest.rejected.length,
    missing_files: missing.length,
    oversized: oversized.length,
  });
  return exitCode;
}
