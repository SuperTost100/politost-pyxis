import type Database from "better-sqlite3";
import { z } from "zod";
import { generate, type GenerateInput } from "../engine/generate";
import { contentLanguage, systemPrompt } from "../engine/prompts";
import { selectionFor } from "../engine/selection";
import { readProfile } from "../profile/profile";

// PLAN-10: a plan without material is two model calls with the student's choices in between.
// Nothing is stored here. The edited tree comes back through plans.create as `draftTopics`.

const moduleSchema = z.object({
  modules: z
    .array(
      z.object({
        title: z.string().min(1).max(160),
        summary: z.string().min(1).max(600),
      }),
    )
    .min(1)
    .max(12),
});
const treeSchema = z.object({
  topics: z
    .array(
      z.object({
        title: z.string().min(1).max(160),
        summary: z.string().min(1).max(1200),
        subtopics: z.array(z.string().min(1).max(160)).max(30),
      }),
    )
    .min(1)
    .max(15),
});

type Context = {
  subject: string;
  semesters: string[];
  language: "it" | "en";
};

function context(db: Database.Database, input: Context) {
  const profile = readProfile(db);
  return {
    subject: input.subject,
    semesters: input.semesters,
    level: profile?.educationLevel ?? null,
    school: profile?.school || null,
    course: profile?.course || null,
  };
}

export async function proposeModules(
  db: Database.Database,
  input: Context,
  signal?: AbortSignal,
  run?: GenerateInput["run"],
) {
  const result = await generate({
    selection: selectionFor(db, "plan"),
    signal,
    run,
    schema: moduleSchema,
    system: systemPrompt("plan.modules", {
      contentLanguage: contentLanguage(db, input.language),
    }),
    prompt: JSON.stringify(context(db, input)),
  });
  return result.data as z.infer<typeof moduleSchema>;
}

export async function proposeTree(
  db: Database.Database,
  input: Context & {
    style: "read" | "practice" | "decide";
    modules: Array<{ title: string; summary: string; focus: boolean }>;
  },
  signal?: AbortSignal,
  run?: GenerateInput["run"],
) {
  const result = await generate({
    selection: selectionFor(db, "plan"),
    signal,
    run,
    schema: treeSchema,
    system: systemPrompt("plan.tree", {
      contentLanguage: contentLanguage(db, input.language),
    }),
    prompt: JSON.stringify({
      ...context(db, input),
      style: input.style,
      modules: input.modules,
    }),
  });
  return result.data as z.infer<typeof treeSchema>;
}
