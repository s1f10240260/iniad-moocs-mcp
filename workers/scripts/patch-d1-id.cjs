#!/usr/bin/env node
// wrangler.toml の database_id を CLOUDFLARE_DATABASE_ID で置き換える（CI 用）
const fs = require("fs");
const path = require("path");

const id = (process.env.CLOUDFLARE_DATABASE_ID || "").trim();
if (!id) {
  console.log("CLOUDFLARE_DATABASE_ID empty — leave wrangler.toml as-is");
  process.exit(0);
}
const file = path.join(__dirname, "..", "wrangler.toml");
const text = fs.readFileSync(file, "utf8");
const next = text.replace(/database_id = "[^"]*"/, `database_id = "${id}"`);
fs.writeFileSync(file, next);
console.log("wrangler.toml database_id patched");
