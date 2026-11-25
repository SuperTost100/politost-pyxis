import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { PNG } from "pngjs";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { clearBench } from "../engine/bench";
import type { EngineResult } from "../engine/funnel";
import { rememberReady } from "../engine/selection";
import { tempDir } from "../test-temp";
import { currentSession, sessionsOpened } from "./sessions";
import { heldFilesFor } from "./test-attach";
import { askTurn, regenerateTurn } from "./turn";

afterEach(() => {
  rememberReady([]);
  clearBench();
});

const base: EngineResult = { text: "Ecco la risposta.", model: "claude-sonnet-5-5", provider: "claude", inputTokens: 1 };

type Seen = {
  prompt: string;
  selection: { provider: string; model: string };
  attachments?: unknown[];
  conversation?: { followUp: string; session?: { provider: string; id: string } | null };
  /** Pyxis's tools, which every chat turn offers. */
  tools?: unknown;
};

/**
 * An answer of the tool in the chat's session: it names the session, says whether it continued the stored one, and
 * reports the run's tools as a CLI that takes them does.
 */
const inSession = (input: Seen, model = "claude-sonnet-5-5"): EngineResult => ({
  ...base,
  model,
  sessionId: "s1",
  cwd: "/scratch",
  continued: input.conversation?.session?.id === "s1",
  ...(input.tools ? { tools: true } : {}),
});
const down = async (): Promise<EngineResult> => {
  throw new Error("engine-down");
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

/** A chat on Claude whose own model cannot read images, with one image model of the same tool signed in. */
function setup(chat: object) {
  const workspace = tempDir("pyxis-files-session-");
  const db = openDatabase(":memory:");
  const engine = (feature: string, selection: object) =>
    db.prepare(`INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES (?, ?, 1)`).run(feature, JSON.stringify(selection));
  engine("default", chat);
  engine("chat", chat);
  rememberReady([
    { id: "claude", kind: "cli", effort: false, models: ["text-only-small", "claude-sonnet-5-5"].map((id) => ({ id, efforts: [] })) },
  ]);
  const write = (name: string, content: string | Uint8Array) => {
    const path = join(workspace, name);
    writeFileSync(path, content);
    return path;
  };
  const files = heldFilesFor(db, workspace);
  const attached = async (...paths: string[]) => ({ attachments: (await files.attach(...paths)).ids, held: files.held });
  const photo = write("foto.png", PNG.sync.write(new PNG({ width: 1, height: 1 })));
  return { db, workspace, write, attached, files, photo };
}

/** The first turn of a chat: it opens the session `s1`, which stays in step. */
async function opened(t: ReturnType<typeof setup>) {
  const first = await askTurn(t.db, { text: "ciao", allowGeneral: true, workspace: t.workspace, run: async (input) => inSession(input as Seen, "text-only-small") });
  await tick();
  expect(currentSession(t.db, first.chatId)).toMatchObject({ sessionId: "s1", inStep: true });
  return first.chatId;
}

describe("files on a session that continues", () => {
  it("send the passages of an attached document with the follow-up, not only on a fresh session", async () => {
    const t = setup({ provider: "claude", model: "text-only-small" });
    const chatId = await opened(t);
    let seen: Seen | undefined;
    await askTurn(t.db, {
      chatId,
      text: "riassumi gli appunti",
      allowGeneral: true,
      ...(await t.attached(t.write("appunti.txt", "Il calore si trasmette per conduzione."))),
      workspace: t.workspace,
      run: async (input) => {
        seen = input as Seen;
        return inSession(seen, "text-only-small");
      },
    });
    expect(seen!.conversation!.session).toMatchObject({ id: "s1" });
    expect(seen!.conversation!.followUp).toContain("Il calore si trasmette per conduzione.");
    expect(seen!.conversation!.followUp).not.toContain("Earlier turns:");
    expect(seen!.conversation!.followUp.endsWith("Question:\nriassumi gli appunti")).toBe(true);
    expect(sessionsOpened(t.db, chatId)).toBe(1);
    t.db.close();
  });

  it("send the text OCR read from a photo with the follow-up when no tool can see it, for a pinned chat too", async () => {
    // The chat's model is pinned (no `auto`): a pin never moves for a photo, so local OCR reads it.
    const t = setup({ provider: "claude", model: "text-only-small" });
    const chatId = await opened(t);
    let seen: Seen | undefined;
    await askTurn(t.db, {
      chatId,
      text: "cosa c'è scritto",
      allowGeneral: true,
      ...(await t.attached(t.photo)),
      workspace: t.workspace,
      recognize: async () => "Esercizio 2. Determinare il dominio",
      run: async (input) => {
        seen = input as Seen;
        return inSession(seen, "text-only-small");
      },
    });
    expect(seen!.selection).toMatchObject({ provider: "claude", model: "text-only-small" });
    expect(seen!.attachments ?? []).toHaveLength(0);
    expect(seen!.conversation!.session).toMatchObject({ id: "s1" });
    expect(seen!.conversation!.followUp).toContain("Esercizio 2. Determinare il dominio");
    expect(sessionsOpened(t.db, chatId)).toBe(1);
    t.db.close();
  });

  it("send the photo itself to the image model an automatic chat moves to, in the same session, and the next question stays on it", async () => {
    const t = setup({ provider: "claude", model: "text-only-small", auto: true });
    const chatId = await opened(t);
    const ran: Array<{ model: string; images: number; session?: string }> = [];
    const run = async (input: Seen) => {
      ran.push({ model: input.selection.model, images: input.attachments?.length ?? 0, session: input.conversation?.session?.id });
      return inSession(input, input.selection.model);
    };
    await askTurn(t.db, {
      chatId,
      text: "cosa c'è scritto",
      allowGeneral: true,
      ...(await t.attached(t.photo)),
      workspace: t.workspace,
      run: run as never,
    });
    await tick();
    expect(currentSession(t.db, chatId)).toMatchObject({ sessionId: "s1", inStep: true });
    // A question with no photo stays on the image model, in the same session: the session holds the image.
    await askTurn(t.db, { chatId, text: "e il secondo esercizio?", allowGeneral: true, workspace: t.workspace, run: run as never });
    expect(ran).toEqual([
      { model: "claude-sonnet-5-5", images: 1, session: "s1" },
      { model: "claude-sonnet-5-5", images: 1, session: "s1" },
    ]);
    expect(sessionsOpened(t.db, chatId)).toBe(1);
    t.db.close();
  });
});

describe("a failed send with files, then Try again", () => {
  it("replays the stored question with its document on the session, and lets the files go", async () => {
    const t = setup({ provider: "claude", model: "text-only-small" });
    const chatId = await opened(t);
    const sent = await t.attached(t.write("appunti.txt", "Il calore si trasmette per conduzione."));
    await expect(askTurn(t.db, { chatId, text: "spiega gli appunti", allowGeneral: true, ...sent, workspace: t.workspace, run: down })).rejects.toThrow("engine-down");
    await tick();
    // The failed turn left the session out of step, and the files stay held for the retry.
    expect(currentSession(t.db, chatId)).toMatchObject({ sessionId: "s1", inStep: false });
    expect(sent.held.list(sent.attachments)).toHaveLength(1);
    let seen: Seen | undefined;
    await regenerateTurn(t.db, {
      chatId,
      allowGeneral: true,
      workspace: t.workspace,
      held: sent.held,
      run: async (input) => {
        seen = input as Seen;
        return inSession(seen, "text-only-small");
      },
    });
    // The session is told again what it needs: the context block and the question with its document's passages.
    expect(seen!.conversation!.session).toMatchObject({ id: "s1" });
    expect(seen!.conversation!.followUp).toContain("Il calore si trasmette per conduzione.");
    expect(seen!.conversation!.followUp.endsWith("Question:\nspiega gli appunti")).toBe(true);
    expect(currentSession(t.db, chatId)).toMatchObject({ sessionId: "s1", inStep: true });
    expect(sent.held.list(sent.attachments)).toEqual([]);
    expect(t.db.prepare(`SELECT COUNT(*) FROM held_files`).pluck().get()).toBe(0);
    expect(sessionsOpened(t.db, chatId)).toBe(1);
    t.db.close();
  });

  it("replays a photo's text the same way for a photo read by OCR", async () => {
    const t = setup({ provider: "claude", model: "text-only-small" });
    const chatId = await opened(t);
    const sent = await t.attached(t.photo);
    await expect(
      askTurn(t.db, { chatId, text: "cosa c'è scritto", allowGeneral: true, ...sent, workspace: t.workspace, recognize: async () => "Esercizio 2", run: down }),
    ).rejects.toThrow("engine-down");
    await tick();
    let seen: Seen | undefined;
    await regenerateTurn(t.db, {
      chatId,
      allowGeneral: true,
      workspace: t.workspace,
      held: sent.held,
      run: async (input) => {
        seen = input as Seen;
        return inSession(seen, "text-only-small");
      },
    });
    expect(seen!.conversation!.followUp).toContain("Esercizio 2");
    expect(sent.held.list(sent.attachments)).toEqual([]);
    t.db.close();
  });
});
