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
      this.emitFile({
        type: "asset",
        fileName: "sandbox.html",
        source: readFileSync(resolve(root, "src/sandbox/index.html")),
      });
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
  },
});
