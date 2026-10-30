import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { closeFunnel, runTurn, setScratch } from "../engine/funnel";
import { createPlan } from "../plans/create";
import { importSmartbook } from "../sources/smartbook";
import { tempDir } from "../test-temp";
import { smartSections } from "../../shared/smart-text";
import { agentLesson } from "./agentLesson";
import { writeLesson } from "./openLesson";

/**
 * The comparison in docs/agent-lesson.md: the same topics written by the pipeline and by the agent loop on a signed-in
 * engine. It spends subscription usage, so it runs only with PYXIS_LIVE_LESSON_COMPARE=1 and a free book package:
 *
 *   PYXIS_LIVE_LESSON_COMPARE=1 PYXIS_LIVE_BOOK=fisica-1.ptsb PYXIS_LIVE_CHAPTERS=1,4,5 \
 *   PYXIS_LIVE_ENGINE=codex/gpt-5.6-terra/medium PYXIS_LIVE_OUT=.tmp/lesson-compare npm test -- src/core/study/agentLesson.live.test.ts
 *
 * PYXIS_LIVE_APPROACH=pipeline or agent runs one side only. Each lesson, its stats and the cited passages go to
 * PYXIS_LIVE_OUT for reading.
 */
const live = process.env["PYXIS_LIVE_LESSON_COMPARE"] === "1";

describe.skipIf(!live)("lesson pipeline vs agent, live", () => {
  it("writes each topic both ways and records the numbers", { timeout: 90 * 60_000 }, async () => {
    const out = process.env["PYXIS_LIVE_OUT"] ?? ".tmp/lesson-compare";
    mkdirSync(out, { recursive: true });
    setScratch(tempDir("pyxis-live-scratch-"));
    const [provider, model, effort] = (process.env["PYXIS_LIVE_ENGINE"] ?? "codex/gpt-5.6-terra/medium").split("/");
    const db = openDatabase(":memory:");
    db.prepare(
      "INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES ('default', ?, 1)",
    ).run(JSON.stringify({ provider, model, ...(effort ? { effort } : {}) }));
    const book = importSmartbook(db, readFileSync(process.env["PYXIS_LIVE_BOOK"]!));
    const plan = createPlan(db, { title: "Fisica 1", sourceIds: [book.sourceId], language: "it" });
    const topics = db
      .prepare("SELECT id, title FROM topics WHERE plan_id = ? ORDER BY position")
      .all(plan.planId) as Array<{ id: string; title: string }>;
    const chapters = (process.env["PYXIS_LIVE_CHAPTERS"] ?? "1,4,5").split(",").map(Number);
    const approaches = (process.env["PYXIS_LIVE_APPROACH"] ?? "pipeline,agent").split(",");
    const passage = db.prepare("SELECT text, section_path FROM passages WHERE id = ?");
    const rows: unknown[] = [];
    try {
      for (const chapter of chapters) {
        const topic = topics[chapter - 1]!;
        for (const approach of approaches) {
          let calls = 0;
          let inputTokens = 0;
          let outputTokens = 0;
          const counted: typeof runTurn = async (input) => {
            calls += 1;
            const result = await runTurn(input);
            inputTokens += result.inputTokens;
            outputTokens += result.outputTokens ?? 0;
            return result;
          };
          const started = Date.now();
          let firstSectionMs: number | null = null;
          const onDelta = (text: string) => {
            if (firstSectionMs == null && smartSections(text).length >= 2) firstSectionMs = Date.now() - started;
          };
          let markdown: string;
          let passageIds: string[];
          let extra: Record<string, unknown> = {};
          if (approach === "pipeline") {
            const lesson = await writeLesson(db, plan.planId, topic.id, counted, { python: null, onDelta, regenerate: true });
            expect(lesson.fallback).toBeFalsy();
            ({ markdown, passageIds } = lesson);
          } else {
            const { lesson, stats } = await agentLesson(db, plan.planId, topic.id, counted, { python: null, onDelta });
            ({ markdown, passageIds } = lesson);
            const { log, ...rest } = stats;
            extra = rest;
            writeFileSync(join(out, `${chapter}-agent-tools.txt`), log.join("\n"));
          }
          const row = {
            chapter,
            topic: topic.title,
            approach,
            totalMs: Date.now() - started,
            firstSectionMs,
            modelCalls: calls,
            inputTokens,
            outputTokens,
            sections: smartSections(markdown).length,
            citationMarkers: (markdown.match(/\[P\d+\]/g) ?? []).length,
            passagesLinked: passageIds.length,
            topicChars: (
              db
                .prepare("SELECT sum(length(p.text)) AS n FROM topic_passages tp JOIN passages p ON p.id = tp.passage_id WHERE tp.topic_id = ?")
                .get(topic.id) as { n: number }
            ).n,
            ...extra,
          };
          rows.push(row);
          console.log(JSON.stringify(row));
          writeFileSync(join(out, `${chapter}-${approach}.md`), markdown);
          if (approach === "agent")
            writeFileSync(
              join(out, `${chapter}-agent-cited.md`),
              passageIds
                .map((id, index) => {
                  const cited = passage.get(id) as { text: string; section_path: string | null };
                  return `### [P${index + 1}] ${cited.section_path ?? ""}\n\n${cited.text}`;
                })
                .join("\n\n"),
            );
        }
      }
    } finally {
      writeFileSync(join(out, "results.json"), JSON.stringify(rows, null, 2));
      closeFunnel();
    }
  });
});
