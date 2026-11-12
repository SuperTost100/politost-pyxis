import { afterEach, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  realpathSync,
  symlinkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
const importFile = vi.hoisted(() =>
  vi.fn(async ({ path }: { path: string }) => ({
    title: basename(path),
    bytes: readFileSync(path).toString(),
    snapshot: path,
  })),
);
const linkFolders = vi.hoisted(() =>
  vi.fn(async ({ paths }: { paths: string[] }) => ({ folders: paths })),
);
const relocateFolder = vi.hoisted(() =>
  vi.fn(({ path }: { folderId: string; path: string }) => ({ same: true, matched: 0, total: 0, path })),
);
vi.mock("../sources/handlers", () => ({
  sourceHandlers: () => ({ importFile, linkFolders, relocateFolder }),
}));
import {
  addFileGrants,
  attachRendererPort,
  bindSources,
  setJobHandlers,
} from "./server";
import { pickedFileGrant } from "./file-grants";
import { MAX_IMAGE_BYTES } from "../../shared/source-types";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
it("renderer requests cannot mint grants and authorized imports use private temporary snapshots", async () => {
  const root = mkdtempSync(join(tmpdir(), "pyxis-boundary-"));
  roots.push(root);
  mkdirSync(join(root, "scratch"));
  const path = join(root, "lesson.txt");
  writeFileSync(path, "selected lesson");
  bindSources(null as never, root, null as never);
  setJobHandlers({} as never);
  let receive: (event: { data: unknown }) => void = () => {};
  let settle: (response: any) => void = () => {};
  attachRendererPort({
    on: (_event, listener) => {
      receive = listener;
    },
    postMessage: (message) => settle(message),
    start() {},
    close() {},
  });
  async function request(name: string, input: unknown): Promise<any> {
    return new Promise((resolve) => {
      settle = resolve;
      receive({ data: { kind: "req", name, input, id: "test" } });
    });
  }
  const denied = await request("sources.import", { path });
  expect(denied.ok).toBe(false);
  expect(denied.error.code).toBe("file-access-denied");
  expect(importFile).not.toHaveBeenCalled();
  const forged = await request("file-grants", {
    grants: [pickedFileGrant(path)],
  });
  expect(forged.ok).toBe(false);
  expect((await request("sources.import", { path })).ok).toBe(false);
  addFileGrants([pickedFileGrant(path)]);
  const allowed = await request("sources.import", { path });
  expect(allowed.ok).toBe(true);
  expect(allowed.value.title).toBe("lesson.txt");
  expect(allowed.value.bytes).toBe("selected lesson");
  expect(allowed.value.snapshot).not.toBe(path);
  expect(existsSync(allowed.value.snapshot)).toBe(false);
  expect(readFileSync(path).toString()).toBe("selected lesson");
  const tooMany = await request("chats.ask", {
    text: "Read these",
    files: Array(9).fill(path),
  });
  expect(tooMany.ok).toBe(false);
  expect(tooMany.error).toMatchObject({
    code: "attach-too-big",
    messageKey: "errors.attachTooBig",
  });
  const large = join(root, "large.txt");
  writeFileSync(large, Buffer.alloc(15 * 1024 * 1024 + 1));
  addFileGrants([pickedFileGrant(large)]);
  const tooLarge = await request("chats.ask", {
    text: "Read this",
    files: [large],
  });
  expect(tooLarge.ok).toBe(false);
  expect(tooLarge.error).toMatchObject({
    code: "attach-too-big",
    messageKey: "errors.attachTooBig",
  });
  // Imports are capped by size before any buffer exists. A sparse file costs nothing to make.
  const photo = join(root, "huge.png");
  writeFileSync(photo, "");
  truncateSync(photo, MAX_IMAGE_BYTES + 1);
  addFileGrants([pickedFileGrant(photo)]);
  importFile.mockClear();
  for (const name of ["sources.import", "sources.preview"]) {
    const refused = await request(name, { path: photo });
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatchObject({ code: "source-too-big", messageKey: "sources.tooBig" });
  }
  expect(importFile).not.toHaveBeenCalled();
});

it("links only folders a picker or a drop granted, by their real path", async () => {
  const root = mkdtempSync(join(tmpdir(), "pyxis-boundary-"));
  roots.push(root);
  mkdirSync(join(root, "scratch"));
  const study = join(root, "Università");
  mkdirSync(join(study, "Fisica"), { recursive: true });
  writeFileSync(join(study, "orario.txt"), "x");
  const elsewhere = join(root, "elsewhere");
  mkdirSync(elsewhere);
  symlinkSync(elsewhere, join(study, "shortcut"));
  bindSources(null as never, root, null as never);
  setJobHandlers({} as never);
  let receive: (event: { data: unknown }) => void = () => {};
  let settle: (response: any) => void = () => {};
  attachRendererPort({
    on: (_event, listener) => {
      receive = listener;
    },
    postMessage: (message) => settle(message),
    start() {},
    close() {},
  });
  const request = (input: unknown): Promise<any> =>
    new Promise((resolve) => {
      settle = resolve;
      receive({ data: { kind: "req", name: "sources.linkFolders", input, id: "link" } });
    });
  linkFolders.mockClear();
  expect((await request({ paths: [study], mode: "root" })).error.code).toBe("file-access-denied");
  addFileGrants([pickedFileGrant(study)]);
  // A subfolder of a granted folder is allowed, a file is not a folder, and a link inside it cannot reach elsewhere.
  const allowed = await request({ paths: [join(study, "Fisica")], mode: "subject" });
  expect(allowed.ok).toBe(true);
  expect(allowed.value.folders).toEqual([realpathSync(join(study, "Fisica"))]);
  for (const path of [join(study, "orario.txt"), join(study, "shortcut"), "Università"]) {
    const refused = await request({ paths: [path], mode: "subject" });
    expect(refused.error.code, path).toBe("file-access-denied");
  }
  // One refused path refuses the whole request.
  expect((await request({ paths: [study, elsewhere], mode: "subject" })).ok).toBe(false);
  expect((await request({ paths: [], mode: "root" })).ok).toBe(false);
  expect(linkFolders).toHaveBeenCalledTimes(1);
});

it("finds a moved linked folder only at a folder a picker granted, by its real path", async () => {
  const root = mkdtempSync(join(tmpdir(), "pyxis-boundary-"));
  roots.push(root);
  mkdirSync(join(root, "scratch"));
  const found = join(root, "Polito 2026");
  mkdirSync(found);
  const elsewhere = join(root, "elsewhere");
  mkdirSync(elsewhere);
  bindSources(null as never, root, null as never);
  setJobHandlers({} as never);
  let receive: (event: { data: unknown }) => void = () => {};
  let settle: (response: any) => void = () => {};
  attachRendererPort({
    on: (_event, listener) => {
      receive = listener;
    },
    postMessage: (message) => settle(message),
    start() {},
    close() {},
  });
  const request = (path: string): Promise<any> =>
    new Promise((resolve) => {
      settle = resolve;
      receive({ data: { kind: "req", name: "sources.relocateFolder", input: { folderId: "f", path }, id: "find" } });
    });
  relocateFolder.mockClear();
  expect((await request(found)).error.code).toBe("file-access-denied");
  addFileGrants([pickedFileGrant(found)]);
  expect((await request(elsewhere)).error.code).toBe("file-access-denied");
  const allowed = await request(found);
  expect(allowed.ok).toBe(true);
  expect(allowed.value.path).toBe(realpathSync(found));
  expect(relocateFolder).toHaveBeenCalledTimes(1);
});
