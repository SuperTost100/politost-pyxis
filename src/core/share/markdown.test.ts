import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { createPlan } from "../plans/create";
import { importSmartbook } from "../sources/smartbook";
import {
  cardsCsv,
  cardsMarkdown,
  exportMarkdown,
  lessonMarkdown,
  quizMarkdown,
} from "./markdown";

function pack(files: Record<string, string>): Uint8Array {
  return zipSync(
    Object.fromEntries(
      Object.entries(files).map(([name, text]) => [name, strToU8(text)]),
    ),
  );
}

describe("markdown export", () => {
  it("preserves matching prompts without revealing their answers", () => {
    const text = quizMarkdown(
      [
        {
          stem: "Match",
          left: ["$x$", "$y$"],
          right: ["Mass", "Force"],
          answer: "x = Mass",
        },
      ],
      false,
    );
    expect(text).toContain("1. $x$");
    expect(text).toContain("A. Mass");
    expect(text).not.toContain("x = Mass");
  });
  it("keeps LaTeX and lists a source once", () => {
    const text = lessonMarkdown("Energia", "La derivata è $x^2$.", [
      "1. Moti",
      "1. Moti",
      " ",
    ]);
    expect(text).toContain("$x^2$");
    expect(text).toContain("## Sources\n\n- 1. Moti\n");
    expect(text.match(/1\. Moti/g)).toHaveLength(1);
    const cards = cardsMarkdown([
      { front: "Quanto vale $x^2$?", back: "$x^2$", source: "1. Moti" },
    ]);
    expect(cards).toContain("$x^2$");
    expect(cards).toContain("Source: 1. Moti");
    const hidden = quizMarkdown(
      [{ stem: "Deriva $x^2$", answer: "2x", source: "1" }],
      false,
    );
    expect(hidden).toContain("$x^2$");
    expect(hidden).not.toContain("2x");
    expect(
      quizMarkdown([{ stem: "Deriva $x^2$", answer: "2x", source: "1" }], true),
    ).toContain("Answer: 2x");
    const csv = cardsCsv([
      {
        front: "Quanto vale $x^2$, oggi?",
        back: 'dice "due"',
        source: "1. Moti",
      },
      { front: "{{c1::$x^2$}}", back: "il quadrato", source: null },
    ]);
    expect(
      csv.startsWith("#html:true\n#separator:comma\n#notetype column:1\n"),
    ).toBe(true);
    expect(csv).toContain('Basic,"Quanto vale $x^2$, oggi?"');
    expect(csv).toContain("Cloze,{{c1::$x^2$}}");
    expect(cardsCsv([{ front: "#define", back: "directive" }])).toBe(
      '#html:true\n#separator:comma\n#notetype column:1\nBasic,"#define",directive\n',
    );
    expect(cardsCsv([{ front: "When? 09:00", back: "Wake up" }])).toBe(
      "#html:true\n#separator:comma\n#notetype column:1\nBasic,When? 09:00,Wake up\n",
    );
    expect(
      cardsCsv([{ front: "Capital: {{c1::Paris}}", back: "Paris" }]),
    ).toContain("Cloze,Capital: {{c1::Paris}},Paris");
    const cloze = cardsCsv([{ front: "{{c1::alpha\nbeta}}", back: "answer" }]);
    expect(cloze).toContain("{{c1::alpha<br>beta}}");
    expect(cloze).not.toContain("alpha\n");
    expect(cardsCsv([{ front: "alpha\rbeta", back: "answer" }])).toContain(
      "alpha<br>beta",
    );
    const sound = cardsCsv([{ front: "Explain [sound:test.mp3]", back: "x" }]);
    expect(sound).toContain("Explain &#91;sound:test.mp3]");
    expect(sound).not.toContain("[sound:");
    const speech = cardsCsv([
      { front: "[anki:tts lang=en_US]hello[/anki:tts]", back: "x" },
    ]);
    expect(speech).toContain("&#91;anki:tts lang=en_US]");
    expect(speech).not.toContain("[anki:");
  });

  it("exports a lesson, its cards, and a quiz from the plan", () => {
    const db = openDatabase(":memory:");
    const imported = importSmartbook(
      db,
      pack({
        "smartbook.json": JSON.stringify({
          id: "demo",
          title: "Fisica",
          access: "public",
          chapters: [{ id: "c1", number: 1, title: "Moti", file: "01.md" }],
        }),
        "chapters/01.md": "## p1 | Energia\nIl vettore $x^2$.\n",
        "esercizi.md":
          ':::exercise{id="e1" chapter="1"}\nChe cos\'è la forza?\n:::solution\nuna spinta\n:::\n:::\n',
      }),
    );
    const plan = createPlan(db, {
      title: "Fisica/1",
      sourceIds: [imported.sourceId],
    });
    const topic = db
      .prepare(`SELECT id FROM topics WHERE plan_id = ?`)
      .get(plan.planId) as {
      id: string;
    };
    const lesson = exportMarkdown(db, {
      planId: plan.planId,
      kind: "lesson",
      topicId: topic.id,
    });
    expect(lesson.filename).toBe("Fisica 1.md");
    expect(lesson.markdown).toContain("$x^2$");
    expect(lesson.markdown).toContain("Source");
    expect(lesson.markdown).toContain("1. Moti");
    const passage = db.prepare(`SELECT id FROM passages LIMIT 1`).get() as {
      id: string;
    };
    db.prepare(
      `INSERT INTO cards (id, plan_id, topic_id, front, back, passage_id, grounding, created_at)
       VALUES ('card-1', ?, ?, '$x^2$', 'il quadrato', ?, 'sources', 1)`,
    ).run(plan.planId, topic.id, passage.id);
    const cards = exportMarkdown(db, {
      planId: plan.planId,
      kind: "cards",
      topicId: topic.id,
    });
    expect(cards.markdown).toContain("$x^2$");
    expect(cards.markdown).toContain("Source: 1. Moti");
    const exercise = db.prepare(`SELECT id FROM exercises LIMIT 1`).get() as {
      id: string;
    };
    db.prepare(
      `INSERT INTO items (id, plan_id, kind, body_json, grounding, created_at)
       VALUES ('quiz-1', ?, 'quiz', ?, 'sources', 1)`,
    ).run(
      plan.planId,
      JSON.stringify({
        questions: [
          {
            stem: "Deriva $x^2$",
            sourceId: exercise.id,
            sourceIds: [passage.id],
            answer: { kind: "completion", accepted: [["2x"]] },
          },
        ],
      }),
    );
    const hidden = exportMarkdown(db, { planId: plan.planId, kind: "quiz" });
    expect(hidden.markdown).toContain("$x^2$");
    expect(hidden.markdown).toContain("Source: 1");
    expect(hidden.markdown).not.toContain("2x");
    const shown = exportMarkdown(db, {
      planId: plan.planId,
      kind: "quiz",
      answers: true,
    });
    expect(shown.markdown).toContain("Answer: 2x");
    expect(shown.markdown).toContain("1. Moti");
    db.prepare(
      `INSERT INTO items (id, plan_id, kind, body_json, grounding, created_at)
       VALUES ('sim-1', ?, 'simulation', ?, 'sources', 2)`,
    ).run(
      plan.planId,
      JSON.stringify({
        minutes: 30,
        questions: [
          {
            id: exercise.id,
            stem: "Simula $x^2$",
            answer: { kind: "completion", accepted: [["2x"]] },
          },
        ],
      }),
    );
    const simulation = exportMarkdown(db, {
      planId: plan.planId,
      kind: "simulation",
    });
    expect(simulation.markdown).toContain("Source: 1");
    expect(simulation.markdown).not.toContain("2x");
  });
});
