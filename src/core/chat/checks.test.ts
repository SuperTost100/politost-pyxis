import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { askTurn, readChat, settleChecks } from "./turn";
import { checkSelection, needsSolverChecks, solverChecks, splitChecks } from "./checks";
import { rememberReady } from "../engine/selection";
import type { GenerateInput } from "../engine/generate";
import { systemPrompt } from "../engine/prompts";

const selection = { provider: "claude" as const, model: "fixture" };
const step = "The derivative is $f'(x) = 2*x*sin(x) + x**2*cos(x)$.";
const claim = {
  kind: "derivative" as const,
  expr: "x**2*sin(x)",
  claimed: "2*x*sin(x)+x**2*cos(x)",
  vars: ["x"],
  step,
};
function response(structured: unknown) {
  return {
    text: JSON.stringify(structured),
    structured,
    provider: "claude",
    model: "fixture",
    inputTokens: 1,
  };
}

describe("Solver check metadata", () => {
  it("extracts and persists a derivative claim from an ordinary reply without a fence", async () => {
    const db = openDatabase(":memory:");
    db.prepare(
      "INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES ('default', ?, 1)",
    ).run(JSON.stringify({ provider: "claude", model: "claude-sonnet-5" }));
    const selections: string[] = [];
    const run: GenerateInput["run"] = async (input) => {
      selections.push(input.selection.model);
      if (input.responseSchema) {
        // Structured check extraction renders the checks template unchanged, with no placeholders.
        expect(input.system).toBe(systemPrompt("chat.checks"));
        return response({ checks: [claim] });
      }
      input.onDelta?.(step);
      return {
        text: step,
        provider: "claude",
        model: "fixture",
        inputTokens: 1,
      };
    };
    const result = await askTurn(db, {
      text: "Differentiate x**2*sin(x)",
      allowGeneral: true,
      run,
    });
    expect(result.message?.body).toBe(step);
    // The reply returns before its check: the claims arrive in the stored message once the check ends.
    expect(result.message?.checking).toBe(true);
    await settleChecks();
    expect(readChat(db, result.chatId).at(-1)?.checks).toEqual([claim]);
    expect(readChat(db, result.chatId).at(-1)?.checking).toBe(false);
    expect(readChat(db, result.chatId).at(-1)?.body).toBe(step);
    expect(selections).toHaveLength(2);
    expect(selections[0]).toBe(selections[1]);
    db.close();
  });
  it("retains deliberately wrong claims for the independent verifier, without trusting the model", async () => {
    const wrong = { ...claim, claimed: "1" };
    const result = await solverChecks(step, {
      selection,
      run: async () => response({ checks: [wrong] }),
    });
    expect(result).toEqual([wrong]);
    expect(result[0]).not.toHaveProperty("state");
  });
  it("uses valid fenced claims directly and skips extraction", async () => {
    const body = `${step}\n\n\`\`\`check\n${JSON.stringify(claim)}\n\`\`\``;
    const checks = await solverChecks(body, {
      selection,
      run: async () => {
        throw new Error("No extraction needed");
      },
    });
    expect(checks).toEqual([claim]);
  });
  it("rejects anchors absent from the actual answer and keeps text when extraction fails", async () => {
    let calls = 0;
    const result = await solverChecks(step, {
      selection,
      run: async () => {
        calls++;
        return response({ checks: [{ ...claim, step: "Invented equation" }] });
      },
    });
    expect(result).toEqual([]);
    expect(calls).toBe(3);
    expect(
      splitChecks(
        `${step}\n<checks>${JSON.stringify([{ ...claim, step: "Invented" }])}</checks>`,
      ),
    ).toEqual({ body: step, checks: [] });
  });
  it("does not extract from prose or cancelled replies", async () => {
    const run: GenerateInput["run"] = async () => {
      throw new Error("Not expected");
    };
    expect(
      await solverChecks("Velocity describes motion.", { selection, run }),
    ).toEqual([]);
    expect(
      await solverChecks(step, { selection, run, signal: AbortSignal.abort() }),
    ).toEqual([]);
  });
});

describe("what a reply states that can be checked", () => {
  it("counts an equation and an integral, bounded or not, and not maths that only names things", () => {
    expect(needsSolverChecks("Vale $2x = 4$.")).toBe(true);
    expect(needsSolverChecks("L'area è \\int_0^1 x\\,dx, cioè un mezzo.")).toBe(true);
    expect(needsSolverChecks("Calcola \\int x\\,dx.")).toBe(true);
    expect(needsSolverChecks("Con $\\intercal$ e $x^2$ non si dice nulla di verificabile.")).toBe(false);
    expect(needsSolverChecks("La regola del prodotto si applica a $x^2 \\sin x$.")).toBe(false);
  });
});

describe("the engine of a separate check", () => {
  const cli = (id: string, model: string) => ({ id, kind: "cli" as const, effort: true, models: [{ id: model, efforts: [] }] });
  const everyone = [cli("claude", "claude-sonnet-5"), cli("codex", "gpt-5.6-terra"), cli("antigravity", "gemini-4-argon")];

  function chatOn(provider: string, model: string, ready: Array<ReturnType<typeof cli>>, auto = true) {
    const db = openDatabase(":memory:");
    db.prepare("INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES ('chat', ?, 1)").run(
      JSON.stringify({ provider, model, ...(auto ? { auto: true } : {}) }),
    );
    rememberReady(ready);
    return db;
  }
  afterEach(() => rememberReady([]));

  it("goes to the tool with the smallest overhead when another is ready, as the chat's own is not", () => {
    for (const [provider, model] of [
      ["codex", "gpt-5.6-terra"],
      ["antigravity", "gemini-4-argon"],
    ] as const) {
      const db = chatOn(provider, model, everyone);
      expect(checkSelection(db), provider).toMatchObject({ provider: "claude", chosenFor: "chat" });
      db.close();
    }
  });

  it("stays on the chat's own tool when it is the cheapest ready one, or no cheaper one is ready", () => {
    const claude = chatOn("claude", "claude-sonnet-5", everyone);
    expect(checkSelection(claude)).toMatchObject({ provider: "claude", model: "claude-sonnet-5" });
    // Gemini's chat with Claude not ready: Codex is cheaper than Gemini.
    const gemini = chatOn("antigravity", "gemini-4-argon", [cli("codex", "gpt-5.6-terra"), cli("antigravity", "gemini-4-argon")]);
    expect(checkSelection(gemini)).toMatchObject({ provider: "codex" });
    const alone = chatOn("antigravity", "gemini-4-argon", [cli("antigravity", "gemini-4-argon")]);
    expect(checkSelection(alone)).toMatchObject({ provider: "antigravity", model: "gemini-4-argon" });
    // No tool is known to be ready (nothing detected yet): the chat's own engine.
    const unknown = chatOn("codex", "gpt-5.6-terra", []);
    expect(checkSelection(unknown)).toMatchObject({ provider: "codex" });
    for (const db of [claude, gemini, alone, unknown]) db.close();
  });

  it("leaves a chat on a local model or an API key where it is, so its text goes nowhere else", () => {
    for (const [provider, model] of [
      ["ollama", "qwen3:8b"],
      ["anthropic-api", "claude-sonnet-5"],
    ] as const) {
      const db = chatOn(provider, model, everyone);
      expect(checkSelection(db), provider).toMatchObject({ provider, model });
      db.close();
    }
  });
});
