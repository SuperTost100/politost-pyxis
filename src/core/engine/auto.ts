import tiers from "../../../resources/model-tiers.json";
import { modelCapability } from "./capabilities";

export type Tier = "fast" | "mid" | "strong";
export const tierNames: readonly Tier[] = ["fast", "mid", "strong"];
export const autoFeatures = [
  "default",
  "chat",
  "plan",
  "lesson",
  "grading",
  "map",
  "vision",
] as const;
export type AutoFeature = (typeof autoFeatures)[number];

export type AutoModel = { id: string; efforts: Array<{ id: string }> };
/** A provider that is ready to run a turn, with the models it lists. */
export type AutoProvider = {
  id: string;
  kind: "cli" | "api";
  /** True when the provider accepts an effort level. */
  effort: boolean;
  models: AutoModel[];
};
export type AutoChoice = { provider: string; model: string; effort?: string };
export type AutoPlan = Partial<Record<AutoFeature, AutoChoice>>;

type TierData = {
  features: Record<string, { tier: Tier; weight: number }>;
  unknownFeature: { tier: Tier; weight: number };
  tierCost: Record<Tier, number>;
  tierOrder: Record<Tier, Tier[]>;
  effort: Record<Tier, string>;
  providerOrder: Record<Tier, string[]>;
  family: Record<string, string>;
  patterns: Record<string, Record<Tier, string[]>>;
};
const data = tiers as unknown as TierData;

export function featureTier(feature: string): Tier {
  return (data.features[feature] ?? data.unknownFeature).tier;
}

function weightOf(feature: string): number {
  return (data.features[feature] ?? data.unknownFeature).weight;
}

/** Usage a feature puts on a provider: how often it runs times how costly its tier is. */
function loadOf(feature: string): number {
  return weightOf(feature) * data.tierCost[featureTier(feature)];
}

function versionParts(id: string): number[] {
  return (id.match(/\d+/g) ?? []).map(Number);
}

function compareVersionsDesc(a: AutoModel, b: AutoModel): number {
  const left = versionParts(a.id);
  const right = versionParts(b.id);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (right[i] ?? -1) - (left[i] ?? -1);
    if (diff !== 0) return diff;
  }
  return 0;
}

function usableModels(provider: AutoProvider, feature: string): AutoModel[] {
  if (feature !== "vision") return provider.models;
  return provider.models.filter(
    (model) => modelCapability(model.id)?.vision === true,
  );
}

/** Picks the newest model of a tier, stepping to the neighbouring tiers when the provider lists none. */
export function pickModel(
  provider: AutoProvider,
  tier: Tier,
  models: AutoModel[] = provider.models,
): AutoModel | undefined {
  const family = data.patterns[data.family[provider.id] ?? ""];
  if (family) {
    for (const step of data.tierOrder[tier]) {
      for (const pattern of family[step]) {
        const expression = new RegExp(pattern);
        const matches = models.filter((model) => expression.test(model.id));
        // Array.prototype.sort is stable, so equal versions keep the provider's order.
        if (matches.length) return [...matches].sort(compareVersionsDesc)[0];
      }
    }
  }
  return models[0];
}

function choiceFor(
  provider: AutoProvider,
  feature: string,
): AutoChoice | undefined {
  const tier = featureTier(feature);
  const models = usableModels(provider, feature);
  const model = pickModel(provider, tier, models.length ? models : undefined);
  if (!model) return undefined;
  const effort = data.effort[tier];
  return {
    provider: provider.id,
    model: model.id,
    ...(provider.effort && model.efforts.some((option) => option.id === effort)
      ? { effort }
      : {}),
  };
}

function canServe(provider: AutoProvider, feature: string): boolean {
  return usableModels(provider, feature).length > 0;
}

/**
 * Chooses a provider, model and effort for each feature without calling a
 * model. Subscription CLIs win over per-token API providers. Each tier has a
 * preferred provider; when two or more providers are ready, features move from
 * the busiest to the idlest provider while that evens out the load, so no
 * single subscription carries most of the usage.
 */
export function planAuto(
  ready: AutoProvider[],
  features: readonly string[] = autoFeatures,
): AutoPlan {
  const usable = ready.filter(
    (provider) => provider.models.length > 0 && data.family[provider.id],
  );
  const clis = usable.filter((provider) => provider.kind === "cli");
  const pool = clis.length ? clis : usable;
  if (!pool.length) return {};

  const assigned = new Map<string, AutoProvider>();
  for (const feature of features) {
    const capable = pool.filter((provider) => canServe(provider, feature));
    const candidates = capable.length ? capable : pool;
    const order = data.providerOrder[featureTier(feature)];
    const preferred = [...candidates].sort(
      (a, b) =>
        (order.indexOf(a.id) + 1 || order.length + 1) -
        (order.indexOf(b.id) + 1 || order.length + 1),
    )[0]!;
    assigned.set(feature, preferred);
  }

  const load = new Map(pool.map((provider) => [provider.id, 0]));
  for (const [feature, provider] of assigned)
    load.set(provider.id, load.get(provider.id)! + loadOf(feature));

  if (pool.length > 1) {
    for (;;) {
      const sorted = [...pool].sort(
        (a, b) => load.get(a.id)! - load.get(b.id)!,
      );
      const idle = sorted[0]!;
      const busy = sorted[sorted.length - 1]!;
      const gap = load.get(busy.id)! - load.get(idle.id)!;
      let best: { feature: string; remaining: number } | undefined;
      for (const [feature, provider] of assigned) {
        if (provider !== busy || !canServe(idle, feature)) continue;
        const remaining = Math.abs(gap - 2 * loadOf(feature));
        if (remaining >= gap) continue;
        const better =
          !best ||
          remaining < best.remaining ||
          (remaining === best.remaining &&
            data.tierCost[featureTier(feature)] >
              data.tierCost[featureTier(best.feature)]);
        if (better) best = { feature, remaining };
      }
      if (!best) break;
      assigned.set(best.feature, idle);
      load.set(busy.id, load.get(busy.id)! - loadOf(best.feature));
      load.set(idle.id, load.get(idle.id)! + loadOf(best.feature));
    }
  }

  const plan: AutoPlan = {};
  for (const feature of features) {
    const choice = choiceFor(assigned.get(feature)!, feature);
    if (choice) plan[feature as AutoFeature] = choice;
  }
  return plan;
}
