import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";

const require = createRequire(import.meta.url);
const electronRoot = dirname(require.resolve("electron/package.json"));
const relativeBin = readFileSync(join(electronRoot, "path.txt"), "utf8").trim();
const electron = join(electronRoot, "dist", relativeBin);
const vitest = join(
  dirname(require.resolve("vitest/package.json")),
  "vitest.mjs",
);

const child = spawn(electron, [vitest, "run", ...process.argv.slice(2)], {
  stdio: "inherit",
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
});

child.on("exit", (code) => {
  process.exit(code ?? 1);
});
