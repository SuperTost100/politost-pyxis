import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// A virus scanner holding a file makes Windows refuse to delete the folder it is in (EBUSY). The stand-in refuses to
// remove any `.wipe` folder while `held` is set; everything else goes to the real file system.
const fs = vi.hoisted(() => ({
  held: false,
  refuseMove: null as string | null,
}));
vi.mock("node:fs", async (original) => {
  const real = await original<typeof import("node:fs")>();
  return {
    ...real,
    rmSync: (path: string, options?: Parameters<typeof real.rmSync>[1]) => {
      if (fs.held && basename(String(path)) === ".wipe")
        throw Object.assign(
          new Error(`EBUSY: resource busy or locked, rmdir '${path}'`),
          { code: "EBUSY" },
        );
      real.rmSync(path, options);
    },
    renameSync: (from: string, to: string) => {
      if (
        fs.refuseMove &&
        basename(String(from)) === fs.refuseMove &&
        String(to).includes(".wipe")
      )
        throw Object.assign(
          new Error(`EPERM: operation not permitted, rename '${from}'`),
          { code: "EPERM" },
        );
      real.renameSync(from, to);
    },
  };
});

const { recoverInterruptedWipe, wipePending, wipeWorkspace } =
  await import("./wipe");

afterEach(() => {
  fs.held = false;
  fs.refuseMove = null;
});

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "pyxis-wipe-held-"));
  writeFileSync(join(dir, "pyxis.db"), "study data");
  mkdirSync(join(dir, "blobs"));
  writeFileSync(join(dir, "blobs", "note.txt"), "nota");
  return dir;
}

describe("a wipe whose holding folder can't be removed", () => {
  it("counts as done once the data is out, and leaves the folder for the next start", () => {
    const dir = workspace();
    fs.held = true;
    expect(wipeWorkspace(dir)).toBe(false);
    expect(wipePending(dir)).toBe(false);
    expect(existsSync(join(dir, "pyxis.db"))).toBe(false);
    expect(existsSync(join(dir, "blobs", "note.txt"))).toBe(false);
    expect(existsSync(join(dir, "blobs"))).toBe(true);
    // The next start finds no INCOMPLETE marker, so nothing in the leftover folder comes back.
    fs.held = false;
    recoverInterruptedWipe(dir);
    expect(existsSync(join(dir, ".wipe"))).toBe(false);
    expect(existsSync(join(dir, "pyxis.db"))).toBe(false);
  });

  it("finishes recovery of an interrupted wipe even when the empty folder stays", () => {
    const dir = mkdtempSync(join(tmpdir(), "pyxis-wipe-held-"));
    const holding = join(dir, ".wipe");
    mkdirSync(holding);
    writeFileSync(join(holding, "INCOMPLETE"), "1");
    writeFileSync(join(holding, "pyxis.db"), "kept");
    fs.held = true;
    recoverInterruptedWipe(dir);
    expect(readFileSync(join(dir, "pyxis.db"), "utf8")).toBe("kept");
    expect(wipePending(dir)).toBe(false);
  });

  it("does not start a new wipe over a leftover folder, so an older copy can never be put back", () => {
    const dir = workspace();
    mkdirSync(join(dir, ".wipe"));
    writeFileSync(join(dir, ".wipe", "pyxis.db"), "deleted last time");
    fs.held = true;
    expect(() => wipeWorkspace(dir)).toThrow(/EEXIST/);
    expect(readFileSync(join(dir, "pyxis.db"), "utf8")).toBe("study data");
    expect(wipePending(dir)).toBe(false);
  });

  it("puts the data back when a move fails, reports that failure, and leaves nothing to restore", () => {
    const dir = workspace();
    fs.refuseMove = "blobs";
    fs.held = true;
    expect(() => wipeWorkspace(dir)).toThrow(/EPERM/);
    expect(readFileSync(join(dir, "pyxis.db"), "utf8")).toBe("study data");
    expect(readFileSync(join(dir, "blobs", "note.txt"), "utf8")).toBe("nota");
    expect(wipePending(dir)).toBe(false);
  });
});
