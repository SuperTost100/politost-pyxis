import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { askTurn, readChat } from "./turn";
import { solverChecks, splitChecks } from "./checks";
import type { GenerateInput } from "../engine/generate";
import { systemPrompt } from "../engine/prompts";

const selection = { provider: "claude" as const, model: "fixture" };
const step = "The derivative is $2*x*sin(x) + x**2*cos(x)$.";
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
    expect(result.message?.checks).toEqual([claim]);
    expect(readChat(db, result.chatId).at(-1)?.checks).toEqual([claim]);
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
