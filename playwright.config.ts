import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  // Gives the run its own TMPDIR and deletes it afterwards, so a spec that forgets to clean up leaves nothing in /tmp.
  globalSetup: "./scripts/playwright-global-setup.ts",
  timeout: 60_000,
  // Hosted runners spawn the extract worker cold on the first import, which takes longer than 5 s.
  expect: { timeout: process.env.CI ? 15_000 : 5_000 },
});
