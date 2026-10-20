import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { rendererCsp } from "./csp";

const handlers = vi.hoisted(
  () => new Map<string, (request: Request) => Promise<Response>>(),
);
vi.mock("electron", () => ({
  protocol: {
    handle: (scheme: string, handler: (request: Request) => Promise<Response>) =>
      handlers.set(scheme, handler),
  },
}));

const { APP_PAGE, appFile, registerAppProtocol } = await import("./app-protocol");

let dir = "";
let root = "";
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "pyxis-app-protocol-"));
  root = join(dir, "renderer");
  mkdirSync(join(root, "assets"), { recursive: true });
  writeFileSync(join(root, "index.html"), "<!doctype html>");
  writeFileSync(join(root, "assets", "index-abc.js"), "export {};");
  writeFileSync(join(root, "assets", "font.woff2"), "font");
  writeFileSync(join(dir, "secret.txt"), "secret");
  writeFileSync(join(dir, "renderer-sibling.txt"), "sibling");
  symlinkSync(join(dir, "secret.txt"), join(root, "assets", "link.txt"));
  symlinkSync(dir, join(root, "outside"), "dir");
  symlinkSync(join(root, "index.html"), join(root, "assets", "inside.html"));
  registerAppProtocol(root);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("pyxis-app protocol", () => {
  it("serves the page and its assets from the renderer folder", () => {
    // The answer is the real path: on macOS the temporary folder itself is behind a symlink.
    const real = (...parts: string[]) => realpathSync(join(root, ...parts));
    expect(appFile(root, APP_PAGE)).toBe(real("index.html"));
    expect(appFile(root, `${APP_PAGE}#/exams`)).toBe(real("index.html"));
    expect(appFile(root, "pyxis-app://app/assets/index-abc.js")).toBe(
      real("assets", "index-abc.js"),
    );
    expect(appFile(root, "pyxis-app://app/assets/inside.html")).toBe(
      real("index.html"),
    );
  });

  it("serves files under a root reached through a symlink", () => {
    const linked = join(dir, "linked-renderer");
    symlinkSync(root, linked, "dir");
    expect(appFile(linked, APP_PAGE)).toBe(realpathSync(join(root, "index.html")));
    expect(appFile(linked, "pyxis-app://app/assets/link.txt")).toBeNull();
  });

  it("refuses paths that leave the folder, plain or encoded", () => {
    for (const url of [
      "pyxis-app://app/../secret.txt",
      "pyxis-app://app/assets/../../secret.txt",
      "pyxis-app://app/%2e%2e/secret.txt",
      "pyxis-app://app/assets/%2E%2E/%2E%2E/secret.txt",
      "pyxis-app://app/..%2fsecret.txt",
      "pyxis-app://app/assets%2F..%2F..%2Fsecret.txt",
      "pyxis-app://app/..%5csecret.txt",
      "pyxis-app://app/%5C..%5Csecret.txt",
      "pyxis-app://app/../renderer-sibling.txt",
    ])
      expect(appFile(root, url), url).toBeNull();
  });

  it("refuses absolute paths, NUL bytes and malformed escapes", () => {
    for (const url of [
      `pyxis-app://app/${encodeURIComponent(join(dir, "secret.txt"))}`,
      `pyxis-app://app//${join(dir, "secret.txt").replace(/^\//, "")}`,
      "pyxis-app://app/C:%5CWindows%5Cwin.ini",
      "pyxis-app://app/index.html%00.js",
      "pyxis-app://app/%E0%A4%A",
    ])
      expect(appFile(root, url), url).toBeNull();
  });

  it("refuses symlinks that point out of the folder", () => {
    expect(appFile(root, "pyxis-app://app/assets/link.txt")).toBeNull();
    expect(appFile(root, "pyxis-app://app/outside/secret.txt")).toBeNull();
  });

  it("refuses other hosts, schemes, queries, credentials, folders and missing files", () => {
    for (const url of [
      "pyxis-app://other/index.html",
      "pyxis-app://app:8080/index.html",
      "pyxis-app://user:pass@app/index.html",
      "pyxis-app://app/index.html?x=1",
      "file:///index.html",
      "pyxis-blob://app/index.html",
      "pyxis-app://app/",
      "pyxis-app://app/assets",
      "pyxis-app://app/assets/",
      "pyxis-app://app/missing.js",
      "not a url",
    ])
      expect(appFile(root, url), url).toBeNull();
  });

  it("answers with the window CSP and the file's type, and 404 for anything else", async () => {
    const handle = handlers.get("pyxis-app")!;
    const page = await handle(new Request(APP_PAGE));
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toBe(rendererCsp());
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await page.text()).toBe("<!doctype html>");
    const script = await handle(
      new Request("pyxis-app://app/assets/index-abc.js"),
    );
    expect(script.headers.get("content-type")).toBe(
      "text/javascript; charset=utf-8",
    );
    expect(script.headers.get("x-content-type-options")).toBe("nosniff");
    const font = await handle(new Request("pyxis-app://app/assets/font.woff2"));
    expect(font.headers.get("content-type")).toBe("font/woff2");
    const refused = await handle(new Request("pyxis-app://app/../secret.txt"));
    expect(refused.status).toBe(404);
    expect(refused.headers.get("content-security-policy")).toBe(rendererCsp());
    expect(
      (await handle(new Request(APP_PAGE, { method: "POST", body: "x" })))
        .status,
    ).toBe(404);
  });
});
