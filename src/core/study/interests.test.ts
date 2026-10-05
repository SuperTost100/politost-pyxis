import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import type { GenerateInput } from "../engine/generate";
import { saveProfile } from "../profile/profile";
import { generateTopicCards } from "./cardsFromBook";
import { generateQuiz, prepareQuiz } from "./configuredQuiz";
import { prepareExercises } from "./exerciseJobs";
import { writeLesson } from "./openLesson";

// PER-04: the student's interests reach every generator that writes examples or problems,
// and the switch removes them. The tutor chat has its own test in chat/profile-context.test.ts.
function fixture() {
  const db = openDatabase(":memory:");
  db.prepare(
    "INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES ('default', ?, 1)",
  ).run(JSON.stringify({ provider: "claude", model: "claude-sonnet-5" }));
  db.prepare(
    "INSERT INTO plans (id, title, status, created_at, updated_at) VALUES ('plan', 'Physics', 'ready', 1, 1)",
  ).run();
  db.prepare(
    "INSERT INTO topics (id, plan_id, title, position, created_at) VALUES ('topic', 'plan', 'Motion', 0, 1)",
  ).run();
  db.prepare(
    "INSERT INTO sources (id, kind, title, status, created_at, updated_at) VALUES ('src', 'pdf', 'Notes', 'ready', 1, 1)",
  ).run();
  db.prepare(
    "INSERT INTO source_documents (id, source_id, version, tree_json, created_at) VALUES ('doc', 'src', 1, '{}', 1)",
  ).run();
  db.prepare(
    "INSERT INTO passages (id, source_id, document_id, text, created_at) VALUES ('p', 'src', 'doc', 'Velocity is the displacement of a body per unit of time.', 1)",
  ).run();
  db.prepare(
    "INSERT INTO topic_passages (topic_id, passage_id) VALUES ('topic', 'p')",
  ).run();
  saveProfile(db, { interests: ["ciclismo", "scacchi"], interestsOn: true });
  return db;
}

const reply = (structured: unknown, text = JSON.stringify(structured)) => ({
  structured,
  text,
  provider: "claude",
  model: "test-model",
  inputTokens: 1,
});

/** What each generator sends as its system text for this database. */
async function systems(db: ReturnType<typeof fixture>) {
  const seen: Record<string, string> = {};
  const record =
    (name: string, answer: (input: { prompt: string }) => ReturnType<typeof reply>): GenerateInput["run"] =>
    async (input) => {
      seen[name] = input.system ?? "";
      return answer(input);
    };
  await writeLesson(
    db,
    "plan",
    "topic",
    record("lesson", () => reply(undefined, "La velocità è spostamento nel tempo [P1].")),
    { regenerate: true },
  );
  await generateQuiz(
    prepareQuiz(db, { planId: "plan", topicId: "topic", count: 10, types: ["tf"], feedback: true }),
    record("quiz", (input) => {
      const { count } = JSON.parse(input.prompt) as { count: number };
      return reply({
        questions: Array.from({ length: count }, (_, i) => ({
          kind: "tf",
          stem: `Statement ${i}`,
          explanation: "Velocity is displacement per time.",
          passageIds: ["p"],
          correct: true,
        })),
      });
    }),
  );
  await generateTopicCards(
    db,
    { planId: "plan", topicId: "topic" },
    record("cards", (input) => {
      const { passages } = JSON.parse(input.prompt) as { passages: Array<{ id: string }> };
      return reply({
        cards: passages.map((row) => ({
          kind: "qa",
          front: "What is velocity?",
          back: "Displacement per time.",
          passageId: row.id,
        })),
      });
    }),
  );
  return seen;
}

describe("interests in generated study content (PER-04)", () => {
  it("reaches lessons, quizzes, cards and exercises while the switch is on", async () => {
    const db = fixture();
    const seen = await systems(db);
    for (const name of ["lesson", "quiz", "cards"])
      expect(seen[name], name).toContain("ciclismo, scacchi");
    expect(prepareExercises(db, { planId: "plan", topicId: "topic" }).interests).toContain("ciclismo, scacchi");
  });

  it("sends nothing once the switch is off or the list is empty", async () => {
    const off = fixture();
    saveProfile(off, { interestsOn: false });
    const seen = await systems(off);
    for (const name of ["lesson", "quiz", "cards"])
      expect(seen[name], name).not.toMatch(/ciclismo|prefer contexts/);
    expect(prepareExercises(off, { planId: "plan", topicId: "topic" }).interests).toBeUndefined();

    const empty = fixture();
    saveProfile(empty, { interests: [] });
    expect(prepareExercises(empty, { planId: "plan", topicId: "topic" }).interests).toBeUndefined();
  });
});
