import sourceTranscribe from "../../../resources/prompts/source.transcribe.md?raw";
import exerciseGenerate from "../../../resources/prompts/exercise.generate.md?raw";
import cardsGenerate from "../../../resources/prompts/cards.generate.md?raw";
import gapDrill from "../../../resources/prompts/gap.drill.md?raw";
import gapExplain from "../../../resources/prompts/gap.explain.md?raw";
import gapInsight from "../../../resources/prompts/gap.insight.md?raw";
import chatChecks from "../../../resources/prompts/chat.checks.md?raw";
import chatGeneral from "../../../resources/prompts/chat.general.md?raw";
import chatSocratic from "../../../resources/prompts/chat.socratic.md?raw";
import chatSolver from "../../../resources/prompts/chat.solver.md?raw";
import lessonWrite from "../../../resources/prompts/lesson.write.md?raw";
import mapEdit from "../../../resources/prompts/map.edit.md?raw";
import mapGenerate from "../../../resources/prompts/map.generate.md?raw";
import planDiagnostic from "../../../resources/prompts/plan.diagnostic.md?raw";
import planModules from "../../../resources/prompts/plan.modules.md?raw";
import planTree from "../../../resources/prompts/plan.tree.md?raw";
import planIntro from "../../../resources/prompts/plan.intro.md?raw";
import planSynopsis from "../../../resources/prompts/plan.synopsis.md?raw";
import planTopics from "../../../resources/prompts/plan.topics.md?raw";
import quizBatch from "../../../resources/prompts/quiz.batch.md?raw";
import quizOpenGrade from "../../../resources/prompts/quiz.open-grade.md?raw";
import simulationGrade from "../../../resources/prompts/simulation.grade.md?raw";
import simulationQuestions from "../../../resources/prompts/simulation.questions.md?raw";
import citationPartial from "../../../resources/prompts/partials/citation.md?raw";
import type Database from "better-sqlite3";

/** Templates and partials are bundled as raw strings, so there is no runtime file path. */
export const PARTIAL_SOURCES = {
  citation: citationPartial,
} as const;

export type PartialId = keyof typeof PARTIAL_SOURCES;

export const TEMPLATE_SOURCES = {
  "source.transcribe": sourceTranscribe,
  "exercise.generate": exerciseGenerate,
  "cards.generate": cardsGenerate,
  "gap.drill": gapDrill,
  "gap.explain": gapExplain,
  "gap.insight": gapInsight,
  "chat.checks": chatChecks,
  "chat.general": chatGeneral,
  "chat.socratic": chatSocratic,
  "chat.solver": chatSolver,
  "lesson.write": lessonWrite,
  "map.edit": mapEdit,
  "map.generate": mapGenerate,
  "plan.diagnostic": planDiagnostic,
  "plan.intro": planIntro,
  "plan.synopsis": planSynopsis,
  "plan.modules": planModules,
  "plan.tree": planTree,
  "plan.topics": planTopics,
  "quiz.batch": quizBatch,
  "quiz.open-grade": quizOpenGrade,
  "simulation.grade": simulationGrade,
  "simulation.questions": simulationQuestions,
} as const;

export type TemplateId = keyof typeof TEMPLATE_SOURCES;

export type PromptTemplate = {
  id: TemplateId;
  version: string;
  schema: string;
  feature: string;
  body: string;
};

// Identifier placeholders only; literal blanks such as {{1}} are not placeholders.
const PLACEHOLDER = /\{\{([A-Za-z_]\w*)\}\}/g;

export function parseTemplate(id: TemplateId, source: string): PromptTemplate {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(source);
  if (!match) throw new Error(`prompt-template-invalid:${id}`);
  const meta: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon > 0)
      meta[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  const { version, schema, feature } = meta;
  if (!version || !schema || !feature)
    throw new Error(`prompt-template-invalid:${id}`);
  return { id, version, schema, feature, body: match[2]!.trim() };
}

// Partials are included by name, e.g. {{> citation}}, and only from PARTIAL_SOURCES.
const PARTIAL = /\{\{>\s*([A-Za-z_]\w*)\s*\}\}/g;

export function placeholders(template: PromptTemplate): string[] {
  return [
    ...new Set([...template.body.matchAll(PLACEHOLDER)].map((m) => m[1]!)),
  ];
}

export function partialsOf(template: PromptTemplate): PartialId[] {
  return [
    ...new Set([...template.body.matchAll(PARTIAL)].map((m) => m[1]!)),
  ] as PartialId[];
}

export function partialText(id: PartialId): string {
  return PARTIAL_SOURCES[id].trim();
}

/** Prompt wording for a stored language code; stored plan values are codes, profile values are names. */
export function languageName(
  stored: string | null | undefined,
  fallback = "Italian",
): string {
  const value = stored?.trim();
  if (!value) return fallback;
  const names: Record<string, string> = { it: "Italian", en: "English" };
  return names[value.toLowerCase()] ?? value;
}

/** Plan content language, falling back to the profile's interface language. */
export function contentLanguage(
  db: Database.Database,
  stored?: string | null,
): string {
  if (stored?.trim()) return languageName(stored);
  const row = db
    .prepare("SELECT content_language FROM profile LIMIT 1")
    .get() as { content_language: string | null } | undefined;
  return languageName(row?.content_language);
}

export function planLanguage(db: Database.Database, planId: string): string {
  const row = db
    .prepare("SELECT content_language FROM plans WHERE id = ?")
    .get(planId) as { content_language: string | null } | undefined;
  return contentLanguage(db, row?.content_language);
}

export function loadTemplate(id: TemplateId): PromptTemplate {
  return parseTemplate(id, TEMPLATE_SOURCES[id]);
}

/** Fills every placeholder; a missing or unused value throws so callers cannot drift from the template. */
export function renderTemplate(
  id: TemplateId,
  values: Record<string, string> = {},
): { text: string; template: string; version: string } {
  const template = loadTemplate(id);
  const needed = placeholders(template);
  const given = Object.keys(values);
  if (
    needed.some((name) => !given.includes(name)) ||
    given.some((name) => !needed.includes(name))
  ) {
    throw new Error(`prompt-placeholders:${id}`);
  }
  const text = template.body
    .replace(PARTIAL, (_, name: string) => {
      if (!(name in PARTIAL_SOURCES)) throw new Error(`prompt-partial:${id}`);
      return partialText(name as PartialId);
    })
    .replace(PLACEHOLDER, (_, name: string) => values[name]!);
  return { text, template: id, version: template.version };
}

/** System text; `values` must supply exactly the template's placeholders. */
export function systemPrompt(
  id: TemplateId,
  values: Record<string, string> = {},
): string {
  return renderTemplate(id, values).text;
}

/** Provenance for the items, maps and messages a template generated. */
export function promptProvenance(id: TemplateId): {
  template: TemplateId;
  version: string;
} {
  return { template: id, version: templateVersion(id) };
}

export function templateVersion(id: TemplateId): string {
  return loadTemplate(id).version;
}
