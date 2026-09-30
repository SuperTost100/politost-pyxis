import catalog from "../../../resources/model-capabilities.json";

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
