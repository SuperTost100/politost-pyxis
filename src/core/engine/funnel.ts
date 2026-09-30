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
}): Promise<EngineResult> {
  const result = await getFunnel().run({
    selection: {
      ...input.selection,
      cwd: input.selection.cwd || scratch,
      access: "none",
    },
    prompt: input.prompt,
    system: input.system,
    responseSchema: input.responseSchema,
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
