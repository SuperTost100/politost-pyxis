import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findAntigravity } from "./terminal";

const dirs: string[] = [];
function folderWithAgy(): string {
  const dir = mkdtempSync(join(tmpdir(), "pyxis-agy-"));
  dirs.push(dir);
  const agy = join(dir, "agy");
  writeFileSync(agy, "#!/bin/sh\n");
  chmodSync(agy, 0o755);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("findAntigravity", () => {
  it.skipIf(process.platform === "win32")("finds agy on PATH", () => {
    const dir = folderWithAgy();
    expect(findAntigravity({ PATH: `/nowhere:${dir}` }, "linux")).toBe(
      join(dir, "agy"),
    );
  });

  it.skipIf(process.platform === "win32")(
    "prefers the CLI Funnel override",
    () => {
      const dir = folderWithAgy();
      const other = folderWithAgy();
      expect(
        findAntigravity(
          { PATH: dir, CLI_FUNNEL_AGY_BIN: join(other, "agy") },
          "linux",
        ),
      ).toBe(join(other, "agy"));
    },
  );

  it("returns null when agy is nowhere", () => {
    const home = mkdtempSync(join(tmpdir(), "pyxis-home-"));
    dirs.push(home);
    expect(
      findAntigravity(
        { PATH: "/nowhere", CLI_FUNNEL_AGY_BIN: "/nowhere/agy" },
        "linux",
        home,
      ),
    ).toBeNull();
  });
});
