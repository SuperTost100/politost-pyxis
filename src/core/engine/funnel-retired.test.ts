import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The real CLI Funnel, with a stand-in for Cursor's program that leaves a mark when it is run.
let folder = "";
const saved = { ...process.env };

beforeAll(() => {
  folder = mkdtempSync(join(tmpdir(), "pyxis-retired-"));
  const program = join(folder, "agent");
  writeFileSync(program, `#!/bin/sh\ntouch "${join(folder, "was-run")}"\necho '{"isAuthenticated":true}'\n`);
  chmodSync(program, 0o755);
  process.env.CLI_FUNNEL_AGENT_BIN = program;
  process.env.CLI_FUNNEL_NO_SHELL_PATH = "1";
});

afterAll(() => {
  process.env = saved;
  rmSync(folder, { recursive: true, force: true });
});

describe("a tool Pyxis no longer offers", () => {
  it.skipIf(process.platform === "win32")("is left out of CLI Funnel before detection, so its program is never run", async () => {
    const { getFunnel } = await import("./funnel");
    const funnel = getFunnel();
    expect(Object.keys(funnel.providers)).not.toContain("agent");
    const rows = await funnel.overview();
    expect(rows.map((row) => row.id)).not.toContain("agent");
    expect(existsSync(join(folder, "was-run"))).toBe(false);
  }, 60_000);
});
