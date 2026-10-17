import { randomUUID } from "node:crypto";
import { z } from "zod";
import { IpcError, isAbort } from "../../shared/ipc";
import { engineSeesImages } from "./capabilities";
import { engineIpcError, fallbackReason } from "./errors";
import {
  endConversation,
  providerName,
  runTurn,
  type EngineResult,
  type Selection,
  type TurnInput,
} from "./funnel";
import { fallbackSelection } from "./selection";

export type GenerateInput = {
  prompt: string;
  system?: string;
  selection: Omit<Selection, "cwd" | "access">;
  schema?: z.ZodType;
  signal?: AbortSignal;
  onDelta?: (text: string) => void;
  attachments?: Array<{
    type: "image";
    mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
    data: string;
  }>;
  /** A chat turn: see `TurnInput.conversation`. */
  conversation?: TurnInput["conversation"];
  /** Use the provider's prompt cache for the system prompt and the conversation so far. */
  cache?: boolean;
  run?: typeof runTurn;
};

export type EngineFallback = {
  from: string;
  to: string;
  reason: "limit" | "signed-out";
};

export type GenerateOutput = EngineResult & {
  data?: unknown;
  /** Set when the automatic engine failed and another one answered. */
  fallback?: EngineFallback;
};

let onFallback: ((event: EngineFallback) => void) | undefined;

/** Core tells the window which engine answered instead, so the student knows why the reply looks different. */
export function setFallbackListener(
  listener: ((event: EngineFallback) => void) | undefined,
): void {
  onFallback = listener;
}

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { target: "draft-7" }) as Record<
    string,
    unknown
  >;
  lock(json);
  return json;
}

function lock(node: unknown): void {
  if (!node || typeof node !== "object") return;
  const record = node as Record<string, unknown>;
  if (record.type === "object") record.additionalProperties = false;
  for (const value of Object.values(record)) {
    if (Array.isArray(value)) value.forEach(lock);
    else lock(value);
  }
}

function parsed(schema: z.ZodType, result: EngineResult): unknown {
  const candidate = result.structured ?? tryJson(result.text);
  const check = schema.safeParse(candidate);
  return check.success ? check.data : null;
}

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Every model call goes through here, so a failed engine reaches the screen as its own message (signed out, usage limit,
 * not available) instead of "Something went wrong".
 */
export async function generate(input: GenerateInput): Promise<GenerateOutput> {
  try {
    return await generateOnce(input);
  } catch (err) {
    const reason =
      !input.signal?.aborted && !isAbort(err)
        ? fallbackReason(err, input.selection.provider)
        : undefined;
    const next = reason ? fallbackSelection(input.selection) : undefined;
    // A turn that carries a picture only moves to an engine that can see it.
    const sees = !input.attachments?.length || (next && engineSeesImages(next));
    if (!reason || !next || !sees) throw engineIpcError(err, input.selection.provider);
    // An engine Pyxis chose that hit its usage limit or was signed out: the next ready engine answers once instead.
    const fallback = {
      from: providerName(input.selection.provider),
      to: providerName(next.provider),
      reason,
    };
    try {
      const output = await generateOnce({ ...input, selection: next });
      onFallback?.(fallback);
      return { ...output, fallback };
    } catch (second) {
      throw engineIpcError(second, next.provider);
    }
  }
}

async function generateOnce(input: GenerateInput): Promise<GenerateOutput> {
  const run = input.run ?? runTurn;
  const responseSchema = input.schema
    ? { name: "response", schema: jsonSchema(input.schema) }
    : undefined;
  // A structured answer may need repairs. Engines that keep the conversation already hold the prompt, so a repair sends
  // them only the validation error and the invalid answer; engines that keep none get the whole prompt again.
  const repairs =
    input.schema && !input.conversation
      ? `generate:${randomUUID()}`
      : undefined;
  try {
    let result = await run({
      selection: input.selection,
      prompt: input.prompt,
      system: input.system,
      responseSchema,
      signal: input.signal,
      attachments: input.attachments,
      onDelta: input.onDelta,
      conversation:
        input.conversation ??
        (repairs ? { key: repairs, followUp: input.prompt } : undefined),
      cache: input.cache,
    });
    if (!input.schema) return result;
    let data = parsed(input.schema, result);
    for (let repair = 0; data == null && repair < 2; repair += 1) {
      const issues =
        result.structuredError ??
        input.schema.safeParse(tryJson(result.text)).error?.message ??
        result.text;
      result = await run({
        selection: input.selection,
        prompt: `${input.prompt}\n\nThe previous answer failed validation.\n${result.text}\n${issues}\nReturn corrected JSON only.`,
        system: input.system,
        responseSchema,
        signal: input.signal,
        // A repair of a reply about a picture still needs the picture.
        attachments: input.attachments,
        conversation: repairs
          ? {
              key: repairs,
              followUp: `Your answer failed validation against the JSON schema.\n\nValidation error:\n${issues}\n\nYour answer:\n${result.text}\n\nReturn the corrected JSON only.`,
            }
          : undefined,
      });
      data = parsed(input.schema, result);
    }
    if (data == null) {
      throw new IpcError(
        "invalid-output",
        "errors.invalidOutput",
        {},
        result.text.slice(0, 500),
      );
    }
    return { ...result, data };
  } finally {
    if (repairs) endConversation(repairs);
  }
}
