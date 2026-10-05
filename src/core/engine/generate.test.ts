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
        expect(input.responseSchema?.schema.$schema).toBe(
          "http://json-schema.org/draft-07/schema#",
        );
        expect(input.responseSchema?.schema.additionalProperties).toBe(false);
        calls.push(input.prompt);
        if (calls.length === 1)
          return result({ text: "blue", structuredError: "not json" });
        return result({
          structured: { colour: "blue" },
          text: '{"colour":"blue"}',
        });
      },
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("name a colour");
    expect(calls[1]).toContain("blue");
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

  it("keeps the image attachments on every schema-repair retry", async () => {
    const attachments = [{ type: "image" as const, mediaType: "image/png" as const, data: "aGk=" }];
    const seen: unknown[] = [];
    let calls = 0;
    const output = await generate({
      selection,
      prompt: "read the board",
      schema: z.object({ text: z.string() }),
      attachments,
      run: async (input) => {
        seen.push(input.attachments);
        calls += 1;
        return calls < 3
          ? result({ text: "not json", structuredError: "bad" })
          : result({ structured: { text: "x^2" }, text: '{"text":"x^2"}' });
      },
    });
    expect(output.data).toEqual({ text: "x^2" });
    // The first call and both repairs carry the same picture. The run is a stub, so no provider is called.
    expect(seen).toEqual([attachments, attachments, attachments]);
  });
});
