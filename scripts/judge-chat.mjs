// Bundles scripts/judge-chat.ts, whose prompts come in as `?raw` text, and runs it under Node. See that file.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";

const raw = {
  name: "raw",
  setup(b) {
    b.onResolve({ filter: /\?raw$/ }, (a) => ({
      path: new URL(a.path.replace(/\?raw$/, ""), `file://${a.resolveDir}/`).pathname,
      namespace: "raw",
    }));
    b.onLoad({ filter: /.*/, namespace: "raw" }, (a) => ({ contents: readFileSync(a.path, "utf8"), loader: "text" }));
  },
};
await build({
  entryPoints: ["scripts/judge-chat.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: ".tmp/judge-chat.mjs",
  plugins: [raw],
  external: ["better-sqlite3", "electron", "cli-funnel"],
  logLevel: "error",
  banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
});
process.exit(spawnSync(process.execPath, [".tmp/judge-chat.mjs", ...process.argv.slice(2)], { stdio: "inherit" }).status ?? 1);
