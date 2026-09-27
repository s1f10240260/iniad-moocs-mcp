import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // 結合テストは wrangler（workerd）を何度も起動するので長めに取る
    testTimeout: 180_000,
    hookTimeout: 180_000,
    // 同じローカル D1 を順番に操作するため直列実行
    fileParallelism: false,
  },
});
