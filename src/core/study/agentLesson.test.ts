import { describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db/connection";
import { partialText } from "../engine/prompts";
import type { TurnInput } from "../engine/funnel";
import {
  agentLesson,
  agentSystem,
  citeLesson,
  studyTools,
  toolRequest,
  writeAgentLesson,
} from "./agentLesson";
import { modelContext } from "./openLesson";
import { studyHandlers } from "./handlers";

type Run = NonNullable<Parameters<typeof agentLesson>[3]>;

/** A plan with one topic of three passages in two sections, a passage of the plan outside the topic, and a source outside the plan. */
function fixture(): Database.Database {
  const db = openDatabase(":memory:");
  db.prepare(
    "INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES ('default', ?, 1)",
  ).run(JSON.stringify({ provider: "codex", model: "fake-model" }));
  db.exec(`
    INSERT INTO plans (id,title,status,created_at,updated_at) VALUES ('plan','Fisica','ready',1,1);
    INSERT INTO topics (id,plan_id,title,position,created_at) VALUES ('topic','plan','Energia',0,1);
    INSERT INTO sources (id,title,kind,status,created_at,updated_at) VALUES ('book','Fisica 1','smartbook','ready',1,1), ('other','Appunti','txt','ready',1,1);
    INSERT INTO plan_sources (plan_id, source_id) VALUES ('plan','book');
    INSERT INTO source_documents (id,source_id,version,tree_json,created_at) VALUES ('doc','book',1,'{}',1), ('doc2','other',1,'{}',1);
  `);
  const passage = db.prepare(
    "INSERT INTO passages (id,source_id,document_id,text,section_path,created_at) VALUES (?,?,?,?,?,?)",
  );
  passage.run("a", "book", "doc", "L'energia cinetica vale K = mv^2/2.", "Energia cinetica", 1);
  passage.run("b", "book", "doc", "Il teorema dell'energia cinetica: il lavoro totale è la variazione di K.", "Energia cinetica", 2);
  passage.run("c", "book", "doc", "Una forza è conservativa se il suo lavoro non dipende dal cammino.", "Forze conservative", 3);
  passage.run("d", "book", "doc", "Esempio: un blocco scende lungo un piano inclinato senza attrito e la sua energia meccanica si conserva.", "Esempi", 4);
  passage.run("x", "other", "doc2", "Appunti privati: energia meccanica e piano inclinato con attrito.", "Altro", 5);
  const link = db.prepare("INSERT INTO topic_passages (topic_id, passage_id) VALUES ('topic', ?)");
  for (const id of ["a", "b", "c"]) link.run(id);
  return db;
}

const tool = (calls: unknown[]) => "```pyxis-tool\n" + JSON.stringify({ calls }) + "\n```";

/** A fake engine that answers with the scripted replies in order and records every turn it gets. */
function scripted(replies: Array<string | ((input: TurnInput) => string)>) {
  const turns: TurnInput[] = [];
  const run: Run = async (input) => {
    turns.push(input);
    const next = replies[Math.min(turns.length - 1, replies.length - 1)]!;
    const text = typeof next === "function" ? next(input) : next;
    // Streams in two pieces, as a real engine does.
    input.onDelta?.(text.slice(0, Math.ceil(text.length / 2)));
    input.onDelta?.(text);
    return { text, provider: "codex", model: "fake-model", inputTokens: 1 };
  };
  return { run, turns };
}

const LESSON =
  "## Energia cinetica\n\nL'energia cinetica è K = mv^2/2 [P1]. Il lavoro totale la cambia [P2, P9].\n\n## Forze conservative\n\nIl lavoro non dipende dal cammino [P3].";

describe("agent lesson loop", () => {
  it("runs the tool calls, sends the results back in the same conversation and saves a cited lesson", async () => {
    const db = fixture();
    const { run, turns } = scripted([
      tool([{ tool: "read_section", section: "Energia cinetica" }, { tool: "search", query: "piano inclinato" }]),
      tool([{ tool: "read", labels: ["P3"] }]),
      LESSON,
    ]);
    const deltas: string[] = [];
    const passages: string[][] = [];
    const { lesson, stats } = await agentLesson(db, "plan", "topic", run, {
      python: null,
      onDelta: (text) => deltas.push(text),
      onPassages: (ids) => passages.push(ids),
    });

    // The first turn carries the outline; the model sees labels, not passage ids.
    expect(turns[0]!.prompt).toContain("- Energia cinetica (");
    expect(turns[0]!.prompt).toContain("  P1: L'energia cinetica vale K = mv^2/2.\n  P2: Il teorema");
    expect(turns[0]!.prompt).toContain("- Forze conservative (");
    expect(turns[0]!.prompt).toContain("  P3: Una forza è conservativa");
    // Later turns continue the conversation: the follow-up holds only the results, the prompt the whole transcript.
    const key = turns[0]!.conversation!.key;
    expect(turns.every((turn) => turn.conversation?.key === key)).toBe(true);
    expect(turns[1]!.conversation!.followUp).toMatch(/^Tool results \(calls left: 14\)/);
    expect(turns[1]!.conversation!.followUp).toContain("K = mv^2/2");
    expect(turns[1]!.conversation!.followUp).toContain("Il teorema dell'energia cinetica");
    // Search reaches the plan's sources outside the topic, never a source outside the plan.
    expect(turns[1]!.conversation!.followUp).toContain("piano inclinato senza attrito");
    expect(turns[1]!.conversation!.followUp).not.toContain("Appunti privati");
    expect(turns[2]!.prompt).toContain(turns[1]!.conversation!.followUp);
    expect(turns[2]!.conversation!.followUp).toContain("forza è conservativa");

    // P9 was never shown, so it is dropped; the rest become the lesson's own numbering.
    expect(lesson.markdown).toBe(
      "## Energia cinetica\n\nL'energia cinetica è K = mv^2/2 [P1]. Il lavoro totale la cambia [P2].\n\n## Forze conservative\n\nIl lavoro non dipende dal cammino [P3].",
    );
    expect(lesson.passageIds).toEqual(["a", "b", "c"]);
    expect(stats).toMatchObject({ modelCalls: 3, toolCalls: 3, refusedCalls: 0, cited: 3, dropped: ["P9"], sections: 2 });
    expect(stats.firstSectionMs).not.toBeNull();

    // Tool requests never reach the page; the lesson streams with its chips and the passages they open.
    expect(deltas.some((text) => text.includes("pyxis-tool"))).toBe(false);
    expect(deltas.at(-1)).toBe(lesson.markdown);
    expect(passages.at(-1)).toEqual(["a", "b", "c"]);

    // Stored like a model lesson, and the next open reads it without a model call.
    const row = db
      .prepare("SELECT engine_provider, model_id, prompt_template, grounding FROM items WHERE id = ?")
      .get(lesson.itemId) as Record<string, string>;
    expect(row).toEqual({ engine_provider: "codex", model_id: "fake-model", prompt_template: "lesson.agent", grounding: "sources" });
    const again = await writeAgentLesson(db, "plan", "topic", run, { python: null });
    expect(turns).toHaveLength(3);
    expect(again.markdown).toBe(lesson.markdown);
    expect(again.passageIds).toEqual(["a", "b", "c"]);
  });

  it("refuses malformed requests, unknown tools, bad arguments, unseen labels and extra calls, and goes on", async () => {
    const db = fixture();
    const { run, turns } = scripted([
      "```pyxis-tool\n{\"calls\": [{\"tool\": \"read\",}]}\n```",
      tool([
        { tool: "shell", command: "cat ~/.ssh/id_rsa" },
        { tool: "search" },
        { tool: "read", labels: ["P42"] },
        { tool: "read_section", section: "Nessuna" },
        { tool: "read", labels: ["P1"] },
      ]),
      "## Energia\n\nK = mv^2/2 [P1].",
    ]);
    const { lesson, stats } = await agentLesson(db, "plan", "topic", run, { python: null });
    const first = turns[1]!.conversation!.followUp;
    expect(first).toContain("refused: The pyxis-tool block is not valid JSON");
    const second = turns[2]!.conversation!.followUp;
    expect(second).toContain('[1] shell: refused: unknown tool "shell"');
    expect(second).toContain("[2] search: refused: bad arguments for search");
    expect(second).toContain("[3] read: refused: unknown label P42");
    expect(second).toContain('[4] read_section: refused: no section named "Nessuna"');
    expect(second).toContain("[5] refused: at most 4 calls per reply.");
    // A refused call still counts, so a model that keeps getting it wrong runs out.
    expect(second).toMatch(/calls left: 11\)/);
    expect(stats).toMatchObject({ toolCalls: 0, refusedCalls: 6 });
    // P1 was only in the outline (its read was refused), so it cannot be cited.
    expect(lesson.markdown).toBe("## Energia\n\nK = mv^2/2.");
    expect(lesson.passageIds).toEqual([]);
    expect(stats.dropped).toEqual(["P1"]);
  });

  it("stops at the tool-call cap, then at the turn cap, and falls back to the book", async () => {
    const db = fixture();
    const { run, turns } = scripted([tool([{ tool: "list_sections" }])]);
    await expect(
      agentLesson(db, "plan", "topic", run, { python: null, limits: { calls: 2, turns: 5 } }),
    ).rejects.toMatchObject({ code: "agent-limit" });
    expect(turns).toHaveLength(5);
    expect(turns[2]!.conversation!.followUp).toContain("calls left: 0");
    expect(turns[2]!.conversation!.followUp).toContain("No more tool calls: write the lesson now");
    expect(turns[3]!.conversation!.followUp).toContain("[1] refused: no tool calls left.");
    // The last allowed reply is told it must be the lesson even while calls remain.
    const many = scripted([tool([{ tool: "list_sections" }])]);
    await expect(
      agentLesson(db, "plan", "topic", many.run, { python: null, limits: { turns: 3 } }),
    ).rejects.toMatchObject({ code: "agent-limit" });
    expect(many.turns).toHaveLength(3);
    expect(many.turns[1]!.conversation!.followUp).not.toContain("No more tool calls");
    expect(many.turns[2]!.conversation!.followUp).toContain("No more tool calls");

    const fallback = await writeAgentLesson(db, "plan", "topic", run, { python: null, limits: { calls: 2, turns: 5 } });
    expect(fallback.fallback).toBe(true);
    expect(fallback.markdown).toContain("K = mv^2/2");
  });

  it("stops at the time limit, and tells it apart from the student's Stop", async () => {
    const db = fixture();
    const hang: Run = (input) =>
      new Promise((_, reject) => {
        const stop = () => reject(new DOMException("stopped", "AbortError"));
        if (input.signal?.aborted) stop();
        else input.signal?.addEventListener("abort", stop);
      });
    await expect(
      agentLesson(db, "plan", "topic", hang, { python: null, limits: { timeMs: 30 } }),
    ).rejects.toMatchObject({ code: "agent-timeout" });
    const stop = new AbortController();
    const stopped = agentLesson(db, "plan", "topic", hang, { python: null, signal: stop.signal });
    stop.abort();
    await expect(stopped).rejects.not.toMatchObject({ code: "agent-timeout" });
    await expect(writeAgentLesson(db, "plan", "topic", hang, { python: null, signal: AbortSignal.abort() })).rejects.toThrow();
  });
});

describe("agent lesson parts", () => {
  it("reads a request from a fenced block or bare JSON, and treats anything else as the lesson", () => {
    expect(toolRequest(tool([{ tool: "list_sections" }]))).toEqual({ calls: [{ tool: "list_sections" }] });
    expect(toolRequest('{"calls": [{"tool": "read", "labels": ["P1"]}]}')).toEqual({
      calls: [{ tool: "read", labels: ["P1"] }],
    });
    expect(toolRequest("```pyxis-tool\n{\"calls\": []")).toMatchObject({ error: expect.stringContaining("not closed") });
    expect(toolRequest("```pyxis-tool\n{\"calls\": []}\n```")).toMatchObject({ error: expect.stringContaining("at least one call") });
    expect(toolRequest("## Energia\n\nTesto.")).toBeNull();
    expect(toolRequest("## Energia\n\n```pyxis-check\n{\"question\": \"?\"}\n```")).toBeNull();
  });

  it("numbers citations in order of first use, keeps groups, drops unread labels with their space", () => {
    const ids: Record<string, string> = { P2: "two", P5: "five", P7: "seven" };
    const out = citeLesson("A [P5]. B [P2; P5]. C [p7, P8]. D [P8]. E[P 2].", (label) => ids[label]);
    expect(out.markdown).toBe("A [P1]. B [P2][P1]. C [P3]. D. E[P2].");
    expect(out.passageIds).toEqual(["five", "two", "seven"]);
    expect(out.dropped).toEqual(["P8", "P8"]);
  });

  it("only lets the model cite passages whose full text a tool returned", () => {
    const db = fixture();
    const tools = studyTools(db, "plan", "topic");
    expect(tools.citable("P1")).toBeUndefined();
    tools.call({ tool: "search", query: "conservativa" });
    // A short passage comes back whole from search, so it is citable.
    expect(tools.citable("P3")).toBe("c");
    const long = studyTools(db, "plan", "topic", { calls: 1, callsPerTurn: 1, turns: 1, timeMs: 1, resultChars: 1000, passageChars: 1000, excerptChars: 10 });
    long.call({ tool: "search", query: "conservativa" });
    expect(long.citable("P3")).toBeUndefined();
    long.call({ tool: "read", labels: ["p3"] });
    expect(long.citable("P3")).toBe("c");
    // Results over the reply's budget are named, not sent, and stay uncitable.
    const tight = studyTools(db, "plan", "topic");
    const read = tight.call({ tool: "read_section", section: "energia cinetica" }, 60);
    expect(read.text).toContain("P1 (Energia cinetica):\nL'energia cinetica vale K = mv^2/2.");
    expect(read.text).toContain("Not shown, over the results limit: P2.");
    expect(tight.citable("P1")).toBe("a");
    expect(tight.citable("P2")).toBeUndefined();
  });

  it("names a section by the first heading of its text, else by its place in the source", () => {
    const db = fixture();
    db.exec(`
      INSERT INTO topics (id,plan_id,title,position,created_at) VALUES ('book','plan','Capitolo',1,1);
      INSERT INTO passages (id,source_id,document_id,text,section_path,locator_json,created_at) VALUES
        ('h1','book','doc','### Lavoro\n\nIl lavoro è F·s.','4. Lavoro','{"paragraph":"p1"}',10),
        ('h2','book','doc','Continua il paragrafo.','4. Lavoro','{"paragraph":"p1"}',11),
        ('h3','book','doc','Senza titolo.','4. Lavoro','{"paragraph":"p2"}',12);
      INSERT INTO topic_passages (topic_id, passage_id) VALUES ('book','h1'), ('book','h2'), ('book','h3');
    `);
    const outline = studyTools(db, "plan", "book").outline();
    expect(outline).toBe(
      "- Lavoro (50 characters)\n  P1: Lavoro Il lavoro è F·s.\n  P2: Continua il paragrafo.\n- 4. Lavoro p2 (13 characters)\n  P3: Senza titolo.",
    );
  });

  it("swaps the pipeline's no-citation rule for the shared citation rule", () => {
    const db = fixture();
    const system = agentSystem(modelContext(db, "plan", "topic"), false);
    expect(system).not.toContain("Do not cite sources");
    expect(system).toContain(partialText("citation"));
    expect(system).toContain("```pyxis-tool");
    expect(system).not.toContain("pyxis-figure");
  });

  it("keeps the pipeline unless the developer switch is on", async () => {
    const db = fixture();
    const { run, turns } = scripted([tool([{ tool: "read", labels: ["P1"] }]), "## Energia\n\nK [P1]."]);
    await studyHandlers(db, undefined, run).lesson({ planId: "plan", topicId: "topic" });
    expect(turns[0]!.prompt).toContain("Material:");
    expect(turns[0]!.prompt).not.toContain("Outline");
    turns.length = 0;
    const agent = await studyHandlers(db, undefined, run, undefined, { agentLesson: true }).lesson({
      planId: "plan",
      topicId: "topic",
    });
    expect(turns[0]!.prompt).toContain("Outline");
    expect(agent.citations).toHaveLength(1);
    expect(agent.passageIds).toEqual(["a"]);
  });
});
