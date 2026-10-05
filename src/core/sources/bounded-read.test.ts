import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// ponytail: a file cannot be made to grow between two calls on demand, so the size the handle reports is faked. The
// bytes behind it are real, which is what a file that grew after its size check looks like.
const lie = vi.hoisted(() => ({ size: null as number | null }));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return {
    ...fs,
    fstatSync: (fd: number) => {
      const info = fs.fstatSync(fd);
      return lie.size == null ? info : Object.assign(Object.create(info), { size: lie.size, isFile: () => true });
    },
  };
});
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      const stat = handle.stat.bind(handle);
      handle.stat = (async (...rest: []) => {
        const info = await stat(...rest);
        return lie.size == null ? info : Object.assign(Object.create(info), { size: lie.size, isFile: () => true });
      }) as typeof handle.stat;
      return handle;
    },
  };
});
const { readBounded, readBoundedSync } = await import("./bounded-read");

const dirs: string[] = [];
afterEach(() => {
  lie.size = null;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function file(bytes: number): string {
  const dir = mkdtempSync(join(tmpdir(), "pyxis-bounded-"));
  dirs.push(dir);
  const path = join(dir, "f.bin");
  writeFileSync(path, Buffer.alloc(bytes, 7));
  return path;
}

describe("bounded reads of a file another process can still write to", () => {
  it("returns a file at or under the cap whole", async () => {
    const path = file(100);
    expect((await readBounded(path, 100)).length).toBe(100);
    expect(readBoundedSync(path, 100).length).toBe(100);
    expect((await readBounded(file(0), 100)).length).toBe(0);
  });

  it("refuses a file over the cap, and a directory, before reading", async () => {
    const path = file(101);
    await expect(readBounded(path, 100)).rejects.toThrow("source-too-big");
    expect(() => readBoundedSync(path, 100)).toThrow("source-too-big");
    await expect(readBounded(join(path, ".."), 100)).rejects.toThrow("source-unreadable");
    expect(() => readBoundedSync(join(path, ".."), 100)).toThrow("source-unreadable");
  });

  it("refuses a file that grew after its size was taken, instead of reading it whole", async () => {
    const path = file(5000);
    lie.size = 40;
    await expect(readBounded(path, 100)).rejects.toThrow("source-changed");
    expect(() => readBoundedSync(path, 100)).toThrow("source-changed");
  });

  it("returns what is left of a file that shrank", async () => {
    const path = file(10);
    lie.size = 50;
    expect((await readBounded(path, 100)).length).toBe(10);
    expect(readBoundedSync(path, 100).length).toBe(10);
  });
});
