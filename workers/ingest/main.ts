import { EXIT_RUNTIME, run } from "./cli.js";
import { WranglerError } from "./wrangler.js";

run(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: unknown) => {
    process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
    if (e instanceof WranglerError) process.stderr.write(`${e.stderr}\n`);
    process.exit(EXIT_RUNTIME);
  },
);
