import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../db/connection";

// Stand-in programs for Claude Code and Antigravity, read through the real cli-funnel detection: `agy` says which version it is.
const dirs: string[] = [];
const saved: Record<string, string | undefined> = {};

function standIns(agyVersion: string) {
  const dir = mkdtempSync(join(tmpdir(), "pyxis-outdated-"));
  dirs.push(dir);
  const script = (name: string, body: string) => {
    const path = join(dir, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  };
  const env = {
    CLI_FUNNEL_NO_SHELL_PATH: "1",
    CLI_FUNNEL_CLAUDE_BIN: script("claude", `case "$1" in --version) echo "2.1.0";; auth) echo '{"loggedIn":true,"authMethod":"claude.ai"}';; *) exit 1;; esac`),
    CLI_FUNNEL_CODEX_BIN: script("codex", `case "$1" in --version) echo "codex-cli 0.150.0";; login) echo "Not logged in"; exit 1;; *) exit 1;; esac`),
    CLI_FUNNEL_AGY_BIN: script(
      "agy",
      `case "$1" in --version) echo "${agyVersion}";; models) printf 'gemini-3.8-flash\\tGemini 3.8 Flash\\ngemini-4-argon\\tGemini 4 Argon\\n';; *) exit 1;; esac`,
    ),
  };
  for (const [key, value] of Object.entries(env)) {
    saved[key] ??= process.env[key];
    process.env[key] = value;
  }
}

/** The handlers, the generator and the bench of a fresh module graph, so no detection is cached from an earlier test. */
async function fresh() {
  vi.resetModules();
  const handlers = await import("./handlers");
  const generate = await import("./generate");
  const bench = await import("./bench");
  const funnel = await import("./funnel");
  const db = openDatabase(":memory:");
  return { db, bench, funnel, generate, engines: handlers.engineHandlers(db, () => undefined) };
}

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("an Antigravity program older than 1.5", () => {
  it("is not ready, not planned for any task, and the row says it needs an update", async () => {
    standIns("1.4.0");
    const { db, engines, funnel, bench } = await fresh();
    const rows = await engines.overview();
    const agy = rows.find((row) => row.id === "antigravity")!;
    expect(agy).toMatchObject({ installed: true, loggedIn: true, version: "1.4.0", outdated: true });
    expect(rows.find((row) => row.id === "claude")).toMatchObject({ loggedIn: true, outdated: false });
    const plan = await engines.autoConfigure({});
    expect(plan.ready).toEqual(["claude"]);
    expect(Object.values(plan.features).map((feature) => feature.provider)).not.toContain("antigravity");
    // It is left out of every job's next step like a tool that is not there.
    expect(bench.isBenched("antigravity")).toBe(true);
    expect(bench.isOutdated("antigravity")).toBe(true);
    funnel.closeFunnel();
    db.close();
  });

  it("is passed over by a job that chose it: the job moves on to the next tool and never calls it", async () => {
    standIns("1.4.0");
    const { db, engines, generate, funnel } = await fresh();
    await engines.autoConfigure({});
    const asked: string[] = [];
    const output = await generate.generate({
      selection: { provider: "antigravity", model: "gemini-3.8-flash", chosenFor: "lesson" },
      prompt: "teach",
      run: async (input) => {
        asked.push(input.selection.provider);
        return { text: "ok", model: input.selection.model, provider: input.selection.provider, inputTokens: 1 };
      },
    });
    expect(asked).toEqual(["claude"]);
    expect(output.provider).toBe("claude");
    funnel.closeFunnel();
    db.close();
  });

  it("is ready from 1.5.0 on, planned like any tool, and not left out", async () => {
    standIns("1.5.0");
    const { db, engines, funnel, bench } = await fresh();
    const rows = await engines.overview();
    expect(rows.find((row) => row.id === "antigravity")).toMatchObject({ installed: true, loggedIn: true, version: "1.5.0", outdated: false });
    const plan = await engines.autoConfigure({});
    expect(plan.ready).toEqual(["claude", "antigravity"]);
    expect(Object.values(plan.features).map((feature) => feature.provider)).toContain("antigravity");
    expect(bench.isBenched("antigravity")).toBe(false);
    funnel.closeFunnel();
    db.close();
  });
});
