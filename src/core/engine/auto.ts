import { nearestEffort } from "../../shared/effort";
import { modelCapability } from "./capabilities";
import {
  automaticModels,
  hasRoles,
  roleEffort,
  roleModels,
} from "./model-roles";
import { tierData as data, type Tier } from "./tiers";

export const autoFeatures = [
  "default",
  "chat",
  "plan",
  "lesson",
  "grading",
  "map",
  "vision",
  "cards",
] as const;
export type AutoFeature = (typeof autoFeatures)[number];

export type AutoModel = { id: string; efforts: Array<{ id: string }> };
/** A provider that is ready to run a turn, with the models it lists. */
export type AutoProvider = {
  id: string;
  /** Subscription CLIs, then a local model, then per-token API keys. */
  kind: "cli" | "api" | "local";
  /** A local model: true when it passed the structured-output check. Plans and grading need it. */
  structured?: boolean;
  /** True when the provider accepts an effort level. */
  effort: boolean;
  /** False when the provider refuses image attachments. Absent means it takes them. */
  images?: boolean;
  models: AutoModel[];
};
export type AutoChoice = { provider: string; model: string; effort?: string };
export type AutoPlan = Partial<Record<AutoFeature, AutoChoice>>;


function featureTier(feature: string): Tier {
  return (data.features[feature] ?? data.unknownFeature).tier;
}

function weightOf(feature: string): number {
  return (data.features[feature] ?? data.unknownFeature).weight;
}

/** Usage a feature puts on a provider: how often it runs times how costly its tier is. */
function loadOf(feature: string): number {
  return weightOf(feature) * data.tierCost[featureTier(feature)];
}

function usableModels(provider: AutoProvider, feature: string): AutoModel[] {
  if (feature !== "vision") return provider.models;
  if (provider.images === false) return [];
  return provider.models.filter(
    (model) => modelCapability(model.id)?.vision === true,
  );
}

/**
 * Picks the model for a role from the file's list (`model-roles.json`): the first id of the role that the provider
 * reports, in the file's order. When the provider reports none of them the neighbouring roles are tried, and the last
 * resort is the first of the maker's own models the provider reports, never a model of another company. A provider
 * the file has no rule for, such as the local model, gets the first model it lists.
 */
export function pickModel(
  provider: AutoProvider,
  tier: Tier,
  models: AutoModel[] = provider.models,
): AutoModel | undefined {
  if (!hasRoles(provider.id)) return models[0];
  const own = automaticModels(provider.id, models);
  for (const step of data.tierOrder[tier]) {
    for (const id of roleModels(provider.id, step)) {
      const found = own.find((model) => model.id === id);
      if (found) return found;
    }
  }
  return own[0];
}

function choiceFor(
  provider: AutoProvider,
  feature: string,
): AutoChoice | undefined {
  const tier = featureTier(feature);
  const models = usableModels(provider, feature);
  const model = pickModel(provider, tier, models.length ? models : undefined);
  if (!model) return undefined;
  const effort = provider.effort
    ? nearestEffort(
        roleEffort(provider.id, tier),
        model.efforts.map((option) => option.id),
      )
    : undefined;
  return {
    provider: provider.id,
    model: model.id,
    ...(effort ? { effort } : {}),
  };
}

function canServe(provider: AutoProvider, feature: string): boolean {
  return usableModels(provider, feature).length > 0;
}

/** A local model never builds plans or grades unless it passed the structured-output check. */
function allowed(provider: AutoProvider, feature: string): boolean {
  return (
    provider.kind !== "local" ||
    provider.structured === true ||
    !data.local.strictFeatures.includes(feature)
  );
}

/**
 * Chooses a provider, model and effort for each feature without calling a
 * model. Subscription CLIs win, then a local model the student turned on, then
 * per-token API providers. Each tier has a
 * preferred provider; when two or more providers are ready, features move from
 * the busiest to the idlest provider while that evens out the load, so no
 * single subscription carries most of the usage.
 *
 * With `order`, the list the student put their tools in, nothing is shared out: every feature goes to the first tool
 * of the list that can do it, and a tool the list leaves out comes after the listed ones. The list only names
 * subscription CLIs, so a pool without any of them is planned as if there were no list.
 */
export function planAuto(
  ready: AutoProvider[],
  features: readonly string[] = autoFeatures,
  order?: readonly string[] | null,
): AutoPlan {
  // Only the maker's own models count, so a tool that lists another company's models never gets one of them.
  const usable = ready
    .filter((provider) => hasRoles(provider.id) || provider.kind === "local")
    .map((provider) =>
      hasRoles(provider.id)
        ? { ...provider, models: automaticModels(provider.id, provider.models) }
        : provider,
    )
    .filter((provider) => provider.models.length > 0);
  const clis = usable.filter((provider) => provider.kind === "cli");
  const local = usable.filter((provider) => provider.kind === "local");
  const pool = clis.length ? clis : local.length ? local : usable;
  if (!pool.length) return {};

  const assigned = new Map<string, AutoProvider>();
  if (order && pool.some((provider) => order.includes(provider.id))) {
    const place = (provider: AutoProvider) =>
      order.indexOf(provider.id) + 1 || order.length + 1;
    // Array.prototype.sort is stable, so tools the list leaves out keep the order they came in.
    const listed = [...pool].sort((a, b) => place(a) - place(b));
    for (const feature of features) {
      const permitted = listed.filter((provider) => allowed(provider, feature));
      const first =
        permitted.find((provider) => canServe(provider, feature)) ?? permitted[0];
      if (first) assigned.set(feature, first);
    }
    return choices(assigned, features);
  }
  for (const feature of features) {
    const permitted = pool.filter((provider) => allowed(provider, feature));
    if (!permitted.length) continue;
    const capable = permitted.filter((provider) => canServe(provider, feature));
    const candidates = capable.length ? capable : permitted;
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
        if (
          provider !== busy ||
          !canServe(idle, feature) ||
          !allowed(idle, feature)
        )
          continue;
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

  return choices(assigned, features);
}

/** The model and effort of each feature on the provider it was given. */
function choices(
  assigned: ReadonlyMap<string, AutoProvider>,
  features: readonly string[],
): AutoPlan {
  const plan: AutoPlan = {};
  for (const feature of features) {
    const provider = assigned.get(feature);
    if (!provider) continue;
    const choice = choiceFor(provider, feature);
    if (choice) plan[feature as AutoFeature] = choice;
  }
  return plan;
}
