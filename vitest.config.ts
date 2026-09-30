import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@politost/smartbook-parser": resolve(
        import.meta.dirname,
        "node_modules/@politost/content-core/src/parser.ts",
      ),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    server: {
      deps: {
        external: ["better-sqlite3", "sqlite-vec"],
      },
    },
  },
});
