import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { foldText, MAX_HITS, searchChats as search } from "./search";

const searchChats = (...args: Parameters<typeof search>) => search(...args).hits;

function setup() {
  const db = openDatabase(":memory:");
  const chat = (id: string, title: string | null, at: number) =>
    db
      .prepare(
        `INSERT INTO chats (id, title, scope_json, created_at, updated_at) VALUES (?, ?, '[]', ?, ?)`,
      )
      .run(id, title, at, at);
  let tick = 0;
  const message = (chatId: string, role: string, body: string) =>
    db
      .prepare(
        `INSERT INTO messages (id, chat_id, role, body, created_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(`m${(tick += 1)}`, chatId, role, body, tick);
  return { db, chat, message };
}

describe("foldText", () => {
  it("lowercases and removes accents", () => {
    expect(foldText("PERCHÉ è così, Ça va?")).toBe("perche e cosi, ca va?");
  });
});

describe("searchChats", () => {
  it("finds an accented word from its plain spelling, in any case", () => {
    const { db, chat, message } = setup();
    chat("a", "Termodinamica", 2);
    message("a", "user", "Perché il calore passa dal caldo al freddo?");
    chat("b", "Analisi", 1);
    message("b", "user", "Calcolo un limite");
    expect(searchChats(db, "perche").map((hit) => hit.id)).toEqual(["a"]);
    expect(searchChats(db, "PERCHÉ").map((hit) => hit.id)).toEqual(["a"]);
    expect(searchChats(db, "perché")[0]?.snippet?.text).toContain("Perché");
  });

  it("matches the other way round: an accented query finds an unaccented text", () => {
    const { db, chat, message } = setup();
    chat("a", "x", 1);
    message("a", "assistant", "La funzione e continua");
    expect(searchChats(db, "è").map((hit) => hit.id)).toEqual(["a"]);
  });

  it("matches a title without a snippet, and prefers the title over a message", () => {
    const { db, chat, message } = setup();
    chat("a", "Seconda legge di Newton", 1);
    message("a", "user", "Che cos'è la legge di Newton?");
    const [hit] = searchChats(db, "newton");
    expect(hit).toMatchObject({
      id: "a",
      title: "Seconda legge di Newton",
      snippet: null,
    });
  });

  it("returns a snippet that marks the match in a message", () => {
    const { db, chat, message } = setup();
    chat("a", "Chat", 1);
    message(
      "a",
      "user",
      `${"parole ".repeat(30)}Entropia ${"altre ".repeat(30)}`,
    );
    const [hit] = searchChats(db, "entropia");
    const snippet = hit!.snippet!;
    expect(snippet.text.startsWith("…")).toBe(true);
    expect(snippet.text.endsWith("…")).toBe(true);
    expect(snippet.text.length).toBeLessThan(130);
    expect(snippet.text.slice(snippet.start, snippet.end)).toBe("Entropia");
  });

  it("does not search the stored followups, checks, check fences or citation markers", () => {
    const { db, chat, message } = setup();
    chat("a", "Chat", 1);
    message(
      "a",
      "assistant",
      [
        "Usa la conservazione [P1] dell'energia.",
        "```check",
        '{"step":"segretocheck","claim":"x"}',
        "```",
        "<followups>",
        "Spiegami il suggerimento nascosto",
        "</followups>",
        '<checks>[{"step":"marcatorechecks"}]</checks>',
      ].join("\n"),
    );
    expect(searchChats(db, "nascosto")).toEqual([]);
    expect(searchChats(db, "marcatorechecks")).toEqual([]);
    expect(searchChats(db, "followups")).toEqual([]);
    expect(searchChats(db, "[P1]")).toEqual([]);
    expect(searchChats(db, "P1")).toEqual([]);
    expect(searchChats(db, "conservazione").map((hit) => hit.id)).toEqual([
      "a",
    ]);
  });

  it("needs every word of the query in the same text, in any order", () => {
    const { db, chat, message } = setup();
    chat("a", "Chat", 1);
    message("a", "user", "Il lavoro di una forza conservativa");
    expect(searchChats(db, "forza lavoro")).toHaveLength(1);
    expect(searchChats(db, "forza entropia")).toEqual([]);
  });

  it("returns nothing for an empty or blank query and orders newest first", () => {
    const { db, chat, message } = setup();
    chat("old", "Vecchia", 1);
    message("old", "user", "limite");
    chat("new", "Nuova", 5);
    message("new", "user", "limite");
    expect(searchChats(db, "")).toEqual([]);
    expect(searchChats(db, "   ")).toEqual([]);
    expect(searchChats(db, "limite").map((hit) => hit.id)).toEqual([
      "new",
      "old",
    ]);
  });

  it("handles an untitled chat", () => {
    const { db, chat, message } = setup();
    chat("a", null, 1);
    message("a", "user", "fotosintesi");
    expect(searchChats(db, "fotosintesi")[0]).toMatchObject({ title: null });
  });
});

describe("searchChats limits", () => {
  it("says when the list was cut at the cap, and not when it fits exactly", () => {
    const { db, chat, message } = setup();
    for (let i = 0; i < MAX_HITS; i += 1) {
      chat(`c${i}`, null, i + 1);
      message(`c${i}`, "user", "entropia");
    }
    const exact = search(db, "entropia");
    expect(exact.hits).toHaveLength(MAX_HITS);
    expect(exact.capped).toBe(false);
    chat("more", null, 0);
    message("more", "user", "entropia");
    const cut = search(db, "entropia");
    expect(cut.hits).toHaveLength(MAX_HITS);
    expect(cut.hits.some((hit) => hit.id === "more")).toBe(false);
    expect(cut.capped).toBe(true);
    expect(search(db, "   ")).toEqual({ hits: [], capped: false });
  });

  it("folds a message again once it grows, as a continued reply does", () => {
    const { db, chat, message } = setup();
    chat("c", null, 1);
    message("c", "assistant", "La entropia cresce.");
    expect(searchChats(db, "termodinamica")).toEqual([]);
    db.prepare(`UPDATE messages SET body = body || ' Secondo principio della termodinamica.'`).run();
    expect(searchChats(db, "termodinamica")).toEqual([
      expect.objectContaining({ id: "c", snippet: expect.objectContaining({ text: expect.stringContaining("termodinamica") }) }),
    ]);
  });

  it("caps within the subject asked for, so older chats in it are not cut by newer ones elsewhere", () => {
    const { db, chat, message } = setup();
    for (let i = 0; i < MAX_HITS + 5; i += 1) {
      chat(`an${i}`, null, 100 + i);
      message(`an${i}`, "user", "derivata");
    }
    chat("fis", null, 1);
    message("fis", "user", "derivata");
    db.prepare(`UPDATE chats SET subject = 'Analisi' WHERE id LIKE 'an%'`).run();
    db.prepare(`UPDATE chats SET subject = 'Fisica' WHERE id = 'fis'`).run();
    expect(search(db, "derivata").capped).toBe(true);
    expect(search(db, "derivata", "Fisica")).toEqual({
      hits: [expect.objectContaining({ id: "fis" })],
      capped: false,
    });
  });
});
