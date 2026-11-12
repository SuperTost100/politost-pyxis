import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import type { EngineResult } from "../engine/funnel";
import { pickSubject, type SubjectVote } from "./subject";
import { askTurn, chatSubject, chatSubjectBy, readChat, setChatSubject } from "./turn";

const votes = (spec: Array<[string | null, number, boolean?]>): SubjectVote[] =>
  spec.flatMap(([subject, count, relevant = true]) =>
    Array.from({ length: count }, () => ({ subject, relevant })),
  );

describe("the subject Pyxis picks from a search", () => {
  it("picks the subject that holds a clear majority of the relevant passages", () => {
    expect(pickSubject(votes([["Fisica 2", 5], ["Analisi 1", 1]]))).toBe("Fisica 2");
    // Two thirds is enough, so 4 against 2 picks.
    expect(pickSubject(votes([["Fisica 2", 4], ["Analisi 1", 2]]))).toBe("Fisica 2");
  });

  it("picks nothing when two subjects are close together", () => {
    expect(pickSubject(votes([["Fisica 2", 3], ["Analisi 1", 2]]))).toBeNull();
    expect(pickSubject(votes([["Fisica 2", 2], ["Analisi 1", 2]]))).toBeNull();
  });

  it("picks nothing when no passage passed the relevance bar, whatever subject the rest belong to", () => {
    expect(pickSubject([])).toBeNull();
    expect(pickSubject(votes([["Fisica 2", 8, false]]))).toBeNull();
    // Passages under the bar do not count towards the share either.
    expect(pickSubject(votes([["Fisica 2", 2], ["Analisi 1", 6, false]]))).toBe("Fisica 2");
  });

  it("picks the only subject of a Library once two passages are relevant, not on one", () => {
    expect(pickSubject(votes([["Fisica 2", 2]]))).toBe("Fisica 2");
    expect(pickSubject(votes([["Fisica 2", 1]]))).toBeNull();
  });

  it("counts files without a subject in the total, so they can keep a subject from the majority", () => {
    expect(pickSubject(votes([[null, 4]]))).toBeNull();
    expect(pickSubject(votes([["Fisica 2", 2], [null, 2]]))).toBeNull();
    expect(pickSubject(votes([["Fisica 2", 4], [null, 1]]))).toBe("Fisica 2");
  });
});

type File = { id: string; subject: string | null; texts: string[]; library?: boolean };

/** A workspace with an engine and the given Library files, each with its passages and, when it has one, its subject. */
function library(files: File[]): Database.Database {
  const db = openDatabase(":memory:");
  db.prepare("INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES ('default', ?, 1)").run(
    JSON.stringify({ provider: "claude", model: "claude-sonnet-5" }),
  );
  const subjects = new Map<string, string>();
  for (const file of files) {
    if (file.subject && !subjects.has(file.subject)) {
      const id = `s-${subjects.size + 1}`;
      subjects.set(file.subject, id);
      db.prepare("INSERT INTO subjects (id, name, created_at) VALUES (?, ?, 1)").run(id, file.subject);
    }
    db.prepare(
      "INSERT INTO sources (id, subject_id, kind, title, status, library, created_at, updated_at) VALUES (?, ?, 'text', ?, 'ready', ?, 1, 1)",
    ).run(file.id, file.subject ? subjects.get(file.subject) : null, `File ${file.id}`, file.library === false ? 0 : 1);
    db.prepare("INSERT INTO source_documents (id, source_id, version, tree_json, created_at) VALUES (?, ?, 1, '{}', 1)").run(
      `d-${file.id}`,
      file.id,
    );
    file.texts.forEach((text, index) =>
      db
        .prepare(
          "INSERT INTO passages (id, source_id, document_id, text, section_path, created_at) VALUES (?, ?, ?, ?, ?, 1)",
        )
        .run(`${file.id}-p${index}`, file.id, `d-${file.id}`, text, `§${index + 1}`),
    );
  }
  return db;
}

const physics = [
  "Il campo elettrico di un filo carico si trova con il teorema di Gauss su un cilindro.",
  "Per un filo carico infinito il campo elettrico è radiale e decresce come 1/r.",
  "Il flusso del campo elettrico attraverso il cilindro attorno al filo carico.",
];
const calculus = [
  "Il limite notevole di sin x su x vale uno quando x tende a zero.",
  "Una serie geometrica converge quando la ragione è minore di uno.",
  "La derivata della funzione composta segue la regola della catena.",
];
const filler = ["La fotosintesi avviene nelle foglie.", "Il Rinascimento nasce a Firenze.", "Le maree dipendono dalla Luna."];

/** Asks in the chat, answering with a reply that cites the first passage, and returns what the model was sent. */
async function ask(db: Database.Database, text: string, chatId?: string, fail = false) {
  let prompt = "";
  const result = await askTurn(db, {
    chatId,
    text,
    embed: null,
    python: null,
    run: async (call): Promise<EngineResult> => {
      prompt = call.prompt;
      if (fail) throw new Error("network down");
      return { text: "Ecco [P1].", model: "m", provider: "claude", inputTokens: 1 };
    },
  });
  return { chatId: result.chatId, prompt, reply: readChat(db, result.chatId).at(-1)! };
}

describe("a chat's subject", () => {
  it("is picked from the whole Library on the first question, and the reply names the subject it used", async () => {
    const db = library([
      { id: "fis", subject: "Fisica 2", texts: physics },
      { id: "an", subject: "Analisi 1", texts: calculus },
      { id: "other", subject: "Storia", texts: filler },
    ]);
    const first = await ask(db, "Campo elettrico di un filo carico");
    expect(chatSubject(db, first.chatId)).toBe("Fisica 2");
    expect(chatSubjectBy(db, first.chatId)).toBe("pyxis");
    expect(first.reply.grounding).toBe("sources");
    expect(first.reply.citations[0]).toMatchObject({ subject: "Fisica 2", sourceTitle: "File fis", attached: false });
    db.close();
  });

  it("stays unset when the passages are spread over two subjects or nothing is relevant, and the reply says it is general", async () => {
    const db = library([
      { id: "fis", subject: "Fisica 2", texts: ["Il limite di una funzione in fisica.", "Il limite e la velocità istantanea."] },
      { id: "an", subject: "Analisi 1", texts: ["Il limite di una funzione in analisi.", "Il limite notevole di una funzione."] },
      { id: "other", subject: "Storia", texts: filler },
    ]);
    const spread = await ask(db, "Limite di una funzione");
    expect(chatSubject(db, spread.chatId)).toBeNull();
    expect(chatSubjectBy(db, spread.chatId)).toBeNull();
    const nothing = await ask(db, "Ricetta della carbonara");
    expect(chatSubject(db, nothing.chatId)).toBeNull();
    expect(nothing.reply.grounding).toBe("general");
    db.close();
  });

  it("is picked in a Library with one subject, and not from files without a subject", async () => {
    const one = library([{ id: "fis", subject: "Fisica 2", texts: [...physics, ...filler] }]);
    expect(chatSubject(one, (await ask(one, "Campo elettrico di un filo carico")).chatId)).toBe("Fisica 2");
    one.close();
    const loose = library([
      { id: "loose", subject: null, texts: physics },
      { id: "other", subject: "Storia", texts: filler },
    ]);
    const asked = await ask(loose, "Campo elettrico di un filo carico");
    expect(chatSubject(loose, asked.chatId)).toBeNull();
    expect(asked.reply.citations[0]?.subject).toBeNull();
    loose.close();
  });

  it("is searched first on later questions, which widen to the Library and say so when it has nothing", async () => {
    const db = library([
      { id: "fis", subject: "Fisica 2", texts: physics },
      { id: "an", subject: "Analisi 1", texts: calculus },
      { id: "other", subject: "Storia", texts: filler },
    ]);
    const first = await ask(db, "Campo elettrico di un filo carico");
    const inside = await ask(db, "Teorema di Gauss sul cilindro", first.chatId);
    expect(inside.prompt).toContain("Gauss");
    expect(inside.prompt).not.toContain("serie geometrica");
    expect(inside.reply.grounding).toBe("sources");
    const outside = await ask(db, "Serie geometrica che converge", first.chatId);
    expect(outside.prompt).toContain("serie geometrica");
    expect(outside.reply.grounding).toBe("wider");
    expect(outside.reply.citations[0]?.subject).toBe("Analisi 1");
    // Looking wider does not move the chat to the other subject.
    expect(chatSubject(db, first.chatId)).toBe("Fisica 2");
    db.close();
  });

  it("set by the student sticks, the whole Library included, and a failed turn changes nothing", async () => {
    const db = library([
      { id: "fis", subject: "Fisica 2", texts: physics },
      { id: "an", subject: "Analisi 1", texts: calculus },
      { id: "other", subject: "Storia", texts: filler },
    ]);
    const failed = await ask(db, "Campo elettrico di un filo carico", undefined, true).catch(() => null);
    expect(failed).toBeNull();
    const first = await ask(db, "Campo elettrico di un filo carico");
    setChatSubject(db, first.chatId, "Analisi 1");
    expect(chatSubjectBy(db, first.chatId)).toBe("student");
    await ask(db, "Campo elettrico di un filo carico", first.chatId);
    expect(chatSubject(db, first.chatId)).toBe("Analisi 1");
    setChatSubject(db, first.chatId, null);
    const whole = await ask(db, "Campo elettrico di un filo carico", first.chatId);
    expect(chatSubject(db, first.chatId)).toBeNull();
    expect(chatSubjectBy(db, first.chatId)).toBe("student");
    expect(whole.reply.grounding).toBe("sources");
    // A turn that fails leaves a chat without a subject as it was.
    const empty = await ask(db, "Ricetta della carbonara");
    await ask(db, "Campo elettrico di un filo carico", empty.chatId, true).catch(() => undefined);
    expect(chatSubject(db, empty.chatId)).toBeNull();
    expect(chatSubjectBy(db, empty.chatId)).toBeNull();
    db.close();
  });

  it("chosen on a new chat's first page goes with the first question, and an older chat's subject counts as the student's", async () => {
    const db = library([
      { id: "fis", subject: "Fisica 2", texts: physics },
      { id: "an", subject: "Analisi 1", texts: calculus },
    ]);
    const result = await askTurn(db, {
      text: "Campo elettrico di un filo carico",
      subject: "Analisi 1",
      embed: null,
      python: null,
      run: async () => ({ text: "Ecco.", model: "m", provider: "claude", inputTokens: 1 }),
    });
    expect(chatSubject(db, result.chatId)).toBe("Analisi 1");
    expect(chatSubjectBy(db, result.chatId)).toBe("student");
    db.prepare("INSERT INTO chats (id, title, scope_json, subject, created_at, updated_at) VALUES ('old', 'Vecchia', '[]', 'Fisica 2', 1, 1)").run();
    expect(chatSubjectBy(db, "old")).toBe("student");
    db.close();
  });

  it("set from the chip replaces sources an older chat picked by hand, and keeps its attachments", async () => {
    const db = library([
      { id: "fis", subject: "Fisica 2", texts: physics },
      { id: "an", subject: "Analisi 1", texts: calculus },
      { id: "att", subject: null, texts: ["Il mio esercizio sul filo carico."], library: false },
    ]);
    db.prepare(
      `INSERT INTO chats (id, title, scope_json, created_at, updated_at) VALUES ('old', 'Vecchia', '["an","att"]', 1, 1)`,
    ).run();
    // Picked by hand: the chat keeps answering from those sources and Pyxis picks nothing.
    const picked = await ask(db, "Campo elettrico di un filo carico", "old");
    expect(picked.prompt).not.toContain("teorema di Gauss");
    expect(chatSubject(db, "old")).toBeNull();
    setChatSubject(db, "old", "Fisica 2");
    const read = db.prepare("SELECT scope_json FROM chats WHERE id = 'old'").get() as { scope_json: string };
    expect(JSON.parse(read.scope_json)).toEqual({ sourceIds: ["att"], subjectBy: "student" });
    expect((await ask(db, "Campo elettrico di un filo carico", "old")).prompt).toContain("teorema di Gauss");
    db.close();
  });
});
