import { describe, expect, it } from "vitest";
import { z } from "zod";
import { IpcError } from "../../shared/ipc";
import { generate } from "./generate";
import { FunnelError, type EngineResult } from "./funnel";

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

describe("generate engine failures", () => {
  const failing = (error: unknown) => () =>
    generate({
      selection,
      prompt: "hi",
      run: async () => {
        throw error;
      },
    });

  it("turns a signed-out engine into its own message with the raw text as detail", async () => {
    const error = await failing(
      new FunnelError("Please run /login", "not-logged-in"),
    )().catch((err: unknown) => err);
    expect(error).toBeInstanceOf(IpcError);
    expect(error).toMatchObject({
      code: "not-logged-in",
      messageKey: "engines.errors.not-logged-in",
      detail: "Please run /login",
    });
  });

  it("separates a usage limit and a crashed CLI", async () => {
    await expect(
      failing(
        Object.assign(new Error("429 rate limit"), { code: "cli-failed" }),
      )(),
    ).rejects.toMatchObject({
      messageKey: "engines.errors.quota",
    });
    await expect(
      failing(new FunnelError("exit 1", "cli-failed"))(),
    ).rejects.toMatchObject({
      messageKey: "engines.errors.cli-failed",
    });
  });

  it("keeps a reply it cannot use as invalid output, not an engine error", async () => {
    const unusable = (text: string) =>
      generate({
        selection,
        prompt: "name a colour",
        schema: z.object({ colour: z.string() }),
        run: async () => result({ text }),
      });
    for (const text of ['{"colour": 3}', "not json at all", ""]) {
      const error = await unusable(text).catch((err: unknown) => err);
      expect(error).toBeInstanceOf(IpcError);
      expect(error).toMatchObject({
        code: "invalid-output",
        messageKey: "errors.invalidOutput",
      });
    }
  });

  it("leaves a plain error that carries no engine code alone", async () => {
    const bug = new SyntaxError("Unexpected token");
    await expect(failing(bug)()).rejects.toBe(bug);
    const unrelated = Object.assign(new Error("disk"), { code: "ENOSPC" });
    await expect(failing(unrelated)()).rejects.toBe(unrelated);
  });

  it("leaves a cancelled call, an IpcError and a refused notice as they were", async () => {
    const abort = new DOMException("stopped", "AbortError");
    await expect(failing(abort)()).rejects.toBe(abort);
    const own = new IpcError("engine-missing", "engines.errors.engine-missing");
    await expect(failing(own)()).rejects.toBe(own);
    await expect(
      failing(new Error("engine-disclosure-required"))(),
    ).rejects.toMatchObject({
      message: "engine-disclosure-required",
      messageKey: "engines.errors.disclosure-required",
    });
  });
});

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
    const attachments = [
      { type: "image" as const, mediaType: "image/png" as const, data: "aGk=" },
    ];
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
