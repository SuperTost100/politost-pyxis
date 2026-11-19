import { getFunnel, type ProviderId } from "./funnel";
import { capabilityOf, type Capability } from "./model-roles";

export type Need = "vision" | "structured";

/** What the model file says the model can do; null for a model it does not name. */
export function modelCapability(modelId: string): Capability | null {
  return capabilityOf(modelId);
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
