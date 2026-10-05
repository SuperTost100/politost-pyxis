import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { afterEach, expect, it, vi } from "vitest";
import { putBlob } from "../blobs";
import { openDatabase } from "../db/connection";
import type { EngineResult } from "../engine/funnel";
import * as attach from "./attach";
import { askTurn } from "./turn";

// Calls through to the real fitting, and lets a test see what the turn handed it.
vi.mock("./attach", async (original) => {
  const actual = await original<typeof import("./attach")>();
  return { ...actual, savedImages: vi.fn(actual.savedImages) };
});
const fitted = vi.mocked(attach.savedImages);

const dirs: string[] = [];
afterEach(() => {
  fitted.mockClear();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const reply: EngineResult = { text: "Ecco la risposta.", model: "claude-sonnet-5", provider: "claude", inputTokens: 1 };

function chatWithPhotos() {
  const workspace = mkdtempSync(join(tmpdir(), "pyxis-turn-images-"));
  dirs.push(workspace);
  const db = openDatabase(":memory:");
  db.prepare("INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES ('default', ?, 1)").run(
    JSON.stringify({ provider: "claude", model: "claude-sonnet-5" }),
  );
  db.prepare("INSERT INTO chats (id, title, created_at, updated_at) VALUES ('c', 't', 1, 1)").run();
  db.prepare("INSERT INTO messages (id, chat_id, role, body, created_at) VALUES ('m', 'c', 'user', 'prima', 1)").run();
  const png = PNG.sync.write(new PNG({ width: 4, height: 4 }));
  const attach = db.prepare("INSERT INTO attachments (id, message_id, blob_sha, mime, created_at) VALUES (?, 'm', ?, 'image/png', ?)");
  return { workspace, db, png, attach, good: () => putBlob(workspace, png, "image/png", ".png") };
}

it("SRC-04 tells the student when a saved photo could not be sent, and still answers with the rest", async () => {
  const { workspace, db, png, attach, good } = chatWithPhotos();
  attach.run("good", good(), 20);
  // A row whose blob is gone: the photo cannot be read, and the answer must not pretend it saw it.
  attach.run("gone", "0".repeat(64), 10);
  let sent: unknown[] = [];
  const result = await askTurn(db, {
    chatId: "c",
    text: "cosa vedi?",
    allowGeneral: true,
    workspace,
    run: async (input) => {
      sent = input.attachments ?? [];
      return reply;
    },
  });
  expect(sent).toEqual([{ type: "image", mediaType: "image/png", data: Buffer.from(png).toString("base64") }]);
  expect(result.message?.body).toBe("Ecco la risposta.");
  expect(result.skippedImages).toEqual(["unreadable"]);
  db.close();
});

it("says nothing about photos when every one was sent", async () => {
  const { workspace, db, attach, good } = chatWithPhotos();
  attach.run("good", good(), 20);
  const result = await askTurn(db, {
    chatId: "c",
    text: "cosa vedi?",
    allowGeneral: true,
    workspace,
    run: async () => reply,
  });
  expect(result.skippedImages).toBeUndefined();
  db.close();
});

it("hands the turn's cancellation signal to the fitting of saved photos, so cancelling stops the worker", async () => {
  const { workspace, db, attach, good } = chatWithPhotos();
  attach.run("good", good(), 20);
  const controller = new AbortController();
  await askTurn(db, {
    chatId: "c",
    text: "cosa vedi?",
    allowGeneral: true,
    workspace,
    signal: controller.signal,
    run: async () => reply,
  });
  expect(fitted).toHaveBeenCalledTimes(1);
  expect(fitted.mock.calls[0]![3]).toBe(controller.signal);
  db.close();
});

it("records a photo once on a message whose turn is retried, so a retry cannot fill the four-photo budget with copies", async () => {
  const { workspace, db, png } = chatWithPhotos();
  const file = join(workspace, "board.png");
  writeFileSync(file, png);
  const ask = (run: (input: { attachments?: unknown[] }) => Promise<EngineResult>) =>
    askTurn(db, { chatId: "c", text: "cosa vedi?", allowGeneral: true, files: [file], workspace, run });
  await expect(ask(async () => Promise.reject(new Error("engine down")))).rejects.toThrow("engine down");
  let sent: unknown[] = [];
  await ask(async (input) => {
    sent = input.attachments ?? [];
    return reply;
  });
  expect(db.prepare("SELECT COUNT(*) AS n FROM attachments WHERE message_id != 'm'").get()).toEqual({ n: 1 });
  expect(sent).toHaveLength(1);
  db.close();
});
