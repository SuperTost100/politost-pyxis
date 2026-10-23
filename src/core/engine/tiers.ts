import tiers from "../../../resources/model-tiers.json";
import type { ProviderId } from "./funnel";

export type Tier = "fast" | "mid" | "strong";

export type LocalTier = {
  id: string;
  model: string;
  name: string;
  downloadBytes: number;
  contextWindow: number;
  minVramGb: number;
  minUnifiedGb: number;
};

/** `resources/model-tiers.json`, typed once for every reader in core. */
export const tierData = tiers as unknown as {
  features: Record<string, { tier: Tier; weight: number }>;
  unknownFeature: { tier: Tier; weight: number };
  tierCost: Record<Tier, number>;
  tierOrder: Record<Tier, Tier[]>;
  effort: Record<Tier, string>;
  providerOrder: Record<Tier, string[]>;
  family: Record<string, string>;
  patterns: Record<string, Record<Tier, string[]>>;
  local: {
    provider: ProviderId;
    installUrl: string;
    minRamGb: number;
    diskMarginGb: number;
    minTokensPerSecond: number;
    strictFeatures: string[];
    tiers: LocalTier[];
  };
};
