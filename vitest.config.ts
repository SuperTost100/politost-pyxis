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
    // Windows runners are slow to start jobs and to finish polling on them.
    testTimeout: process.env.CI ? 20_000 : 5_000,
    expect: { poll: { timeout: 10_000 } },
    server: {
      deps: {
        external: ["better-sqlite3", "sqlite-vec"],
      },
    },
  },
});
