import { afterEach, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
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
vi.mock("../sources/handlers", () => ({
  sourceHandlers: () => ({ importFile }),
}));
import {
  addFileGrants,
  attachRendererPort,
  bindSources,
  setJobHandlers,
} from "./server";
import { pickedFileGrant } from "./file-grants";

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
});
