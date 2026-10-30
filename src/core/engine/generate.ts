import { randomUUID } from "node:crypto";
import { z } from "zod";
import { IpcError, isAbort } from "../../shared/ipc";
import { repairModelStrings } from "../../shared/latex-repair";
import { parseLooseJson } from "../../shared/smart-text";
import { engineSeesImages } from "./capabilities";
import { benchEngine, benchModel, isBenched, isModelBenched } from "./bench";
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
import { reportUsage, withUsageScope, type UsageScope } from "./usage";

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
  /** What the call's tokens are counted for, on top of the scope it runs in (a job step sets its job). */
  usage?: UsageScope;
  /** Called with the engine that answers instead when the selected one is out, before it starts. */
  onEngine?: (selection: Omit<Selection, "cwd" | "access">) => void;
  run?: typeof runTurn;
};

export type EngineFallback = {
  from: string;
  to: string;
  reason: "limit" | "signed-out" | "model";
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

/** The JSON Schema sent with a structured request: unknown object properties are not allowed. */
export function jsonSchema(schema: z.ZodType): Record<string, unknown> {
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
  const candidate =
    result.structured == null ? tryJson(result.text) : repairModelStrings(result.structured);
  const check = schema.safeParse(candidate);
  return check.success ? check.data : null;
}

/**
 * The value a text holds as JSON, or undefined when it holds none. LaTeX a model wrote with single backslashes is
 * restored here and in every structured answer, so no feature shows "m", a tab and "heta" for `m\theta`.
 */
export function tryJson(text: string): unknown {
  const value = parseLooseJson(text);
  return value === undefined ? undefined : repairModelStrings(value);
}

/**
 * Every model call goes through here, so a failed engine reaches the screen as its own message (signed out, usage limit,
 * not available) instead of "Something went wrong".
 */
export async function generate(input: GenerateInput): Promise<GenerateOutput> {
  if (input.usage) {
    const { usage, ...rest } = input;
    return withUsageScope(usage, () => generate(rest));
  }
  // An automatic engine still out after a usage limit or a sign-out, or a model the subscription refused, is skipped
  // until it is back.
  const instead = isBenched(input.selection.provider)
    ? usableFallback(input)
    : isModelBenched(input.selection.provider, input.selection.model)
      ? usableFallback(input, "model")
      : undefined;
  if (instead) return answerOn(input, instead);
  try {
    return await generateOnce(input);
  } catch (err) {
    const reason =
      !input.signal?.aborted && !isAbort(err)
        ? fallbackReason(err, input.selection.provider)
        : undefined;
    // An engine Pyxis chose that hit its usage limit, was signed out or refused the model: the next ready engine, or
    // the same engine's next model after a refusal, answers once instead. Later automatic calls skip it until its limit
    // resets, it is signed in again or the refused model's day is over.
    if (reason === "model")
      benchModel(input.selection.provider, input.selection.model);
    const next = reason ? usableFallback(input, reason) : undefined;
    if (!reason || !next) throw engineIpcError(err, input.selection.provider);
    if (reason !== "model")
      benchEngine(
        input.selection.provider,
        reason,
        err && typeof err === "object" && "limit" in err
          ? (err.limit as { resetAt?: string; retryAfterMs?: number })
          : undefined,
      );
    const fallback = {
      from: providerName(input.selection.provider),
      // The same engine answering on another model is named with that model.
      to:
        next.provider === input.selection.provider
          ? `${providerName(next.provider)} (${next.model})`
          : providerName(next.provider),
      reason,
    };
    const output = await answerOn(input, next);
    onFallback?.(fallback);
    return { ...output, fallback };
  }
}

/** The engine an automatic selection moves to. A turn that carries a picture only moves to an engine that can see it. */
function usableFallback(
  input: GenerateInput,
  reason?: "limit" | "signed-out" | "model",
) {
  const next = fallbackSelection(input.selection, reason);
  if (!next) return undefined;
  return !input.attachments?.length || engineSeesImages(next) ? next : undefined;
}

async function answerOn(
  input: GenerateInput,
  selection: GenerateInput["selection"],
): Promise<GenerateOutput> {
  input.onEngine?.(selection);
  try {
    return await generateOnce({ ...input, selection });
  } catch (err) {
    throw engineIpcError(err, selection.provider);
  }
}

async function generateOnce(input: GenerateInput): Promise<GenerateOutput> {
  const turn = input.run ?? runTurn;
  // Every call that returns is counted, schema repairs included, for the token usage per chat, job and week.
  const run: typeof runTurn = async (call) => {
    const result = await turn(call);
    reportUsage(result);
    return result;
  };
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
