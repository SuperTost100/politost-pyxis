import { z } from "zod";
import shipped from "../../../resources/model-roles.json";
import { nearestEffort, taskEffort } from "../../shared/effort";
import { tierData, type Tier } from "./tiers";

/**
 * Which models each tool may use for each role, from `resources/model-roles.json` and, once downloaded, a newer copy
 * of it (`model-roles-sync.ts`). A tool only ever offers its maker's models, so the rule that says which reported ids
 * are the maker's is part of the file too.
 */

const pattern = z
  .string()
  .max(120)
  .refine((source) => {
    try {
      new RegExp(source, "i");
      return true;
    } catch {
      return false;
    }
  }, "not a regular expression");

const role = z.object({
  /** The reasoning effort the role runs at; the nearest level the model lists is used. */
  effort: z.string().min(1).max(20),
  /** Concrete model ids, preferred first. The first one the tool reports for this account is used. */
  models: z.array(z.string().min(1).max(120)).min(1).max(40),
});

const tool = z.object({
  /** Matches the ids of the maker's own models among everything the tool reports. */
  own: pattern,
  /** Ids the automatic choice never uses, though they are the maker's own. A student can still pin them. */
  never: pattern.optional(),
  roles: z.object({ fast: role, mid: role, strong: role }),
});

export const modelFileSchema = z.object({
  /** The format. A file of a version this app does not know is ignored. */
  version: z.literal(1),
  /** When the file was last changed (ISO 8601). Of two valid copies the later one wins. */
  updatedAt: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T/)
    .refine((value) => !Number.isNaN(Date.parse(value))),
  tools: z.record(z.string().min(1).max(40), tool),
});
export type ModelFile = z.infer<typeof modelFileSchema>;

const shippedFile = modelFileSchema.parse(shipped);
type Rule = { own: RegExp; never?: RegExp };

function compile(file: ModelFile): Map<string, Rule> {
  return new Map(
    Object.entries(file.tools).map(([id, rule]) => [
      id,
      {
        own: new RegExp(rule.own, "i"),
        ...(rule.never ? { never: new RegExp(rule.never, "i") } : {}),
      },
    ]),
  );
}
let active: ModelFile = shippedFile;
let compiled = compile(active);

/** The copy in use: the newer of the one shipped with the app and the last valid download. */
export function modelFile(): ModelFile {
  return active;
}

/**
 * Takes a downloaded copy when it is valid, names every tool the shipped copy names, and is strictly newer than the
 * one in use. Anything else changes nothing. Returns whether the copy was taken.
 */
export function adoptModelFile(raw: unknown): boolean {
  const parsed = modelFileSchema.safeParse(raw);
  if (!parsed.success) return false;
  // A copy that leaves a tool out would leave that tool with no model until the next release.
  if (Object.keys(shippedFile.tools).some((id) => !parsed.data.tools[id])) return false;
  if (Date.parse(parsed.data.updatedAt) <= Date.parse(active.updatedAt)) return false;
  active = parsed.data;
  compiled = compile(active);
  return true;
}

/** Tests: back to the copy shipped with the app. */
export function resetModelFile(): void {
  active = shippedFile;
  compiled = compile(active);
}

/** True when this tool has a rule in the file. The local model and unknown tools have none. */
export function hasRoles(provider: string): boolean {
  return compiled.has(provider);
}

/** Whether a reported id is a model of the tool's maker. A tool with no rule in the file is not restricted. */
export function isOwnModel(provider: string, id: string): boolean {
  const rule = compiled.get(provider);
  return !rule || rule.own.test(id);
}

/** True when the id is a model of another tool's maker and not this tool's, such as a Claude model on Cursor. */
export function isForeignModel(provider: string, id: string): boolean {
  const rule = compiled.get(provider);
  if (!rule || rule.own.test(id)) return false;
  return [...compiled].some(([other, candidate]) => other !== provider && candidate.own.test(id));
}

/** The reported models that are the maker's own, in the order the tool reported them. */
export function ownModels<T extends { id: string }>(provider: string, models: readonly T[]): T[] {
  return models.filter((model) => isOwnModel(provider, model.id));
}

/** The maker's own models that the automatic choice may use: `ownModels` without the ids the file says never to pick. */
export function automaticModels<T extends { id: string }>(provider: string, models: readonly T[]): T[] {
  const never = compiled.get(provider)?.never;
  return ownModels(provider, models).filter((model) => !never?.test(model.id));
}

/** The role's model ids for a tool, preferred first, or none when the file has no rule for the tool. */
export function roleModels(provider: string, tier: Tier): readonly string[] {
  return active.tools[provider]?.roles[tier].models ?? [];
}

/** The effort the file gives a role on a tool, or the tier's own when the tool has no rule. */
export function roleEffort(provider: string, tier: Tier): string {
  return active.tools[provider]?.roles[tier].effort ?? tierData.effort[tier]!;
}

/** The tier a task runs in, for reading its role. */
export function tierOf(feature: string): Tier {
  return (tierData.features[feature] ?? tierData.unknownFeature).tier;
}

/**
 * The effort a task gets on a model of this tool that lists these efforts, when the student chose none: the file's
 * effort for the task's role, else the tier's.
 */
export function automaticEffortOn(
  provider: string,
  feature: string,
  listed: readonly string[],
): string | undefined {
  const wanted = active.tools[provider] ? roleEffort(provider, tierOf(feature)) : taskEffort(feature);
  return nearestEffort(wanted, listed);
}
