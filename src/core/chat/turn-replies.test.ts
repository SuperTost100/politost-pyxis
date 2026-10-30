import { strToU8, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { retrieveWithModel } from "../sources/retrieve";
import { importSmartbook } from "../sources/smartbook";
import { forgetModels, rememberModels } from "../engine/efforts";
import type { GenerateInput } from "../engine/generate";
import type { EngineResult } from "../engine/funnel";
import {
  askTurn,
  readChat,
  regenerateTurn,
  setChecksListener,
  settleChecks,
} from "./turn";

const step = "La derivata di $x^2\\sin(x)$ è $2x\\sin(x) + x^2\\cos(x)$.";
const claim = {
  kind: "derivative" as const,
  expr: "x**2*sin(x)",
  claimed: "2*x*sin(x)+x**2*cos(x)",
  vars: ["x"],
  step,
};

function chatDb() {
  const db = openDatabase(":memory:");
  db.prepare(
    "INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES ('default', ?, 1)",
  ).run(JSON.stringify({ provider: "claude", model: "claude-sonnet-5" }));
  return db;
}

const reply = (text: string, model = "claude-sonnet-5"): EngineResult => ({
  text,
  model,
  provider: "claude",
  inputTokens: 10,
});

/** A check that waits until the test lets it answer, or until it is stopped. */
function heldCheck() {
  let release: (() => void) | undefined;
  let started = 0;
  let stopped = 0;
  const run: GenerateInput["run"] = async (input) => {
    if (!input.responseSchema) {
      input.onDelta?.(step);
      return reply(step);
    }
    started += 1;
    await new Promise<void>((resolve, reject) => {
      release = resolve;
      input.signal?.addEventListener("abort", () => {
        stopped += 1;
        reject(new DOMException("aborted", "AbortError"));
      });
    });
    return { ...reply(JSON.stringify({ checks: [claim] })), structured: { checks: [claim] } };
  };
  return {
    run,
    release: () => release?.(),
    started: () => started,
    stopped: () => stopped,
  };
}

const truncated = () =>
  Object.assign(new Error("Anthropic API closed the stream before the answer finished."), {
    code: "stream-truncated",
  });

afterEach(() => setChecksListener(undefined));

describe("strongest model", () => {
  beforeEach(() => forgetModels());

  it("answers again with the plan engine at high effort and replaces the reply", async () => {
    const db = chatDb();
    db.prepare(
      "INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES ('plan', ?, 1)",
    ).run(JSON.stringify({ provider: "claude", model: "claude-opus-5", auto: true }));
    rememberModels("claude", [
      { id: "claude-sonnet-5", efforts: [{ id: "low" }, { id: "medium" }, { id: "high" }] },
      { id: "claude-opus-5", efforts: [{ id: "low" }, { id: "medium" }, { id: "high" }, { id: "max" }] },
    ]);
    const seen: Array<{ model: string; effort?: string }> = [];
    const run: GenerateInput["run"] = async (input) => {
      seen.push({ model: input.selection.model, effort: input.selection.effort });
      return reply(seen.length === 1 ? "Risposta breve." : "Risposta completa.", input.selection.model);
    };
    const first = await askTurn(db, { text: "Spiega", allowGeneral: true, run });
    const strong = await regenerateTurn(db, {
      chatId: first.chatId,
      allowGeneral: true,
      engine: "strong",
      run,
    });
    expect(seen).toEqual([
      { model: "claude-sonnet-5", effort: "low" },
      { model: "claude-opus-5", effort: "high" },
    ]);
    expect(strong.message?.modelId).toBe("claude-opus-5");
    expect(readChat(db, first.chatId).map((row) => [row.body, row.modelId])).toEqual([
      ["Spiega", null],
      ["Risposta completa.", "claude-opus-5"],
    ]);
  });

  it("keeps the plan engine's own effort while its model list is unknown", async () => {
    const db = chatDb();
    db.prepare(
      "INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES ('plan', ?, 1)",
    ).run(JSON.stringify({ provider: "codex", model: "gpt-6.1-sol", effort: "xhigh" }));
    let selection: GenerateInput["selection"] | undefined;
    const first = await askTurn(db, { text: "Spiega", allowGeneral: true, run: async () => reply("Breve.") });
    await regenerateTurn(db, {
      chatId: first.chatId,
      allowGeneral: true,
      engine: "strong",
      run: async (input) => {
        selection = input.selection;
        return reply("Lunga.");
      },
    });
    expect(selection).toMatchObject({ provider: "codex", model: "gpt-6.1-sol", effort: "xhigh" });
  });
});

describe("partial replies", () => {
  it("keeps what arrived when the engine fails mid-answer, marked with the failure", async () => {
    const db = chatDb();
    const result = await askTurn(db, {
      text: "Spiega il teorema",
      allowGeneral: true,
      run: async (input) => {
        input.onDelta?.("Il teorema dice che");
        input.onDelta?.("Il teorema dice che ogni funzione continua");
        throw truncated();
      },
    });
    expect(result.message).toMatchObject({
      body: "Il teorema dice che ogni funzione continua",
      stopped: true,
      error: "engines.errors.stream-truncated",
      checking: false,
    });
    expect(readChat(db, result.chatId).at(-1)).toMatchObject({
      stopped: true,
      error: "engines.errors.stream-truncated",
      provider: "claude",
    });
  });

  it("marks a reply the engine reports as cut off, and offers to continue it", async () => {
    for (const finishReason of ["length", "error"]) {
      const db = chatDb();
      const result = await askTurn(db, {
        text: "Stima la quantità in due modi",
        allowGeneral: true,
        run: async (input) => {
          input.onDelta?.("Si può stimare in due modi:\n1. il primo metodo");
          return { ...reply("Si può stimare in due modi:\n1. il primo metodo"), finishReason };
        },
      });
      expect(result.message, finishReason).toMatchObject({
        body: "Si può stimare in due modi:\n1. il primo metodo",
        stopped: true,
        error: "engines.errors.stream-truncated",
      });
    }
  });

  it("keeps a reply that finished normally as finished", async () => {
    const db = chatDb();
    const result = await askTurn(db, {
      text: "Spiega",
      allowGeneral: true,
      run: async () => ({ ...reply("Ecco."), finishReason: "stop" }),
    });
    expect(result.message).toMatchObject({ stopped: false, error: null });
  });

  it("still fails without saving when nothing arrived", async () => {
    const db = chatDb();
    await expect(
      askTurn(db, {
        text: "Spiega",
        allowGeneral: true,
        run: async () => {
          throw truncated();
        },
      }),
    ).rejects.toMatchObject({ messageKey: "engines.errors.stream-truncated" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE role = 'assistant'").get()).toEqual({ n: 0 });
  });

  it("continues a cut reply from where it stopped and replaces it", async () => {
    const db = chatDb();
    const cut = await askTurn(db, {
      text: "Spiega il teorema",
      allowGeneral: true,
      run: async (input) => {
        input.onDelta?.("Il teorema dice che");
        throw truncated();
      },
    });
    let prompt = "";
    const live: string[] = [];
    const continued = await regenerateTurn(db, {
      chatId: cut.chatId,
      allowGeneral: true,
      resume: true,
      onDelta: (text) => live.push(text),
      run: async (input) => {
        prompt = input.prompt;
        input.onDelta?.(" ogni funzione");
        input.onDelta?.(" ogni funzione continua ha un massimo.");
        return reply(" ogni funzione continua ha un massimo.\n<followups>\nUn esempio?\n</followups>");
      },
    });
    expect(prompt).toContain("Question:\nSpiega il teorema");
    expect(prompt).toContain("was cut off. It ends here:\nIl teorema dice che\n");
    expect(prompt).toContain("Continue from exactly where it stops.");
    expect(live.at(-1)).toBe("Il teorema dice che ogni funzione continua ha un massimo.");
    expect(continued.message).toMatchObject({
      body: "Il teorema dice che ogni funzione continua ha un massimo.",
      stopped: false,
      error: null,
      followups: ["Un esempio?"],
    });
    const rows = readChat(db, cut.chatId);
    expect(rows.map((row) => row.body)).toEqual([
      "Spiega il teorema",
      "Il teorema dice che ogni funzione continua ha un massimo.",
    ]);
  });

  it("keeps a longer cut reply when Continue fails again, and the old one when it adds nothing", async () => {
    const db = chatDb();
    const cut = await askTurn(db, {
      text: "Spiega",
      allowGeneral: true,
      run: async (input) => {
        input.onDelta?.("Primo pezzo");
        throw truncated();
      },
    });
    const again = await regenerateTurn(db, {
      chatId: cut.chatId,
      allowGeneral: true,
      resume: true,
      run: async (input) => {
        input.onDelta?.(", secondo pezzo");
        throw Object.assign(new Error("usage limit reached"), { code: "cli-failed" });
      },
    });
    expect(again.message).toMatchObject({
      body: "Primo pezzo, secondo pezzo",
      stopped: true,
      error: "engines.errors.quota",
    });
    const before = readChat(db, cut.chatId);
    expect(before).toHaveLength(2);
    await expect(
      regenerateTurn(db, {
        chatId: cut.chatId,
        allowGeneral: true,
        resume: true,
        run: async () => {
          throw truncated();
        },
      }),
    ).rejects.toMatchObject({ messageKey: "engines.errors.stream-truncated" });
    expect(readChat(db, cut.chatId)).toEqual(before);
  });

  it("keeps the earlier reply when a regenerated one fails mid-answer", async () => {
    const db = chatDb();
    const first = await askTurn(db, { text: "Spiega", allowGeneral: true, run: async () => reply("Risposta intera.") });
    const before = readChat(db, first.chatId);
    await expect(
      regenerateTurn(db, {
        chatId: first.chatId,
        allowGeneral: true,
        engine: "strong",
        run: async (input) => {
          input.onDelta?.("Risposta nuova a metà");
          throw truncated();
        },
      }),
    ).rejects.toMatchObject({ messageKey: "engines.errors.stream-truncated" });
    expect(readChat(db, first.chatId)).toEqual(before);
  });

  it("continues from the passages and numbering the cut reply was written with, even if retrieval now differs", async () => {
    const db = chatDb();
    const book = importSmartbook(
      db,
      zipSync({
        "smartbook.json": strToU8(
          JSON.stringify({
            id: "analisi",
            title: "Analisi",
            access: "public",
            chapters: [{ id: "c1", number: 1, title: "Continuità", file: "01.md" }],
          }),
        ),
        "chapters/01.md": strToU8(
          "## p1 | Weierstrass\nIl teorema di Weierstrass vale per funzioni continue.\n\n## p2 | Intervalli\nUn intervallo chiuso e limitato contiene i suoi estremi.\n",
        ),
      }),
    );
    const question = "teorema di Weierstrass intervallo chiuso";
    const prompts: string[] = [];
    const cut = await askTurn(db, {
      text: question,
      sourceIds: [book.sourceId],
      embed: null,
      run: async (input) => {
        prompts.push(input.prompt);
        input.onDelta?.("Vale su un intervallo chiuso [P2]");
        throw truncated();
      },
    });
    const before = await retrieveWithModel(db, question, { sourceIds: [book.sourceId], embed: null, limit: 12 });
    const document = db.prepare("SELECT id FROM source_documents WHERE source_id = ?").get(book.sourceId) as { id: string };
    // A passage added since then matches the question best, so a fresh retrieval numbers the passages differently.
    db.prepare(
      "INSERT INTO passages (id, source_id, document_id, text, section_path, created_at) VALUES ('late', ?, ?, ?, 'Nuovo', 2)",
    ).run(book.sourceId, document.id, "Teorema di Weierstrass: intervallo chiuso, intervallo chiuso, teorema di Weierstrass.");
    const after = await retrieveWithModel(db, question, { sourceIds: [book.sourceId], embed: null, limit: 12 });
    expect(after.hits.map((hit) => hit.id)).not.toEqual(before.hits.map((hit) => hit.id));

    const passages = (text: string) => text.match(/^\[P\d+\] [^\n]*\n[^\n]*/gm);
    const continued = await regenerateTurn(db, {
      chatId: cut.chatId,
      sourceIds: [book.sourceId],
      resume: true,
      embed: null,
      run: async (input) => {
        prompts.push(input.prompt);
        return reply(" e limitato [P1].");
      },
    });
    expect(passages(prompts[1]!)).toEqual(passages(prompts[0]!));
    expect(prompts[1]).not.toContain("Nuovo");
    const byLabel = (rows: Array<{ index: number; passageId: string }>) =>
      Object.fromEntries(rows.map((cite) => [cite.index, cite.passageId]));
    const original = before.hits.map((hit, index) => ({ index: index + 1, passageId: hit.id }));
    expect(byLabel(continued.message!.citations)).toEqual({
      1: original[0]!.passageId,
      2: original[1]!.passageId,
    });
  });

  it("only continues a reply that was cut short", async () => {
    const db = chatDb();
    const first = await askTurn(db, { text: "Spiega", allowGeneral: true, run: async () => reply("Risposta intera.") });
    await expect(
      regenerateTurn(db, { chatId: first.chatId, allowGeneral: true, resume: true, run: async () => reply("x") }),
    ).rejects.toMatchObject({ code: "nothing-to-continue" });
  });
});

describe("math check after the reply", () => {
  it("saves and returns the reply before the check ends, then attaches the badges and says so", async () => {
    const db = chatDb();
    const check = heldCheck();
    const ended: Array<{ chatId: string; messageId: string }> = [];
    setChecksListener((event) => ended.push(event));
    const result = await askTurn(db, { text: "Deriva x^2 sin x", allowGeneral: true, run: check.run });
    expect(check.started()).toBe(1);
    expect(result.message).toMatchObject({ body: step, checks: [], checking: true });
    expect(readChat(db, result.chatId).at(-1)).toMatchObject({ body: step, checks: [], checking: true });
    check.release();
    await settleChecks();
    expect(readChat(db, result.chatId).at(-1)).toMatchObject({ body: step, checks: [claim], checking: false });
    expect(ended).toEqual([{ chatId: result.chatId, messageId: result.message!.id }]);
  });

  it("does not run a check for prose or a Socratic question", async () => {
    const db = chatDb();
    const check = heldCheck();
    const prose = await askTurn(db, { text: "Cos'è un vettore?", allowGeneral: true, run: async () => reply("Una freccia.") });
    expect(prose.message?.checking).toBe(false);
    const socratic = await askTurn(db, { text: "Deriva", mode: "socratic", run: check.run });
    expect(socratic.message?.checking).toBe(false);
    expect(check.started()).toBe(0);
  });

  it("Stop in the chat stops a running check, and the reply stays without badges", async () => {
    const db = chatDb();
    const check = heldCheck();
    const first = await askTurn(db, { text: "Deriva", allowGeneral: true, run: check.run });
    const controller = new AbortController();
    await expect(
      askTurn(db, {
        chatId: first.chatId,
        text: "E poi?",
        allowGeneral: true,
        signal: controller.signal,
        run: async () => {
          controller.abort();
          throw new DOMException("aborted", "AbortError");
        },
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    await settleChecks();
    expect(check.stopped()).toBe(1);
    const saved = readChat(db, first.chatId).find((row) => row.id === first.message?.id);
    expect(saved).toMatchObject({ checks: [], checking: false });
  });

  it("Regenerate drops the old reply's check", async () => {
    const db = chatDb();
    const check = heldCheck();
    const ended: string[] = [];
    setChecksListener((event) => ended.push(event.messageId));
    const first = await askTurn(db, { text: "Deriva", allowGeneral: true, run: check.run });
    const second = await regenerateTurn(db, {
      chatId: first.chatId,
      allowGeneral: true,
      run: async () => reply("Una risposta senza conti."),
    });
    await settleChecks();
    expect(check.stopped()).toBe(1);
    expect(ended).toEqual([first.message!.id]);
    expect(readChat(db, first.chatId).map((row) => row.id)).toEqual([
      readChat(db, first.chatId)[0]!.id,
      second.message!.id,
    ]);
  });

  it("attaches nothing when the check cannot finish", async () => {
    const db = chatDb();
    const result = await askTurn(db, {
      text: "Deriva",
      allowGeneral: true,
      run: async (input) => {
        if (input.responseSchema) throw new Error("offline");
        return reply(step);
      },
    });
    await settleChecks();
    expect(readChat(db, result.chatId).at(-1)).toMatchObject({ body: step, checks: [], checking: false });
  });
});
