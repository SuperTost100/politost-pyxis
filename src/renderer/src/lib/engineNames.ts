import { readableModel } from "../../../shared/model-names";
import { ENGINE_NAMES } from "./engineErrorView";

/** What `engines.names` answers: each engine's name, and each listed model's name by engine. */
export type EngineNames = {
  engines: Record<string, string>;
  models: Record<string, Record<string, string>>;
};

/** "Cursor Agent" for `agent`, before and after core has told the names. */
export function engineName(names: EngineNames | undefined, provider: string): string {
  return names?.engines[provider] ?? ENGINE_NAMES[provider] ?? provider;
}

/** The engine's own name for a model ("Codex 5.3" for `gpt-5.3-codex`), else the id made readable. */
export function modelName(
  names: EngineNames | undefined,
  provider: string | null | undefined,
  model: string,
): string {
  return (provider ? names?.models[provider]?.[model] : undefined) ?? readableModel(model);
}

/**
 * An engine and its model as the student reads them everywhere, the way the model picker does:
 * "Cursor Agent · Codex 5.3". Either part may be missing on an old record.
 */
export function engineLabel(
  names: EngineNames | undefined,
  provider: string | null | undefined,
  model: string | null | undefined,
): string {
  return [
    provider ? engineName(names, provider) : undefined,
    model ? modelName(names, provider, model) : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
}
