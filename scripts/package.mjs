import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// File Provider adds Finder metadata to app bundles in synced project folders.
// Build archives on the local temporary filesystem before copying the artifacts.
const require = createRequire(import.meta.url);
const staging = mkdtempSync(join(tmpdir(), "pyxis-package-"));
try {
  execFileSync(
    process.execPath,
    [
      require.resolve("electron-builder/out/cli/cli.js"),
      ...process.argv.slice(2),
      `--config.directories.output=${staging}`,
    ],
    { stdio: "inherit" },
  );
  mkdirSync(resolve("dist"), { recursive: true });
  for (const name of readdirSync(staging)) {
    const destination = resolve("dist", name);
    rmSync(destination, { recursive: true, force: true });
    cpSync(join(staging, name), destination, {
      recursive: true,
      verbatimSymlinks: true,
    });
  }
} finally {
  rmSync(staging, { recursive: true, force: true });
}
