import { mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAX_OPENED_PLAN_BYTES } from "../shared/bridge";
import { isPlanFileName, planFileFromArgv, readOpenedPlan } from "./plan-open";

describe("planFileFromArgv", () => {
  it("finds the file a double-click passes, on first launch and on a second instance", () => {
    expect(planFileFromArgv(["C:\\Users\\Anna\\Fisica 1.pyxis"], "/work")).toBe(
      resolve("/work", "C:\\Users\\Anna\\Fisica 1.pyxis"),
    );
    expect(planFileFromArgv(["/opt/Pyxis/pyxis", "--no-sandbox", "/home/anna/Fisica.pyxis"], "/work")).toBe(
      "/home/anna/Fisica.pyxis",
    );
    expect(planFileFromArgv(["/usr/bin/pyxis", "piani/Analisi.PYXIS"], "/home/anna")).toBe(
      "/home/anna/piani/Analisi.PYXIS",
    );
  });

  it("ignores flags and other files", () => {
    expect(planFileFromArgv([], "/work")).toBeNull();
    expect(planFileFromArgv(["/usr/bin/pyxis", "--open=plan.pyxis", "notes.txt", ".pyxis", ""], "/work")).toBeNull();
  });

  it("takes the first plan file when several are given", () => {
    expect(planFileFromArgv(["a.pyxis", "b.pyxis"], "/w")).toBe("/w/a.pyxis");
  });
});

describe("isPlanFileName", () => {
  it("accepts the saved extension and the documented one, in any case", () => {
    for (const name of ["Fisica 1.pyxis", "x.PYXIS", "x.pyxis.json", "/a/b/c.Pyxis.JSON"])
      expect(isPlanFileName(name), name).toBe(true);
    for (const name of ["plan.json", "plan.pyxis.txt", ".pyxis", "plan.pyxis.exe", "pyxis"])
      expect(isPlanFileName(name), name).toBe(false);
  });
});

describe("readOpenedPlan", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "pyxis-open-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("reads a plan file as text", async () => {
    const path = join(dir, "Fisica.pyxis");
    writeFileSync(path, "\ufeff" + JSON.stringify({ version: 2, title: "Città" }));
    expect(await readOpenedPlan(path)).toEqual({ ok: true, text: '{"version":2,"title":"Città"}' });
  });

  it("refuses a name that is not a plan file, a directory and a missing file", async () => {
    writeFileSync(join(dir, "notes.txt"), "{}");
    mkdirSync(join(dir, "folder.pyxis"));
    expect(await readOpenedPlan(join(dir, "notes.txt"))).toEqual({ ok: false, reason: "not-a-plan-file" });
    expect(await readOpenedPlan(join(dir, "folder.pyxis"))).toEqual({ ok: false, reason: "not-a-plan-file" });
    expect(await readOpenedPlan(join(dir, "gone.pyxis"))).toEqual({ ok: false, reason: "unreadable" });
  });

  it("follows a link only to another plan file", async () => {
    writeFileSync(join(dir, "real.pyxis"), "{}");
    writeFileSync(join(dir, "secret.txt"), "private");
    symlinkSync(join(dir, "real.pyxis"), join(dir, "alias.pyxis"));
    symlinkSync(join(dir, "secret.txt"), join(dir, "trick.pyxis"));
    expect(await readOpenedPlan(join(dir, "alias.pyxis"))).toEqual({ ok: true, text: "{}" });
    expect(await readOpenedPlan(join(dir, "trick.pyxis"))).toEqual({ ok: false, reason: "not-a-plan-file" });
  });

  it("refuses a file over the size cap without reading it, and bytes that are not UTF-8", async () => {
    const big = join(dir, "big.pyxis");
    writeFileSync(big, "");
    truncateSync(big, MAX_OPENED_PLAN_BYTES + 1);
    expect(await readOpenedPlan(big)).toEqual({ ok: false, reason: "too-big" });
    writeFileSync(join(dir, "binary.pyxis"), Buffer.from([0xff, 0xfe, 0x00, 0xc3]));
    expect(await readOpenedPlan(join(dir, "binary.pyxis"))).toEqual({ ok: false, reason: "unreadable" });
  });
});
