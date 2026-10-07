import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { createRunner } from "../jobs/runner";
import {
  enqueuePlan,
  registerPlanJobs,
  planBuildState,
  diagnosticTopics,
} from "./jobs";
import { importSmartbook } from "../sources/smartbook";
import { strToU8, zipSync } from "fflate";
import type { GenerateInput } from "../engine/generate";
import { partialText, templateVersion } from "../engine/prompts";
import { startDiagnostic } from "../study/topicQuiz";
import { readPlan } from "./create";
import { SEGMENT_LIMIT } from "./segments";

async function until(
  db: ReturnType<typeof openDatabase>,
  id: string,
  state: string,
) {
  for (let i = 0; i < 200; i++) {
    if (planBuildState(db, id)?.state === state) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(JSON.stringify(planBuildState(db, id)));
}
function source(db: ReturnType<typeof openDatabase>) {
  return importSmartbook(
    db,
    zipSync({
      "smartbook.json": strToU8(
        JSON.stringify({
          id: "physics",
          title: "Fisica",
          access: "public",
          chapters: [{ id: "c1", number: 1, title: "Moti", file: "01.md" }],
        }),
      ),
      "chapters/01.md": strToU8(
        "## p1 | Velocità\nLa velocità descrive il movimento.\n\n## p2 | Tempo\nIl tempo si misura in secondi.\n",
      ),
    }),
  ).sourceId;
}
function response(data: unknown) {
  return {
    text: JSON.stringify(data),
    structured: data,
    provider: "claude" as const,
    model: "fixture",
    inputTokens: 10,
  };
}
function diagnostic(prompt: string) {
  const content = JSON.parse(prompt) as { passages: Array<{ id: string }> };
  return {
    questions: Array.from({ length: 10 }, (_, i) => ({
      stem: `Domanda ${i}`,
      options: ["a", "b", "c", "d"],
      correct: 0,
      topicIndex: 0,
      passageIds: [content.passages[0]!.id],
      explanation: "Spiegazione",
    })),
  };
}

describe("PLAN-21 durable plan build", () => {
  it("samples long topic trees across their full range and skips empty grounded chapters", () => {
    const tree = Array.from({ length: 30 }, (_, i) => ({
      title: String(i),
      summary: "",
      subtopics: [],
      passageIds: i === 1 ? [] : [`p${i}`],
    }));
    const picked = diagnosticTopics(tree);
    expect(picked).toHaveLength(20);
    expect(picked[0]).toBe(0);
    expect(picked.at(-1)).toBe(29);
    expect(picked).not.toContain(1);
    expect(new Set(picked).size).toBe(20);
  });
  it("retries only the failed generation and preserves the topic and introduction", async () => {
    const db = openDatabase(":memory:");
    db.prepare(
      "INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES ('default', ?, 1)",
    ).run(JSON.stringify({ provider: "claude", model: "claude-sonnet-5" }));
    const sourceId = source(db);
    const calls = { intro: 0, diagnostic: 0, tree: 0 };
    const systems: Record<string, string> = {};
    const run: GenerateInput["run"] = async (input) => {
      if (input.system?.startsWith("Write")) {
        calls.intro++;
        systems.intro = input.system;
        systems.introPrompt = input.prompt;
        return response({ markdown: "Il moto [P1]." });
      }
      if (input.system?.startsWith("Create")) {
        calls.diagnostic++;
        systems.diagnostic = input.system;
        if (calls.diagnostic === 1) throw new Error("offline");
        return response(diagnostic(input.prompt));
      }
      calls.tree++;
      throw new Error("Smartbook tree must not call a model");
    };
    const runner = createRunner(db, () => {});
    registerPlanJobs(db, runner, run);
    const built = enqueuePlan(db, runner, {
      title: "Fisica",
      sourceIds: [sourceId],
    });
    await until(db, built.planId, "failed");
    const topic = readPlan(db, built.planId)!.topics[0]!;
    expect(topic.subtopics).toHaveLength(2);
    expect(topic.subtopics[0]).toContain("p1");
    expect(topic.subtopics[1]).toContain("p2");
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM items WHERE kind = 'intro'").get(),
    ).toEqual({ n: 1 });
    runner.dismiss(built.jobId);
    expect(runner.list()).toEqual([]);
    expect(planBuildState(db, built.planId)?.state).toBe("failed");
    runner.retry(built.jobId);
    await until(db, built.planId, "succeeded");
    expect(calls).toEqual({ intro: 1, diagnostic: 2, tree: 0 });
    expect(readPlan(db, built.planId)!.topics[0]!.id).toBe(topic.id);
    expect(db.prepare("SELECT COUNT(*) AS n FROM attempts").get()).toEqual({
      n: 0,
    });
    expect(startDiagnostic(db, built.planId).questions).toHaveLength(10);
    for (const id of ["intro", "diagnostic"] as const) {
      expect(systems[id], id).toContain("Write all output in Italian.");
      expect(systems[id], id).not.toMatch(/\{\{[A-Za-z]/);
    }
    expect(systems.diagnostic).toContain(partialText("citation"));
    // The introduction is smart text for the student: no citation rule, no passage ids to quote, none stored.
    expect(systems.intro).not.toContain(partialText("citation"));
    expect(systems.intro).toContain("```pyxis-check");
    const passageIds = (
      db.prepare("SELECT id FROM passages").all() as Array<{ id: string }>
    ).map((row) => row.id);
    expect(passageIds.some((id) => systems.introPrompt!.includes(id))).toBe(false);
    expect(
      JSON.parse(
        (
          db.prepare("SELECT body_json FROM items WHERE kind = 'intro'").get() as {
            body_json: string;
          }
        ).body_json,
      ).markdown,
    ).toBe("Il moto.");
    expect(
      db
        .prepare(
          "SELECT kind, prompt_template, prompt_version FROM items WHERE kind IN ('intro','diagnostic') ORDER BY kind",
        )
        .all(),
    ).toEqual([
      {
        kind: "diagnostic",
        prompt_template: "plan.diagnostic",
        prompt_version: templateVersion("plan.diagnostic"),
      },
      {
        kind: "intro",
        prompt_template: "plan.intro",
        prompt_version: templateVersion("plan.intro"),
      },
    ]);
    db.close();
  });
  it("cancels a real model step and resumes the same plan", async () => {
    const db = openDatabase(":memory:");
    db.prepare(
      "INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES ('default', ?, 1)",
    ).run(JSON.stringify({ provider: "claude", model: "claude-sonnet-5" }));
    const sourceId = source(db);
    let entered = false;
    let block = true;
    const run: GenerateInput["run"] = async (input) => {
      if (input.system?.startsWith("Write")) {
        entered = true;
        if (block)
          await new Promise<void>((_, reject) =>
            input.signal?.addEventListener(
              "abort",
              () => reject(new DOMException("aborted", "AbortError")),
              { once: true },
            ),
          );
        return response({ markdown: "Introduzione" });
      }
      return response(diagnostic(input.prompt));
    };
    const runner = createRunner(db, () => {});
    registerPlanJobs(db, runner, run);
    const built = enqueuePlan(db, runner, {
      title: "Fisica",
      sourceIds: [sourceId],
    });
    while (!entered) await new Promise((resolve) => setTimeout(resolve, 5));
    runner.cancel(built.jobId);
    await until(db, built.planId, "cancelled");
    block = false;
    runner.retry(built.jobId);
    await until(db, built.planId, "succeeded");
    expect(db.prepare("SELECT COUNT(*) AS n FROM plans").get()).toEqual({
      n: 1,
    });
    expect(db.prepare("SELECT COUNT(*) AS n FROM topics").get()).toEqual({
      n: 1,
    });
    db.close();
  });
  it("consolidates document sections and keeps their captured version on retry", async () => {
    const db = openDatabase(":memory:");
    db.prepare(
      "INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES ('default', ?, 1)",
    ).run(JSON.stringify({ provider: "claude", model: "claude-sonnet-5" }));
    db.prepare(
      "INSERT INTO sources (id, kind, title, status, created_at, updated_at) VALUES ('pdf', 'pdf', 'Note', 'ready', 1, 1)",
    ).run();
    db.prepare(
      "INSERT INTO source_documents (id, source_id, version, tree_json, created_at) VALUES ('doc', 'pdf', 1, '{}', 1)",
    ).run();
    db.prepare(
      "INSERT INTO passages (id, source_id, document_id, text, section_path, created_at) VALUES ('p', 'pdf', 'doc', 'Testo originale', 'p. 1', 1)",
    ).run();
    let fail = true;
    let treeCalls = 0;
    const run: GenerateInput["run"] = async (input) => {
      if (input.system?.startsWith("Build")) {
        treeCalls++;
        return response({
          topics: [
            {
              title: "Moto",
              summary: "Velocità",
              subtopics: ["Tempo"],
              segmentIds: ["s1"],
            },
          ],
        });
      }
      if (input.system?.startsWith("Write")) {
        if (fail) throw new Error("offline");
        expect(input.prompt).toContain("Testo originale");
        expect(input.prompt).not.toContain("Nuova versione");
        return response({ markdown: "Introduzione" });
      }
      return response(diagnostic(input.prompt));
    };
    const runner = createRunner(db, () => {});
    registerPlanJobs(db, runner, run);
    const built = enqueuePlan(db, runner, {
      title: "Fisica",
      sourceIds: ["pdf"],
    });
    await until(db, built.planId, "failed");
    db.prepare(
      "INSERT INTO source_documents (id, source_id, version, tree_json, created_at) VALUES ('new', 'pdf', 2, '{}', 2)",
    ).run();
    db.prepare(
      "INSERT INTO passages (id, source_id, document_id, text, section_path, created_at) VALUES ('new-p', 'pdf', 'new', 'Nuova versione', 'p. 1', 2)",
    ).run();
    fail = false;
    runner.retry(built.jobId);
    await until(db, built.planId, "succeeded");
    expect(treeCalls).toBe(1);
    expect(db.prepare("SELECT passage_id FROM topic_passages").all()).toEqual([
      { passage_id: "p" },
    ]);
    db.close();
  });
  it("checkpoints long-document summaries before retrying consolidation", async () => {
    const db = openDatabase(":memory:");
    db.prepare(
      "INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES ('default', ?, 1)",
    ).run(JSON.stringify({ provider: "claude", model: "claude-sonnet-5" }));
    db.prepare(
      "INSERT INTO sources (id, kind, title, status, created_at, updated_at) VALUES ('pdf', 'pdf', 'Long notes', 'ready', 1, 1)",
    ).run();
    db.prepare(
      "INSERT INTO source_documents (id, source_id, version, tree_json, created_at) VALUES ('doc', 'pdf', 1, '{}', 1)",
    ).run();
    const insert = db.prepare(
      "INSERT INTO passages (id, source_id, document_id, text, section_path, created_at) VALUES (?, 'pdf', 'doc', ?, ?, ?)",
    );
    for (let i = 0; i < 600; i++)
      insert.run(`p${i}`, `Concept ${i}. `.repeat(30), `p. ${i + 1}`, i);
    let summaries = 0;
    let trees = 0;
    const filled: string[] = [];
    const run: GenerateInput["run"] = async (input) => {
      if (
        input.system?.startsWith("Summarize") ||
        input.system?.startsWith("Build")
      )
        filled.push(input.system);
      if (input.system?.startsWith("Summarize")) {
        summaries++;
        const content = JSON.parse(input.prompt) as {
          passages: Array<{ section: string; text: string }>;
        };
        expect(content.passages).toHaveLength(80);
        expect(content.passages[0]!.text).toContain("Concept 0.");
        expect(content.passages.at(-1)!.text).toContain("Concept 599.");
        return response({
          synopsis: "Course sequence, concepts 0 through 599.",
        });
      }
      if (input.system?.startsWith("Build")) {
        trees++;
        if (trees === 1) throw new Error("offline");
        const content = JSON.parse(input.prompt) as {
          sourceSynopses: Array<{ sourceId: string; synopsis: string }>;
          sources: Array<{ segmentId: string; sample: string }>;
        };
        expect(content.sourceSynopses).toEqual([
          {
            sourceId: "pdf",
            synopsis: "Course sequence, concepts 0 through 599.",
          },
        ]);
        // 600 pages are folded into a bounded outline; the model never echoes every page.
        expect(content.sources).toHaveLength(SEGMENT_LIMIT);
        expect(
          content.sources.every((section) => section.sample.length > 0),
        ).toBe(true);
        return response({
          topics: [
            {
              title: "Course",
              summary: "All concepts",
              subtopics: [],
              segmentIds: ["s1", content.sources.at(-1)!.segmentId],
            },
          ],
        });
      }
      if (input.system?.startsWith("Write"))
        return response({ markdown: "Course introduction [P1]." });
      return response(diagnostic(input.prompt));
    };
    const runner = createRunner(db, () => {});
    registerPlanJobs(db, runner, run);
    const built = enqueuePlan(db, runner, {
      title: "Long course",
      sourceIds: ["pdf"],
    });
    await until(db, built.planId, "failed");
    runner.retry(built.jobId);
    await until(db, built.planId, "succeeded");
    expect(summaries).toBe(1);
    expect(trees).toBe(2);
    // Segments the topic did not name attach to it, so all 600 pages stay covered.
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM topic_passages").get(),
    ).toEqual({ n: 600 });
    expect(filled).toHaveLength(3);
    for (const system of filled) {
      expect(system).toContain("Write all output in Italian.");
      expect(system).not.toMatch(/\{\{[A-Za-z]/);
    }
    expect(
      db.prepare("SELECT prompt_template, prompt_version FROM plans").get(),
    ).toEqual({
      prompt_template: "plan.topics",
      prompt_version: templateVersion("plan.topics"),
    });
    db.close();
  });
  it("splits a flat pasted or DOCX source so topics do not all link every passage", async () => {
    const db = openDatabase(":memory:");
    db.prepare(
      "INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES ('default', ?, 1)",
    ).run(JSON.stringify({ provider: "claude", model: "claude-sonnet-5" }));
    db.prepare(
      "INSERT INTO sources (id, kind, title, status, created_at, updated_at) VALUES ('docx', 'file', 'Appunti', 'ready', 1, 1)",
    ).run();
    db.prepare(
      "INSERT INTO source_documents (id, source_id, version, tree_json, created_at) VALUES ('doc', 'docx', 1, '{}', 1)",
    ).run();
    const insert = db.prepare(
      "INSERT INTO passages (id, source_id, document_id, text, section_path, created_at) VALUES (?, 'docx', 'doc', ?, 'text', ?)",
    );
    for (let i = 0; i < 40; i++) insert.run(`d${i}`, `Paragrafo ${i}`, i);
    const run: GenerateInput["run"] = async (input) => {
      if (input.system?.startsWith("Build")) {
        const content = JSON.parse(input.prompt) as {
          sources: Array<{ segmentId: string; label: string }>;
        };
        // Twenty parts of two passages each. Each topic names one part and inherits the following ones.
        expect(content.sources).toHaveLength(20);
        expect(content.sources[0]!.label).toBe("text 1/20");
        return response({
          topics: [
            { title: "Parte uno", summary: "A", subtopics: [], segmentIds: ["s1"] },
            { title: "Parte due", summary: "B", subtopics: [], segmentIds: ["s11"] },
          ],
        });
      }
      if (input.system?.startsWith("Write"))
        return response({ markdown: "Introduzione [P1]." });
      const content = JSON.parse(input.prompt) as {
        diagnosticTopicIndices: number[];
        passages: Array<{ id: string }>;
      };
      return response({
        questions: Array.from({ length: 10 }, (_, i) => {
          const topicIndex =
            content.diagnosticTopicIndices[i % content.diagnosticTopicIndices.length]!;
          return {
            stem: `Domanda ${i}`,
            options: ["a", "b", "c", "d"],
            correct: 0,
            topicIndex,
            passageIds: [
              content.passages.find((p) => Math.floor(Number(p.id.slice(1)) / 20) === topicIndex)!
                .id,
            ],
            explanation: "Spiegazione",
          };
        }),
      });
    };
    const runner = createRunner(db, () => {});
    registerPlanJobs(db, runner, run);
    const built = enqueuePlan(db, runner, { title: "Appunti", sourceIds: ["docx"] });
    await until(db, built.planId, "succeeded");
    const counts = db
      .prepare(
        "SELECT t.title, COUNT(*) AS n FROM topic_passages tp JOIN topics t ON t.id = tp.topic_id GROUP BY t.id ORDER BY t.position",
      )
      .all();
    expect(counts).toEqual([
      { title: "Parte uno", n: 20 },
      { title: "Parte due", n: 20 },
    ]);
    db.close();
  });
  it("tells the diagnostic which topic owns each passage and repairs a citation from another topic", async () => {
    const db = openDatabase(":memory:");
    db.prepare(
      "INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES ('default', ?, 1)",
    ).run(JSON.stringify({ provider: "codex", model: "gpt-6.1-sol" }));
    db.prepare(
      "INSERT INTO sources (id, kind, title, status, created_at, updated_at) VALUES ('docx', 'file', 'Appunti', 'ready', 1, 1)",
    ).run();
    db.prepare(
      "INSERT INTO source_documents (id, source_id, version, tree_json, created_at) VALUES ('doc', 'docx', 1, '{}', 1)",
    ).run();
    const insert = db.prepare(
      "INSERT INTO passages (id, source_id, document_id, text, section_path, created_at) VALUES (?, 'docx', 'doc', ?, 'text', ?)",
    );
    for (let i = 0; i < 40; i++) insert.run(`d${i}`, `Paragrafo ${i}`, i);
    let diagnosticCalls = 0;
    let owners: Array<number | undefined> = [];
    const run: GenerateInput["run"] = async (input) => {
      if (input.system?.startsWith("Build"))
        return response({
          topics: [
            { title: "Parte uno", summary: "A", subtopics: [], segmentIds: ["s1"] },
            { title: "Parte due", summary: "B", subtopics: [], segmentIds: ["s11"] },
          ],
        });
      if (input.system?.startsWith("Write"))
        return response({ markdown: "Introduzione [P1]." });
      diagnosticCalls++;
      const content = JSON.parse(input.prompt) as {
        diagnosticTopicIndices: number[];
        passages: Array<{ id: string; topicIndex?: number }>;
      };
      owners = content.passages.map((p) => p.topicIndex);
      // Every question cites the first passage, which belongs to topic 0 only.
      return response({
        questions: Array.from({ length: 10 }, (_, i) => ({
          stem: `Domanda ${i}`,
          options: ["a", "b", "c", "d"],
          correct: 0,
          topicIndex: content.diagnosticTopicIndices[i % 2]!,
          passageIds: [content.passages[0]!.id, "invented"],
          explanation: "Spiegazione",
        })),
      });
    };
    const runner = createRunner(db, () => {});
    registerPlanJobs(db, runner, run);
    const built = enqueuePlan(db, runner, { title: "Appunti", sourceIds: ["docx"] });
    await until(db, built.planId, "succeeded");
    expect(diagnosticCalls).toBe(1);
    expect(new Set(owners)).toEqual(new Set([0, 1]));
    const topics = db
      .prepare("SELECT id FROM topics WHERE plan_id = ? ORDER BY position")
      .all(built.planId) as Array<{ id: string }>;
    const owned = db.prepare(
      "SELECT 1 FROM topic_passages WHERE topic_id = ? AND passage_id = ?",
    );
    const body = JSON.parse(
      (
        db
          .prepare("SELECT body_json FROM items WHERE kind = 'diagnostic'")
          .get() as { body_json: string }
      ).body_json,
    ) as { questions: Array<{ topicId: string; sourceIds: string[] }> };
    expect(body.questions.map((q) => q.topicId)).toContain(topics[1]!.id);
    for (const q of body.questions) {
      expect(q.sourceIds).toHaveLength(1);
      expect(owned.get(q.topicId, q.sourceIds[0])).toBeTruthy();
    }
    db.close();
  });
  it("keeps a plan without material a draft after the build, with every topic tagged general", async () => {
    const db = openDatabase(":memory:");
    db.prepare(
      "INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES ('default', ?, 1)",
    ).run(JSON.stringify({ provider: "claude", model: "claude-sonnet-5" }));
    const topicCalls: string[] = [];
    const run: GenerateInput["run"] = async (input) => {
      if (input.system?.startsWith("Build") || input.system?.startsWith("Draft"))
        topicCalls.push(input.system.slice(0, 5));
      if (input.system?.startsWith("Build"))
        return response({
          topics: [{ title: "Limiti", summary: "Base", subtopics: ["Serie"], segmentIds: [] }],
        });
      if (input.system?.startsWith("Write"))
        return response({ markdown: "Introduzione" });
      const { diagnosticTopicIndices } = JSON.parse(input.prompt) as {
        diagnosticTopicIndices: number[];
      };
      return response({
        questions: Array.from({ length: 10 }, (_, i) => ({
          stem: `Domanda ${i}`,
          options: ["a", "b", "c", "d"],
          correct: 0,
          topicIndex: diagnosticTopicIndices[i % diagnosticTopicIndices.length],
          passageIds: [],
          explanation: "Spiegazione",
        })),
      });
    };
    const runner = createRunner(db, () => {});
    registerPlanJobs(db, runner, run);

    // The student's edited tree is used as is: no topic call, plan stays a draft.
    const edited = enqueuePlan(db, runner, {
      title: "Analisi",
      sourceIds: [],
      draftTopics: [
        { title: "Derivate", summary: "Pendenza", subtopics: ["Regole"] },
        { title: "Integrali" },
      ],
    });
    await until(db, edited.planId, "succeeded");
    expect(topicCalls).toEqual([]);
    const plan = readPlan(db, edited.planId)!;
    expect(plan.status).toBe("draft");
    expect(plan.topics.map((t) => [t.title, t.grounding, t.subtopics])).toEqual([
      ["Derivate", "general", ["Regole"]],
      ["Integrali", "general", []],
    ]);
    expect(
      db
        .prepare("SELECT prompt_template FROM plans WHERE id = ?")
        .get(edited.planId),
    ).toEqual({ prompt_template: "plan.tree" });
    expect(plan.nodes.some((node) => node.state === "current")).toBe(true);

    // With no tree at all the model proposes one, and the result is a draft too.
    const invented = enqueuePlan(db, runner, { title: "Fisica", sourceIds: [] });
    await until(db, invented.planId, "succeeded");
    expect(topicCalls).toEqual(["Build"]);
    expect(readPlan(db, invented.planId)).toMatchObject({
      status: "draft",
      topics: [{ title: "Limiti", grounding: "general" }],
    });
    db.close();
  });
  it("marks a plan built from material ready", async () => {
    const db = openDatabase(":memory:");
    db.prepare(
      "INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES ('default', ?, 1)",
    ).run(JSON.stringify({ provider: "claude", model: "claude-sonnet-5" }));
    const sourceId = source(db);
    const run: GenerateInput["run"] = async (input) =>
      input.system?.startsWith("Write")
        ? response({ markdown: "Il moto [P1]." })
        : response(diagnostic(input.prompt));
    const runner = createRunner(db, () => {});
    registerPlanJobs(db, runner, run);
    const built = enqueuePlan(db, runner, { title: "Fisica", sourceIds: [sourceId] });
    await until(db, built.planId, "succeeded");
    expect(readPlan(db, built.planId)).toMatchObject({
      status: "ready",
      topics: [{ grounding: "sources" }],
    });
    db.close();
  });
});
