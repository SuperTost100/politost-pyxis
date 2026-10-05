import { z } from "zod";
import { IpcError } from "../../shared/ipc";
import { runTurn, type EngineResult, type Selection } from "./funnel";

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
  run?: typeof runTurn;
};

export type GenerateOutput = EngineResult & { data?: unknown };

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

export async function generate(input: GenerateInput): Promise<GenerateOutput> {
  const run = input.run ?? runTurn;
  const responseSchema = input.schema
    ? { name: "response", schema: jsonSchema(input.schema) }
    : undefined;
  let result = await run({
    selection: input.selection,
    prompt: input.prompt,
    system: input.system,
    responseSchema,
    signal: input.signal,
    attachments: input.attachments,
    onDelta: input.onDelta,
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
}
