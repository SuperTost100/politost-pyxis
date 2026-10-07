import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { openDatabase } from "../db/connection";
import type { EngineResult } from "../engine/funnel";
import { saveProfile } from "../profile/profile";
import { setPlanEducation } from "../plans/education";
import { importSmartbook } from "../sources/smartbook";
import { askTurn, chatContext, chatPlan, chatScope, readChat, seedChat } from "./turn";

const reply: EngineResult = {
  text: "Il vettore descrive il punto [P1].\n<followups>\nUno?\nDue?\nTre?\n</followups>",
  model: "gpt-6.1-sol",
  provider: "codex",
  inputTokens: 1,
};

function setup() {
  const db = openDatabase(":memory:");
  db.prepare(
    "INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES ('default', ?, 1)",
  ).run(JSON.stringify({ provider: "claude", model: "claude-sonnet-5" }));
  const { sourceId } = importSmartbook(
    db,
    zipSync({
      "smartbook.json": strToU8(
        JSON.stringify({
          id: "v",
          title: "Vectors",
          access: "public",
          chapters: [{ id: "c1", number: 1, title: "Vectors", file: "01.md" }],
        }),
      ),
      "chapters/01.md": strToU8(
        "## p1 | Posizione\nIl vettore posizione descrive il punto.\n",
      ),
    }),
  );
  return { db, sourceId };
}

const question = "Che cos'è il vettore posizione?";

async function systemFor(
  db: ReturnType<typeof setup>["db"],
  input: Parameters<typeof askTurn>[1],
) {
  let system = "";
  const result = await askTurn(db, {
    ...input,
    run: async (call) => {
      system = call.system ?? "";
      return reply;
    },
  });
  return { system, result };
}

describe("profile context in the tutor prompt", () => {
  it("PER-01 and PER-04: year, school and interests reach the prompt, and the switch removes the interests", async () => {
    const { db, sourceId } = setup();
    saveProfile(db, {
      displayName: "Ada",
      year: "2nd year",
      school: "Politecnico",
      course: "Fisica 1",
      interests: ["ciclismo", "scacchi"],
    });
    const on = await systemFor(db, { text: question, sourceIds: [sourceId] });
    expect(on.system).toContain("Year: 2nd year.");
    expect(on.system).toContain("School: Politecnico.");
    expect(on.system).toContain("prefer contexts from: ciclismo, scacchi.");
    saveProfile(db, { interestsOn: false });
    const off = await systemFor(db, { text: question, sourceIds: [sourceId] });
    expect(off.system).not.toContain("ciclismo");
    expect(off.system).toContain("Year: 2nd year.");
    db.close();
  });

  it("ASK-09: the student's name is not sent; level, year, school, course and interests are", async () => {
    const { db, sourceId } = setup();
    saveProfile(db, {
      displayName: "Ada Lovelace",
      educationLevel: "technical",
      year: "2nd year",
      school: "Politecnico",
      course: "Fisica 1",
      interests: ["ciclismo"],
    });
    const { system } = await systemFor(db, { text: question, sourceIds: [sourceId] });
    expect(system).not.toContain("Ada");
    expect(system).not.toContain("Lovelace");
    expect(system).not.toContain("Student:");
    expect(system).toContain("Level: technical. Year: 2nd year. School: Politecnico. Course: Fisica 1.");
    expect(system).toContain("prefer contexts from: ciclismo.");
    db.close();
  });

  it("PER-01: year and the follow-up switch survive a save and read", () => {
    const db = openDatabase(":memory:");
    saveProfile(db, { year: "3", followups: false });
    const again = saveProfile(db, { displayName: "Ada" });
    expect(again.year).toBe("3");
    expect(again.followups).toBe(false);
    db.close();
  });
});

describe("tutor mode and follow-ups", () => {
  it("ASK-02: the saved default mode applies when the turn names none, and an explicit mode wins", async () => {
    const { db, sourceId } = setup();
    saveProfile(db, { tutorMode: "socratic" });
    const byDefault = await systemFor(db, { text: question, sourceIds: [sourceId] });
    expect(byDefault.system).toContain("Do not give the final answer.");
    const explicit = await systemFor(db, {
      text: question,
      sourceIds: [sourceId],
      mode: "solver",
    });
    expect(explicit.system).not.toContain("Do not give the final answer.");
    db.close();
  });

  it("ASK-03: with the switch off the instruction, the stored chips and the chat view carry no follow-ups", async () => {
    const { db, sourceId } = setup();
    const on = await systemFor(db, { text: question, sourceIds: [sourceId] });
    expect(on.system).toContain("<followups>");
    expect(on.result.message?.followups).toHaveLength(3);
    saveProfile(db, { followups: false });
    expect(readChat(db, on.result.chatId).at(-1)?.followups).toEqual([]);
    const off = await systemFor(db, { text: question, sourceIds: [sourceId] });
    expect(off.system).not.toContain("<followups>");
    expect(off.result.message?.followups).toEqual([]);
    expect(off.result.message?.body).not.toContain("<followups>");
    saveProfile(db, { followups: true });
    expect(readChat(db, on.result.chatId).at(-1)?.followups).toHaveLength(3);
    db.close();
  });
});

describe("plan-scoped chat", () => {
  function plan(db: ReturnType<typeof setup>["db"], sourceId?: string) {
    db.prepare(
      `INSERT INTO plans (id, title, status, content_language, created_at, updated_at)
       VALUES ('plan', 'Physics', 'ready', 'en', 1, 1)`,
    ).run();
    if (sourceId)
      db.prepare(
        `INSERT INTO plan_sources (plan_id, source_id) VALUES ('plan', ?)`,
      ).run(sourceId);
  }

  it("keeps a selected lesson's plan scope and quote for the next tutor turn", async () => {
    const { db, sourceId } = setup();
    plan(db, sourceId);
    const seeded = seedChat(db, {
      planId: "plan", kind: "passage", title: "Position", body: "The selected paragraph.",
    });
    expect(chatPlan(db, seeded.chatId)).toBe("plan");
    expect(chatScope(db, seeded.chatId)).toEqual([sourceId]);
    expect(chatContext(db, seeded.chatId)?.body).toBe("The selected paragraph.");
    const next = await systemFor(db, { chatId: seeded.chatId, text: question });
    expect(next.result.covered).toBe(true);
    expect(next.system).toContain("Plan: Physics.");
    expect(next.system).toContain("Write all output in English.");
    const count = db.prepare("SELECT COUNT(*) AS n FROM chats").get();
    expect(() => seedChat(db, {
      planId: "missing", kind: "passage", title: "Position", body: "Quote",
    })).toThrow("plan-missing");
    expect(db.prepare("SELECT COUNT(*) AS n FROM chats").get()).toEqual(count);
    db.close();
  });

  it("ASK-07 and ASK-09: the plan sets the sources and the language, and sticks for the next turn", async () => {
    const { db, sourceId } = setup();
    plan(db, sourceId);
    const first = await systemFor(db, { text: question, planId: "plan" });
    expect(first.result.covered).toBe(true);
    expect(first.system).toContain("Write all output in English.");
    expect(first.system).toContain("Plan: Physics.");
    expect(chatPlan(db, first.result.chatId)).toBe("plan");
    expect(chatScope(db, first.result.chatId)).toEqual([sourceId]);
    const next = await systemFor(db, { text: question, chatId: first.result.chatId });
    expect(next.system).toContain("Plan: Physics.");
    const cleared = await systemFor(db, {
      text: question,
      chatId: first.result.chatId,
      planId: null,
      sourceIds: [sourceId],
    });
    expect(cleared.system).not.toContain("Plan: Physics.");
    expect(chatPlan(db, first.result.chatId)).toBeNull();
    db.close();
  });

  it("ASK-09: a plan-scoped chat uses the plan's level, an unscoped chat the profile's", async () => {
    const { db, sourceId } = setup();
    saveProfile(db, { educationLevel: "university" });
    plan(db, sourceId);
    setPlanEducation(db, "plan", "lower-secondary");
    const scoped = await systemFor(db, { text: question, planId: "plan" });
    expect(scoped.system).toContain("Level: lower-secondary.");
    expect(scoped.system).not.toContain("Level: university.");
    const loose = await systemFor(db, { text: question, sourceIds: [sourceId] });
    expect(loose.system).toContain("Level: university.");
    db.close();
  });

  it("ASK-07: a plan with no sources never searches the whole library", async () => {
    const { db } = setup();
    plan(db);
    let prompt = "";
    const result = await askTurn(db, {
      text: question,
      planId: "plan",
      run: async (input) => {
        prompt = input.prompt;
        return reply;
      },
    });
    // The question is answered, but no library passage is sent and the reply is marked as not from the sources.
    expect(result.covered).toBe(true);
    expect(prompt).not.toContain("[P1]");
    expect(result.message?.grounding).toBe("general");
    db.close();
  });
});
