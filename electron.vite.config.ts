import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";

const root = import.meta.dirname;
const parser = resolve(
  root,
  "node_modules/@politost/content-core/src/parser.ts",
);

function copySandboxPage(): Plugin {
  return {
    name: "copy-sandbox-page",
    apply: "build",
    generateBundle() {
      for (const [name, sourceName] of [
        ["sandbox.html", "index.html"],
        ["host.js", "host.js"],
        ["python-worker.js", "python-worker.js"],
        ["check-worker.js", "check-worker.js"],
        ["symbolic.py", "symbolic.py"],
      ] as const) {
        this.emitFile({
          type: "asset",
          fileName: `runtime/${name}`,
          source: readFileSync(resolve(root, "src/sandbox", sourceName)),
        });
      }
    },
  };
}

export default defineConfig({
  main: {
    resolve: { alias: { "@politost/smartbook-parser": parser } },
    build: {
      rollupOptions: {
        input: {
          index: resolve(root, "src/main/index.ts"),
          core: resolve(root, "src/core/index.ts"),
          "archive-worker": resolve(root, "src/main/archive-worker.ts"),
          "extract-worker": resolve(root, "src/core/sources/extract-worker.ts"),
          "embed-worker": resolve(root, "src/core/sources/embed-worker.ts"),
        },
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: {
          index: resolve(root, "src/preload/index.ts"),
        },
        output: {
          format: "cjs",
          entryFileNames: "[name].cjs",
        },
      },
    },
  },
  renderer: {
    resolve: {
      alias: {
        "@shared": resolve(root, "src/shared"),
      },
    },
    plugins: [react(), copySandboxPage()],
    // electron-vite leaves the renderer unminified; minifying it shrinks what the window parses at startup.
    build: { minify: "esbuild" },
  },
});
