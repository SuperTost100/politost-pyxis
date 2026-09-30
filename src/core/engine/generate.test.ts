import { describe, expect, it } from "vitest";
import { z } from "zod";
import { generate } from "./generate";
import type { EngineResult } from "./funnel";

const selection = { provider: "claude" as const, model: "claude-sonnet-4-6" };

function result(patch: Partial<EngineResult>): EngineResult {
  return {
    text: "",
    model: "claude-sonnet-4-6",
    provider: "claude",
    inputTokens: 12,
    ...patch,
  };
}

describe("generate", () => {
  it("repairs one bad structured answer", async () => {
    const calls: string[] = [];
    const output = await generate({
      selection,
      prompt: "name a colour",
      schema: z.object({ colour: z.string() }),
      run: async (input) => {
        calls.push(input.prompt);
        if (calls.length === 1) return result({ text: "blue", structuredError: "not json" });
        return result({ structured: { colour: "blue" }, text: "{\"colour\":\"blue\"}" });
      },
    });
    expect(calls).toHaveLength(2);
    expect(output.data).toEqual({ colour: "blue" });
  });

  it("stops after two repair calls", async () => {
    let calls = 0;
    await expect(
      generate({
        selection,
        prompt: "name a colour",
        schema: z.object({ colour: z.string() }),
        run: async () => {
          calls += 1;
          return result({ text: "nope", structuredError: "not json" });
        },
      }),
    ).rejects.toMatchObject({ code: "invalid-output" });
    expect(calls).toBe(3);
  });
});
