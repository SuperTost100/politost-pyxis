import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import type { GenerateInput } from "../engine/generate";
import { templateVersion } from "../engine/prompts";
import { createCard, deckDueCards, dueCards } from "./cards";
import { newCardPlaces, proposeSubjectCards } from "./cardsForSubject";
import { saveProposedCards } from "./cardsFromText";

/** Two subjects: Fisica 1 with an exam, a topic and a book; Chimica with nothing but its name. */
function fixture(engine = true) {
  const db = openDatabase(":memory:");
  if (engine)
    db.prepare("INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES ('default', ?, 1)").run(
      JSON.stringify({ provider: "claude", model: "claude-sonnet-5" }),
    );
  db.exec(`
    INSERT INTO subjects(id,name,position,created_at) VALUES('phys','Fisica 1',0,1),('chem','Chimica',1,1);
    INSERT INTO plans(id,subject_id,title,status,created_at,updated_at) VALUES
      ('mech','phys','Appello di gennaio','ready',1,2),('old','phys','Appello vecchio','ready',1,1);
    UPDATE plans SET archived_at = 5 WHERE id = 'old';
    INSERT INTO topics(id,plan_id,title,position,created_at) VALUES('kin','mech','Cinematica',0,1),('dyn','mech','Dinamica',1,1);
    INSERT INTO sources(id,subject_id,kind,title,status,library,created_at,updated_at) VALUES
      ('book','phys','pdf','Mazzoldi','ready',1,1,1);
    INSERT INTO source_documents(id,source_id,version,tree_json,created_at) VALUES('doc','book',1,'{}',1);
  `);
  const passages = {
    p1: "La velocità è lo spostamento di un corpo nell'unità di tempo.",
    p2: "L'accelerazione è la rapidità con cui cambia la velocità.",
    p3: "Il secondo principio della dinamica dice che la forza è uguale alla massa per l'accelerazione.",
  };
  Object.entries(passages).forEach(([id, text], i) =>
    db
      .prepare(
        "INSERT INTO passages(id,source_id,document_id,text,section_path,created_at) VALUES(?,'book','doc',?,'Capitolo 1',?)",
      )
      .run(id, text, i + 1),
  );
  db.exec("INSERT INTO topic_passages(topic_id,passage_id) VALUES('kin','p1'),('kin','p2'),('dyn','p3')");
  return db;
}

type Request = {
  subject: string;
  topic?: string;
  focus?: string;
  count: number;
  avoid: string[];
  passages: Array<{ id: string; text: string; section: string }>;
};

/** A recorded reply, and the requests it was asked. */
function recorded(cards: unknown[] | Error) {
  const seen: Array<{ system?: string; request: Request }> = [];
  const run: GenerateInput["run"] = async (input) => {
    seen.push({ system: input.system, request: JSON.parse(input.prompt) as Request });
    if (cards instanceof Error) throw cards;
    const structured = { cards };
    return { structured, text: JSON.stringify(structured), provider: "claude", model: "test-model", inputTokens: 1 };
  };
  return { seen, run };
}

const count = (db: ReturnType<typeof fixture>) => db.prepare("SELECT COUNT(*) FROM cards").pluck().get() as number;

describe("createCard", () => {
  it("files a card under its subject, and under one of the subject's exams with no topic when one is chosen", () => {
    const db = fixture();
    const loose = createCard(db, { subjectId: "chem", front: " Numero atomico? ", back: "I protoni nel nucleo." });
    const filed = createCard(db, { subjectId: "phys", planId: "mech", front: "Velocità?", back: "Spazio su tempo." });
    const rows = db.prepare("SELECT id, subject_id, plan_id, topic_id, front FROM cards ORDER BY front").all();
    expect(rows).toEqual([
      { id: loose.id, subject_id: "chem", plan_id: null, topic_id: null, front: "Numero atomico?" },
      { id: filed.id, subject_id: "phys", plan_id: "mech", topic_id: null, front: "Velocità?" },
    ]);
    // A new card is due at once, as any other.
    expect(dueCards(db, "mech", Date.now()).map((card) => card.id)).toContain(filed.id);
    expect(deckDueCards(db, { subjectId: "chem" }, Date.now()).map((card) => card.id)).toEqual([loose.id]);
  });

  it("needs a subject, an exam of that subject and both faces", () => {
    const db = fixture();
    expect(() => createCard(db, { subjectId: "nope", front: "a", back: "b" })).toThrow("subject-missing");
    expect(() => createCard(db, { subjectId: "chem", planId: "mech", front: "a", back: "b" })).toThrow(
      "plan-not-in-subject",
    );
    expect(() => createCard(db, { subjectId: "phys", front: "  ", back: "b" })).toThrow("card-blank");
    expect(() => createCard(db, { subjectId: "phys", front: "a", back: "\n" })).toThrow("card-blank");
    expect(count(db)).toBe(0);
  });

  it("refuses an archived exam of the subject, which the dialog never offers", () => {
    const db = fixture();
    expect(() => createCard(db, { subjectId: "phys", planId: "old", front: "a", back: "b" })).toThrow("plan-archived");
    expect(count(db)).toBe(0);
  });
});

describe("newCardPlaces", () => {
  it("lists each subject's exams, its topics by exam and its readable sources, and whether an AI tool is set up", () => {
    expect(newCardPlaces(fixture())).toEqual({
      subjects: [
        {
          id: "phys",
          name: "Fisica 1",
          exams: [{ id: "mech", title: "Appello di gennaio" }],
          topics: [
            {
              planId: "mech",
              planTitle: "Appello di gennaio",
              topics: [
                { id: "kin", title: "Cinematica" },
                { id: "dyn", title: "Dinamica" },
              ],
            },
          ],
          sources: 1,
        },
        { id: "chem", name: "Chimica", exams: [], topics: [], sources: 0 },
      ],
      engine: true,
    });
    expect(newCardPlaces(fixture(false)).engine).toBe(false);
  });
});

describe("proposeSubjectCards", () => {
  const card = (front: string, passageId: string) => ({ kind: "qa", front, back: `Risposta a ${front}`, passageId });

  it("asks for the subject's cards with its topic, the focus and the count, from that material only", async () => {
    const db = fixture();
    createCard(db, { subjectId: "phys", front: "Che cos'è la velocità?", back: "Spazio su tempo." });
    const { seen, run } = recorded([card("Che cos'è l'accelerazione?", "p2")]);
    const result = await proposeSubjectCards(
      db,
      { subjectId: "phys", planId: "mech", topicId: "kin", focus: " accelerazione ", count: 5 },
      run,
    );
    expect(seen).toHaveLength(1);
    const request = seen[0]!.request;
    expect(request).toMatchObject({ subject: "Fisica 1", topic: "Cinematica", focus: "accelerazione", count: 5 });
    expect(request.avoid).toEqual(["Che cos'è la velocità?"]);
    // The topic's passages that match the focus, not the other topic's.
    expect(request.passages.map((passage) => passage.id)).toEqual(["p2"]);
    expect(request.passages[0]!.section).toBe("Mazzoldi › Capitolo 1");
    expect(seen[0]!.system).toContain("Write flashcards for a student from the course passages of one subject");
    expect(result).toEqual({
      cards: [{ front: "Che cos'è l'accelerazione?", back: "Risposta a Che cos'è l'accelerazione?", passageId: "p2" }],
      provider: "claude",
      model: "test-model",
      repeats: 0,
    });
  });

  it("reads the whole subject without a topic or a focus, and stores nothing until the student saves", async () => {
    const db = fixture();
    const { seen, run } = recorded([card("Velocità?", "p1"), card("Forza?", "p3")]);
    const result = await proposeSubjectCards(db, { subjectId: "phys", count: 10 }, run);
    expect(seen[0]!.request.passages.map((passage) => passage.id).sort()).toEqual(["p1", "p2", "p3"]);
    expect(seen[0]!.request).not.toHaveProperty("topic");
    expect(seen[0]!.request).not.toHaveProperty("focus");
    expect(result.cards).toHaveLength(2);
    expect(count(db)).toBe(0);

    // Saving what the student kept files it under the subject, written by this prompt.
    expect(
      saveProposedCards(db, {
        subjectId: "phys",
        cards: result.cards,
        provider: result.provider,
        model: result.model,
        prompt: "cards.subject",
      }),
    ).toEqual({ saved: 2, skipped: 0 });
    expect(db.prepare("SELECT DISTINCT prompt_template, prompt_version, grounding, subject_id FROM cards").all()).toEqual([
      {
        prompt_template: "cards.subject",
        prompt_version: templateVersion("cards.subject"),
        grounding: "sources",
        subject_id: "phys",
      },
    ]);
  });

  it("drops a card the subject has already and counts it", async () => {
    const db = fixture();
    createCard(db, { subjectId: "phys", planId: "mech", front: "Che cos'è  la VELOCITÀ?", back: "x" });
    const { run } = recorded([card("Che cos'è la velocità?", "p1"), card("Forza?", "p3")]);
    const result = await proposeSubjectCards(db, { subjectId: "phys", count: 2 }, run);
    expect(result.cards.map((row) => row.front)).toEqual(["Forza?"]);
    expect(result.repeats).toBe(1);
  });

  it("reads a topic's passages from the sources the student still has, not from a removed one", async () => {
    const db = fixture();
    db.exec(`
      INSERT INTO sources(id,subject_id,kind,title,status,library,created_at,updated_at) VALUES
        ('notes','phys','pdf','Appunti','ready',1,1,1);
      INSERT INTO source_documents(id,source_id,version,tree_json,created_at) VALUES('doc2','notes',1,'{}',1);
      INSERT INTO passages(id,source_id,document_id,text,section_path,created_at) VALUES
        ('p4','notes','doc2','Il moto rettilineo uniforme ha velocità costante.','Lezione 1',9);
      INSERT INTO topic_passages(topic_id,passage_id) VALUES('kin','p4');
      UPDATE sources SET status = 'removed' WHERE id = 'book';
    `);
    const { seen, run } = recorded([card("Moto uniforme?", "p4")]);
    await proposeSubjectCards(db, { subjectId: "phys", planId: "mech", topicId: "kin", count: 5 }, run);
    expect(seen[0]!.request.passages.map((passage) => passage.id)).toEqual(["p4"]);
    // With only the removed source left under the topic, there is no material to write from.
    db.exec("UPDATE sources SET status = 'removed' WHERE id = 'notes'");
    await expect(
      proposeSubjectCards(db, { subjectId: "phys", planId: "mech", topicId: "kin", count: 5 }, run),
    ).rejects.toMatchObject({ code: "cards-no-material" });
    expect(seen).toHaveLength(1);
  });

  it("fails, and says why, when every card Pyxis wrote repeats one the subject has", async () => {
    const db = fixture();
    createCard(db, { subjectId: "phys", front: "Che cos'è la velocità?", back: "x" });
    createCard(db, { subjectId: "phys", front: "Forza?", back: "x" });
    const { run } = recorded([card("che cos'è la velocità?", "p1"), card("Forza?", "p3")]);
    await expect(proposeSubjectCards(db, { subjectId: "phys", count: 2 }, run)).rejects.toMatchObject({
      code: "cards-all-repeats",
      messageKey: "flashcards.new.errors.allRepeats",
    });
    expect(count(db)).toBe(2);
  });

  it("refuses a subject with no material, a focus the material doesn't cover and a reply with no card, saving nothing", async () => {
    const db = fixture();
    const { seen, run } = recorded([card("Velocità?", "p1")]);
    await expect(proposeSubjectCards(db, { subjectId: "chem", count: 10 }, run)).rejects.toMatchObject({
      code: "cards-no-material",
      messageKey: "flashcards.new.errors.noMaterial",
    });
    await expect(
      proposeSubjectCards(db, { subjectId: "phys", focus: "termodinamica entropia", count: 10 }, run),
    ).rejects.toMatchObject({ code: "cards-nothing-matched" });
    expect(seen).toHaveLength(0);
    await expect(proposeSubjectCards(db, { subjectId: "phys", count: 10 }, recorded([]).run)).rejects.toMatchObject({
      code: "cards-nothing-matched",
    });
    expect(count(db)).toBe(0);
  });

  it("says when no AI tool is set up, and a failed call saves nothing", async () => {
    await expect(proposeSubjectCards(fixture(false), { subjectId: "phys", count: 3 }, recorded([]).run)).rejects.toMatchObject({
      code: "engine-missing",
    });
    const db = fixture();
    await expect(
      proposeSubjectCards(db, { subjectId: "phys", count: 3 }, recorded(new Error("rate limit")).run),
    ).rejects.toThrow();
    expect(count(db)).toBe(0);
  });

  it("needs the topic to be one of the subject's", async () => {
    const db = fixture();
    await expect(
      proposeSubjectCards(db, { subjectId: "chem", planId: "mech", topicId: "kin", count: 3 }, recorded([]).run),
    ).rejects.toThrow("plan-not-in-subject");
  });
});
