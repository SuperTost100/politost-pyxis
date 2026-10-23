import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  userData: "",
  synced: [] as string[],
  opened: new Map<number, string>(),
  failRename: false,
}));
vi.mock("electron", () => ({
  app: {
    getPath: (name: string) => (name === "userData" ? fake.userData : ""),
  },
}));
// Records which files were flushed to disk before they were renamed into place.
vi.mock("node:fs", async (original) => {
  const real = await original<typeof import("node:fs")>();
  return {
    ...real,
    openSync: (...args: Parameters<typeof real.openSync>) => {
      const fd = real.openSync(...args);
      fake.opened.set(fd, String(args[0]));
      return fd;
    },
    fsyncSync: (fd: number) => {
      fake.synced.push(fake.opened.get(fd) ?? "?");
      real.fsyncSync(fd);
    },
    renameSync: (from: string, to: string) => {
      if (fake.failRename) throw new Error("power-cut");
      real.renameSync(from, to);
    },
  };
});

const { ensureWorkspace, saveWorkspacePath } = await import("./workspace");

beforeEach(() => {
  fake.userData = mkdtempSync(join(tmpdir(), "pyxis-config-"));
  fake.synced.length = 0;
  fake.opened.clear();
  fake.failRename = false;
});
afterEach(() => {
  rmSync(fake.userData, { recursive: true, force: true });
});

const config = () => join(fake.userData, "config.json");
/** The temporary file config.json is written to and flushed before it replaces the old one. */
const flushedConfig = /[\\/]\.config\.json\.[0-9a-f-]+\.tmp$/;
const defaultWorkspace = () => join(fake.userData, "workspace");

describe("ensureWorkspace", () => {
  it("creates the default workspace on a first launch and records it durably", () => {
    expect(ensureWorkspace()).toBe(defaultWorkspace());
    expect(existsSync(join(defaultWorkspace(), "blobs"))).toBe(true);
    expect(JSON.parse(readFileSync(config(), "utf8"))).toEqual({
      workspacePath: defaultWorkspace(),
    });
    expect(fake.synced).toContainEqual(expect.stringMatching(flushedConfig));
  });

  it("opens a moved workspace", () => {
    const moved = mkdtempSync(join(tmpdir(), "pyxis-moved-"));
    try {
      writeFileSync(join(moved, "pyxis.db"), "");
      writeFileSync(config(), JSON.stringify({ workspacePath: moved }));
      expect(ensureWorkspace()).toBe(moved);
      expect(existsSync(defaultWorkspace())).toBe(false);
    } finally {
      rmSync(moved, { recursive: true, force: true });
    }
  });

  it.each([
    ["empty after a power cut", ""],
    ["cut off mid-write", '{"workspacePath": "/Vol'],
    ["without a path", "{}"],
    ["with a relative path", '{"workspacePath": "workspace"}'],
    ["not an object", "null"],
  ])(
    "treats a config.json %s as a missing workspace, not as the default one",
    (_, text) => {
      writeFileSync(config(), text);
      expect(() => ensureWorkspace()).toThrow("workspace-missing");
      // Nothing is created or overwritten, so the saved path can still be repaired.
      expect(readFileSync(config(), "utf8")).toBe(text);
      expect(existsSync(defaultWorkspace())).toBe(false);
    },
  );

  it("treats a config.json it can't read as a missing workspace", () => {
    mkdirSync(config());
    expect(() => ensureWorkspace()).toThrow("workspace-missing");
    expect(existsSync(defaultWorkspace())).toBe(false);
  });
});

describe("saveWorkspacePath", () => {
  it("flushes the new path before replacing the old one", () => {
    saveWorkspacePath("/Volumes/USB/Pyxis workspace");
    expect(fake.synced[0]).toMatch(flushedConfig);
    expect(JSON.parse(readFileSync(config(), "utf8"))).toEqual({
      workspacePath: "/Volumes/USB/Pyxis workspace",
    });
  });

  it("leaves the old path in place when the replace fails", () => {
    saveWorkspacePath("/old");
    fake.failRename = true;
    expect(() => saveWorkspacePath("/new")).toThrow("power-cut");
    expect(JSON.parse(readFileSync(config(), "utf8"))).toEqual({
      workspacePath: "/old",
    });
  });
});
