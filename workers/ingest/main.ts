import { EXIT_RUNTIME, run } from "./cli.js";
import { WranglerError } from "./wrangler.js";

// process.exit() は Windows のパイプで stdout の書き込み（summary 行）を取りこぼすので exitCode を使う
run(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
    if (e instanceof WranglerError) process.stderr.write(`${e.stderr}\n`);
    process.exitCode = EXIT_RUNTIME;
  },
);
