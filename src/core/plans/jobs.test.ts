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
import { startDiagnostic } from "../study/topicQuiz";
import { readPlan } from "./create";

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
    const sourceId = source(db);
    const calls = { intro: 0, diagnostic: 0, tree: 0 };
    const run: GenerateInput["run"] = async (input) => {
      if (input.system?.startsWith("Write")) {
        calls.intro++;
        return response({ markdown: "Il moto [P1]." });
      }
      if (input.system?.startsWith("Create")) {
        calls.diagnostic++;
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
    db.close();
  });
  it("cancels a real model step and resumes the same plan", async () => {
    const db = openDatabase(":memory:");
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
              sourceSections: [{ sourceId: "pdf", section: "p. 1" }],
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
    const run: GenerateInput["run"] = async (input) => {
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
          sources: Array<{ sourceId: string; section: string; sample: string }>;
        };
        expect(content.sourceSynopses).toEqual([
          {
            sourceId: "pdf",
            synopsis: "Course sequence, concepts 0 through 599.",
          },
        ]);
        expect(content.sources).toHaveLength(600);
        expect(
          content.sources.every((section) => section.sample.length > 0),
        ).toBe(true);
        return response({
          topics: [
            {
              title: "Course",
              summary: "All concepts",
              subtopics: [],
              sourceSections: content.sources.map(({ sourceId, section }) => ({
                sourceId,
                section,
              })),
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
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM topic_passages").get(),
    ).toEqual({ n: 600 });
    db.close();
  });
});
