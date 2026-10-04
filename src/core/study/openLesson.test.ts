import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { createPlan } from "../plans/create";
import { importSmartbook } from "../sources/smartbook";
import { partialText, templateVersion } from "../engine/prompts";
import { citationsValid, openLesson, writeLesson } from "./openLesson";
import { exportMarkdown } from "../share/markdown";

function pack(files: Record<string, string>): Uint8Array {
  return zipSync(
    Object.fromEntries(
      Object.entries(files).map(([name, text]) => [name, strToU8(text)]),
    ),
  );
}

describe("openLesson", () => {
  it("returns the chapter text and the same text on the second open", () => {
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
        "chapters/01.md": "## p1 | Energia\nIl vettore sposta il punto.\n",
        "esercizi.md": "",
      }),
    );
    const plan = createPlan(db, {
      title: "Fisica 1",
      sourceIds: [imported.sourceId],
    });
    const topic = db
      .prepare(`SELECT id FROM topics WHERE plan_id = ?`)
      .get(plan.planId) as {
      id: string;
    };
    const first = openLesson(db, plan.planId, topic.id);
    const second = openLesson(db, plan.planId, topic.id);
    expect(first.markdown).toContain("Il vettore");
    expect(first.passageIds.length).toBeGreaterThan(0);
    expect(second).toEqual(first);
    const rows = db
      .prepare(`SELECT COUNT(*) AS n FROM items WHERE kind = 'lesson'`)
      .get() as {
      n: number;
    };
    expect(rows.n).toBe(1);
  });

  it("does not cache a failed model lesson under the model key", async () => {
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
        "chapters/01.md": "## p1 | Energia\nIl vettore sposta il punto.\n",
        "esercizi.md": "",
      }),
    );
    const plan = createPlan(db, {
      title: "Fisica 1",
      sourceIds: [imported.sourceId],
    });
    const topic = db
      .prepare(`SELECT id FROM topics WHERE plan_id = ?`)
      .get(plan.planId) as {
      id: string;
    };
    db.prepare(
      "INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES ('default', ?, 1)",
    ).run(JSON.stringify({ provider: "claude", model: "test-model" }));
    let attempted = false;
    const failing = (async () => {
      attempted = true;
      throw new Error("offline");
    }) as unknown as Parameters<typeof writeLesson>[3];
    const result = await writeLesson(db, plan.planId, topic.id, failing);
    expect(attempted).toBe(true);
    expect(result.fallback).toBe(true);
    expect(result.markdown).toContain("Il vettore");
    const rows = db
      .prepare(
        `SELECT COUNT(*) AS n FROM items WHERE kind = 'lesson' AND json_extract(body_json, '$.cacheKey') LIKE '%${templateVersion("lesson.write")}%'`,
      )
      .get() as { n: number };
    expect(rows.n).toBe(0);
  });
});

it("caches lessons per wording and education, bounds the context, regenerates safely and labels general knowledge", async () => {
  const db = openDatabase(":memory:");
  try {
    db.prepare(
      "INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES ('default', ?, 1)",
    ).run(JSON.stringify({ provider: "claude", model: "selected-model" }));
    db.prepare("DELETE FROM profile").run();
    db.prepare(
      "INSERT INTO profile (id, education_level, created_at, updated_at) VALUES ('me', 'primary', 1, 1)",
    ).run();
    db.exec(`
      INSERT INTO plans (id,title,status,created_at,updated_at) VALUES ('plan','Physics','ready',1,1);
      INSERT INTO topics (id,plan_id,title,position,created_at) VALUES ('topic','plan','Motion',0,1), ('empty','plan','Free fall',1,1);
      INSERT INTO sources (id,title,kind,status,created_at,updated_at) VALUES ('source','Notes','txt','ready',1,1);
      INSERT INTO source_documents (id,source_id,version,tree_json,created_at) VALUES ('doc','source',1,'{}',1);
    `);
    for (let i = 0; i < 10; i++) {
      db.prepare(
        "INSERT INTO passages (id,source_id,document_id,text,created_at) VALUES (?,?,?,?,?)",
      ).run(`p${i}`, "source", "doc", "x".repeat(5000), i + 1);
      db.prepare(
        "INSERT INTO topic_passages (topic_id,passage_id) VALUES ('topic',?)",
      ).run(`p${i}`);
    }
    const calls: Array<{ system: string; prompt: string }> = [];
    let text = "Motion is change of place [P1].";
    let fail = false;
    const run: Parameters<typeof writeLesson>[3] = async (input) => {
      calls.push({ system: input.system ?? "", prompt: input.prompt });
      if (fail) throw new Error("offline");
      return { text, provider: "claude", model: "m", inputTokens: 1 };
    };

    const simple = await writeLesson(db, "plan", "topic", run, {
      wording: "simple",
    });
    expect(simple.wording).toBe("simple");
    expect(simple.passageIds).toHaveLength(6);
    expect(calls[0]!.prompt).toContain("[P6]");
    expect(calls[0]!.prompt).not.toContain("[P7]");
    expect(calls[0]!.prompt.length).toBeLessThan(25_000);
    expect(calls[0]!.system).toContain("Wording: simple");
    expect(calls[0]!.system).toContain("education level: primary");

    await writeLesson(db, "plan", "topic", run, { wording: "technical" });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.system).toContain("Wording: technical");
    const again = await writeLesson(db, "plan", "topic", run, {
      wording: "simple",
    });
    expect(calls).toHaveLength(2);
    expect(again).toEqual(simple);

    text = "Rewritten [P2].";
    const rewritten = await writeLesson(db, "plan", "topic", run, {
      wording: "simple",
      regenerate: true,
    });
    expect(calls).toHaveLength(3);
    expect(rewritten.markdown).toBe("Rewritten [P2].");
    expect(rewritten.itemId).toBe(simple.itemId);

    fail = true;
    await expect(
      writeLesson(db, "plan", "topic", run, {
        wording: "simple",
        regenerate: true,
      }),
    ).rejects.toThrow("offline");
    fail = false;
    expect(
      (await writeLesson(db, "plan", "topic", run, { wording: "simple" }))
        .markdown,
    ).toBe("Rewritten [P2].");

    text = "Everything falls at the same rate.";
    const general = await writeLesson(db, "plan", "empty", run);
    expect(general.general).toBe(true);
    expect(calls.at(-1)!.system).toContain("general knowledge");
    expect(
      db
        .prepare("SELECT grounding FROM items WHERE id = ?")
        .get(general.itemId),
    ).toEqual({ grounding: "general" });
    expect((await writeLesson(db, "plan", "empty", run)).general).toBe(true);
  } finally {
    db.close();
  }
});

describe("citationsValid", () => {
  it("requires at least one citation and rejects out-of-range indices", () => {
    expect(citationsValid("Testo [P1] e [P2]", 2)).toBe(true);
    expect(citationsValid("Nessuna citazione", 2)).toBe(false);
    expect(citationsValid("Testo [P3]", 2)).toBe(false);
    expect(citationsValid("Testo [P0]", 2)).toBe(false);
  });
});

it("rejects invalid citations without poisoning a later generated lesson and keeps provenance", async () => {
  const db = openDatabase(":memory:");
  try {
    db.prepare(
      "INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES ('default', ?, 1)",
    ).run(JSON.stringify({ provider: "claude", model: "selected-model" }));
    db.exec(`
      INSERT INTO plans (id,title,status,created_at,updated_at) VALUES ('plan','Physics','ready',1,1);
      INSERT INTO topics (id,plan_id,title,position,created_at) VALUES ('topic','plan','Motion',0,1);
      INSERT INTO sources (id,title,kind,status,created_at,updated_at) VALUES ('source','Notes','txt','ready',1,1);
      INSERT INTO source_documents (id,source_id,version,tree_json,created_at) VALUES ('doc','source',1,'{}',1);
      INSERT INTO passages (id,source_id,document_id,text,created_at) VALUES ('passage','source','doc','Velocity is displacement divided by time.',1);
      INSERT INTO topic_passages (topic_id,passage_id) VALUES ('topic','passage');
    `);
    let calls = 0;
    const systems: string[] = [];
    const run: Parameters<typeof writeLesson>[3] = async (input) => {
      calls++;
      systems.push(input.system ?? "");
      return {
        text:
          calls === 1
            ? "Incorrect index [P2]."
            : "Velocity describes displacement per time [P1].",
        provider: "claude",
        model: "reported-model",
        inputTokens: 1,
      };
    };
    const fallback = await writeLesson(db, "plan", "topic", run);
    expect(fallback.markdown).toContain("divided by time");
    expect(
      db
        .prepare("SELECT id FROM items WHERE engine_provider IS NOT NULL")
        .all(),
    ).toEqual([]);
    const generated = await writeLesson(db, "plan", "topic", run);
    expect(generated.markdown).toContain("[P1]");
    expect(await writeLesson(db, "plan", "topic", run)).toEqual(generated);
    expect(calls).toBe(2);
    const itemCount = db.prepare("SELECT COUNT(*) AS n FROM items").get();
    const exported = exportMarkdown(db, {
      planId: "plan",
      topicId: "topic",
      kind: "lesson",
    });
    expect(exported.markdown).toContain(generated.markdown);
    expect(db.prepare("SELECT COUNT(*) AS n FROM items").get()).toEqual(
      itemCount,
    );
    expect(systems[0]).toContain("Write all output in Italian.");
    expect(systems[0]).toContain(partialText("citation"));
    expect(systems[0]).not.toMatch(/\{\{[A-Za-z]/);
    expect(
      db
        .prepare(
          "SELECT engine_provider, model_id, model_source, prompt_template, prompt_version FROM items WHERE engine_provider IS NOT NULL",
        )
        .get(),
    ).toEqual({
      engine_provider: "claude",
      model_id: "reported-model",
      model_source: "reported",
      prompt_template: "lesson.write",
      prompt_version: templateVersion("lesson.write"),
    });
    db.prepare("DELETE FROM feature_engines").run();
    db.prepare("DELETE FROM items WHERE kind = 'lesson'").run();
    await expect(writeLesson(db, "plan", "topic", run)).rejects.toMatchObject({
      code: "engine-missing",
    });
    db.prepare(
      "INSERT INTO feature_engines (feature,selection_json,updated_at) VALUES ('default',?,1)",
    ).run(JSON.stringify({ provider: "claude", model: "selected-model" }));
    const abort = new AbortController();
    const streamed: string[] = [];
    const passageEvents: string[][] = [];
    await expect(
      writeLesson(
        db,
        "plan",
        "topic",
        async (input) => {
          input.onDelta?.("Partial [P1]");
          abort.abort();
          return {
            text: "Late completed [P1]",
            provider: "claude",
            model: "reported-model",
            inputTokens: 1,
          };
        },
        {
          signal: abort.signal,
          onDelta: (text) => streamed.push(text),
          onPassages: (ids) => passageEvents.push(ids),
        },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(streamed).toEqual(["Partial [P1]"]);
    expect(passageEvents).toEqual([["passage"]]);
    expect(
      db.prepare("SELECT id FROM items WHERE kind='lesson'").all(),
    ).toEqual([]);
  } finally {
    db.close();
  }
});
