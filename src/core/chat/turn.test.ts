import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import type { EngineResult } from "../engine/funnel";
import { importSmartbook } from "../sources/smartbook";
import { strToU8, zipSync } from "fflate";
import { askTurn, readChat } from "./turn";

function pack(files: Record<string, string>): Uint8Array {
  return zipSync(
    Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])),
  );
}

const reply: EngineResult = {
  text: "Il vettore descrive il punto [P1].\n<followups>\nCos'è la posizione?\nE la velocità?\nUn esempio?\n</followups>",
  model: "gpt-6.1-sol",
  provider: "codex",
  inputTokens: 12,
};

describe("askTurn", () => {
  it("answers from a passage and stores the citation", async () => {
    const db = openDatabase(":memory:");
    const imported = importSmartbook(
      db,
      pack({
        "smartbook.json": JSON.stringify({
          id: "demo",
          title: "Demo",
          access: "public",
          chapters: [{ id: "c1", number: 1, title: "Moti", file: "01.md" }],
        }),
        "chapters/01.md": "## p1 | Energia\nIl vettore posizione descrive il punto.\n",
      }),
    );
    const result = await askTurn(db, {
      text: "Che cos'è il vettore?",
      sourceIds: [imported.sourceId],
      run: async () => reply,
    });
    expect(result.covered).toBe(true);
    expect(result.message?.modelId).toBe("gpt-6.1-sol");
    expect(result.message?.followups).toHaveLength(3);
    expect(result.message?.citations).toHaveLength(1);
    expect(result.message?.body).toContain("[P1]");
    const stored = readChat(db, result.chatId);
    expect(stored.at(-1)?.citations[0]?.locator).toEqual({
      chapter: 1,
      paragraph: "p1",
    });
  });

  it("skips the model when the material does not cover the question", async () => {
    const db = openDatabase(":memory:");
    importSmartbook(
      db,
      pack({
        "smartbook.json": JSON.stringify({
          id: "demo",
          title: "Demo",
          access: "public",
          chapters: [{ id: "c1", number: 1, title: "Moti", file: "01.md" }],
        }),
        "chapters/01.md": "## p1 | Energia\nIl vettore posizione descrive il punto.\n",
      }),
    );
    let calls = 0;
    const result = await askTurn(db, {
      text: "fotosintesi delle banane",
      run: async () => {
        calls += 1;
        return reply;
      },
    });
    expect(result.covered).toBe(false);
    expect(calls).toBe(0);
    expect(readChat(db, result.chatId).some((row) => row.role === "assistant")).toBe(false);
  });

  it("answers from general knowledge when asked", async () => {
    const db = openDatabase(":memory:");
    const result = await askTurn(db, {
      text: "fotosintesi delle banane",
      allowGeneral: true,
      run: async () => ({
        ...reply,
        text: "Dalle conoscenze generali: la fotosintesi usa la luce.\n<followups>\nA\nB\nC\n</followups>",
      }),
    });
    expect(result.message?.grounding).toBe("general");
    expect(result.message?.citations).toHaveLength(0);
  });

  it("puts the profile into the tutor prompt", async () => {
    const db = openDatabase(":memory:");
    db.prepare(
      `INSERT INTO profile
        (id, display_name, education_level, course, content_language, created_at, updated_at)
       VALUES ('p', 'Ada', 'university', 'Fisica 1', 'Italian', 1, 1)`,
    ).run();
    let system = "";
    await askTurn(db, {
      text: "ciao",
      allowGeneral: true,
      run: async (input) => {
        system = input.system ?? "";
        return reply;
      },
    });
    expect(system).toContain("Ada");
    expect(system).toContain("Fisica 1");
    expect(system).toContain("Italian");
  });

  it("uses the chat engine selected for that turn", async () => {
    const db = openDatabase(":memory:");
    const seen: string[] = [];
    const run = async (input: { selection: { model: string } }) => {
      seen.push(input.selection.model);
      return { ...reply, model: input.selection.model };
    };
    await askTurn(db, { text: "prima", allowGeneral: true, run });
    db.prepare(
      `INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES ('chat', ?, 1)`,
    ).run(JSON.stringify({ provider: "codex", model: "gpt-6.1-sol" }));
    await askTurn(db, { text: "dopo", allowGeneral: true, run });
    expect(seen).toEqual(["claude-sonnet-4-6", "gpt-6.1-sol"]);
  });

  it("does not store a reply when the turn is aborted", async () => {
    const db = openDatabase(":memory:");
    const controller = new AbortController();
    await expect(
      askTurn(db, {
        text: "vettore",
        allowGeneral: true,
        signal: controller.signal,
        run: () => {
          controller.abort();
          throw new DOMException("aborted", "AbortError");
        },
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    const chats = db.prepare(`SELECT id FROM chats`).all() as Array<{ id: string }>;
    expect(readChat(db, chats[0]?.id ?? "").some((row) => row.role === "assistant")).toBe(
      false,
    );
  });
});
