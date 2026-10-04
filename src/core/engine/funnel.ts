import type Database from "better-sqlite3";
import { createDisclosure } from "./disclosure";
import {
  createFunnel,
  FunnelError,
  type Funnel,
  type ProviderId,
  type Selection,
} from "cli-funnel";

export type { ProviderId, Selection };
export { FunnelError };

export type EngineResult = {
  text: string;
  model: string;
  provider: string;
  inputTokens: number;
  structured?: unknown;
  structuredError?: string;
};

type Keys = { anthropic?: string; openai?: string };

let keys: Keys = {};
let funnel: Funnel | null = null;
let scratch = "";
let disclosure: ReturnType<typeof createDisclosure> | undefined;
export function configureDisclosure(
  db: Database.Database,
  notify: (provider: string, pending: boolean) => void,
) {
  disclosure = createDisclosure(db, notify);
}
export function acknowledgeProvider(provider: string) {
  disclosure?.acknowledge(provider);
}
export function cancelDisclosure(provider: string) {
  disclosure?.cancel(provider);
}
export function pendingDisclosures(): string[] {
  return disclosure?.pending() ?? [];
}

export function setScratch(path: string): void {
  scratch = path;
}

export function setApiKeys(next: Keys): void {
  keys = { anthropic: next.anthropic, openai: next.openai };
  funnel = null;
}

export function getFunnel(): Funnel {
  if (!funnel) funnel = createFunnel({ apiKeys: keys });
  return funnel;
}

export async function runTurn(input: {
  selection: Omit<Selection, "cwd" | "access"> & { cwd?: string };
  prompt: string;
  system?: string;
  responseSchema?: { name?: string; schema: Record<string, unknown> };
  signal?: AbortSignal;
  onDelta?: (text: string) => void;
  attachments?: Array<{
    type: "image";
    mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
    data: string;
  }>;
}): Promise<EngineResult> {
  await disclosure?.ensure(input.selection.provider, input.signal);
  const selection = {
    ...input.selection,
    cwd: input.selection.cwd || scratch,
    access: "none" as const,
  };
  if (input.onDelta) {
    const stream = getFunnel().stream({
      selection,
      prompt: input.prompt,
      system: input.system,
      responseSchema: input.responseSchema,
      attachments: input.attachments,
      signal: input.signal,
    });
    let text = "";
    for await (const event of stream) {
      if (event.type !== "text.delta") continue;
      text += event.text;
      input.onDelta(text);
    }
    const result = await stream.result;
    return {
      text: result.text || text,
      model: result.model,
      provider: result.provider,
      inputTokens: result.usage?.inputTokens ?? 0,
      structured: result.structured,
      structuredError: result.structuredError,
    };
  }
  const result = await getFunnel().run({
    selection,
    prompt: input.prompt,
    system: input.system,
    responseSchema: input.responseSchema,
    attachments: input.attachments,
    signal: input.signal,
  });
  return {
    text: result.text,
    model: result.model,
    provider: result.provider,
    inputTokens: result.usage?.inputTokens ?? 0,
    structured: result.structured,
    structuredError: result.structuredError,
  };
}
