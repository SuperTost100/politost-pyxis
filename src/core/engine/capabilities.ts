import catalog from "../../../resources/model-capabilities.json";
import { getFunnel, type ProviderId } from "./funnel";

type Row = {
  pattern: string;
  vision: boolean;
  structured: boolean;
  contextTokens: number;
};

const rows = catalog as Row[];

export type Need = "vision" | "structured";

export function modelCapability(modelId: string): Row | null {
  return rows.find((row) => new RegExp(row.pattern).test(modelId)) ?? null;
}

/** Returns a message key when the model cannot do the job. */
export function capabilityWarning(modelId: string, need: Need): string | null {
  const row = modelCapability(modelId);
  if (!row || row[need] === false) return "engines.capabilityWarning";
  return null;
}

/**
 * False when CLI Funnel says the provider refuses image attachments (Cursor Agent and Antigravity), whatever the model
 * id suggests: their `claude-*` and `gpt-*` ids match the catalog, but the CLI cannot take the picture. An unknown
 * provider is not ruled out here.
 */
export function providerSeesImages(provider: string): boolean {
  return (
    getFunnel().providers?.[provider as ProviderId]?.capabilities.images !==
    false
  );
}

/** Whether a turn on this engine can carry a picture: the model reads images and the provider accepts them. */
export function engineSeesImages(engine: {
  provider: string;
  model: string;
}): boolean {
  return (
    capabilityWarning(engine.model, "vision") == null &&
    providerSeesImages(engine.provider)
  );
}
