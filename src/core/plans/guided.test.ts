import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import type { GenerateInput } from "../engine/generate";
import { proposeModules, proposeTree } from "./guided";

function engine(db: ReturnType<typeof openDatabase>) {
  db.prepare(
    "INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES ('default', ?, 1)",
  ).run(JSON.stringify({ provider: "claude", model: "claude-sonnet-5" }));
}
const reply = (data: unknown) => ({
  text: JSON.stringify(data),
  structured: data,
  provider: "claude" as const,
  model: "fixture",
  inputTokens: 1,
});

describe("PLAN-10 guided flow calls", () => {
  it("proposes modules from the subject, semesters and profile without storing anything", async () => {
    const db = openDatabase(":memory:");
    engine(db);
    db.prepare(
      "INSERT INTO profile (id, display_name, education_level, school, course, tutor_mode, content_language, created_at, updated_at) VALUES ('p', 'Ada', 'university', 'PoliTo', 'Ingegneria', 'solver', 'Italian', 1, 1)",
    ).run();
    const seen: Array<{ system?: string; prompt: string }> = [];
    const run: GenerateInput["run"] = async (input) => {
      seen.push({ system: input.system, prompt: input.prompt });
      return reply({
        modules: [{ title: "Derivate", summary: "Limiti e derivate." }],
      });
    };
    const result = await proposeModules(
      db,
      { subject: "Analisi 1", semesters: ["1", "2"], language: "it" },
      undefined,
      run,
    );
    expect(result.modules).toEqual([
      { title: "Derivate", summary: "Limiti e derivate." },
    ]);
    expect(seen[0]!.system).toMatch(/^Propose /);
    expect(seen[0]!.system).toContain("Write all output in Italian.");
    expect(JSON.parse(seen[0]!.prompt)).toEqual({
      subject: "Analisi 1",
      semesters: ["1", "2"],
      level: "university",
      school: "PoliTo",
      course: "Ingegneria",
    });
    expect(db.prepare("SELECT COUNT(*) AS n FROM plans").get()).toEqual({
      n: 0,
    });
    db.close();
  });

  it("builds the tree from the chosen focus and style, and repairs an invalid answer once", async () => {
    const db = openDatabase(":memory:");
    engine(db);
    const prompts: string[] = [];
    const run: GenerateInput["run"] = async (input) => {
      prompts.push(input.prompt);
      return prompts.length === 1
        ? reply({ topics: [] })
        : reply({
            topics: [
              { title: "Limiti", summary: "Intro", subtopics: ["Continuità"] },
            ],
          });
    };
    const tree = await proposeTree(
      db,
      {
        subject: "Analisi 1",
        semesters: ["1"],
        language: "en",
        style: "practice",
        modules: [
          { title: "Limiti", summary: "Intro", focus: true },
          { title: "Serie", summary: "Somme", focus: false },
        ],
      },
      undefined,
      run,
    );
    expect(tree.topics[0]!.title).toBe("Limiti");
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("failed validation");
    expect(JSON.parse(prompts[0]!)).toMatchObject({
      style: "practice",
      modules: [
        { title: "Limiti", focus: true },
        { title: "Serie", focus: false },
      ],
    });
    db.close();
  });
});
