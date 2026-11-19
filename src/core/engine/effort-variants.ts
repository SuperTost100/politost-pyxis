import { effortScale } from "../../shared/effort";
import { ownModels } from "./model-roles";

type Listed = { id: string; efforts: ReadonlyArray<{ id: string; label?: string }> };

const VARIANT = new RegExp(`^(.+)-(${effortScale.filter((level) => level !== "none").join("|")})$`);
const LABEL: Record<string, string> = { xhigh: "Extra high" };

/**
 * Some tools list a reasoning level as a model of its own: `agy models` has `gemini-4-neon` with the levels low to high
 * and, next to it, `gemini-4-neon-xhigh` with none. A variant is dropped when the model it belongs to is listed, and
 * its level is added to that model, so a model is shown once and the level is the Ragionamento column's choice. CLI Funnel
 * refuses `--effort xhigh` on `gemini-4-neon`, which lists three levels, so a task at that level runs on the variant's id
 * (`variantFor`), which is how the tool lists it.
 */
export function collapseEffortVariants<T extends Listed>(models: readonly T[]): T[] {
  const ids = new Set(models.map((model) => model.id));
  const added = new Map<string, string[]>();
  const kept = models.filter((model) => {
    const match = VARIANT.exec(model.id);
    if (!match || model.efforts.length > 0 || !ids.has(match[1]!)) return true;
    added.set(match[1]!, [...(added.get(match[1]!) ?? []), match[2]!]);
    return false;
  });
  return kept.map((model) => {
    const levels = added.get(model.id)?.filter((level) => !model.efforts.some((effort) => effort.id === level));
    if (!levels?.length) return model;
    const efforts = [
      ...model.efforts,
      ...levels.map((level) => ({ id: level, label: LABEL[level] ?? level[0]!.toUpperCase() + level.slice(1) })),
    ].sort(
      (a, b) =>
        effortScale.indexOf(a.id as (typeof effortScale)[number]) -
        effortScale.indexOf(b.id as (typeof effortScale)[number]),
    );
    return { ...model, efforts };
  });
}

/** The variants among a tool's listed ids: `gemini-4-neon` at `xhigh` runs as `gemini-4-neon-xhigh`. Keyed by model and level. */
export function variantsOf(listing: readonly Listed[]): Map<string, string> {
  const ids = new Set(listing.map((model) => model.id));
  const variants = new Map<string, string>();
  for (const model of listing) {
    const match = VARIANT.exec(model.id);
    if (match && model.efforts.length === 0 && ids.has(match[1]!)) variants.set(`${match[1]}|${match[2]}`, model.id);
  }
  return variants;
}

/** The models a tool offers: its maker's own, each shown once. */
export function offeredModels<T extends Listed>(provider: string, listing: readonly T[]): T[] {
  return collapseEffortVariants(ownModels(provider, listing));
}
