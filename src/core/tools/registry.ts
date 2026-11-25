import type Database from "better-sqlite3";
import { flashcardsTool } from "./flashcards";
import { mapTool } from "./map";
import { progressTool } from "./progress";
import { proposeDeleteTool } from "./proposeDelete";
import { proposeExamTool } from "./proposeExam";
import { proposePathTool } from "./proposePath";
import { quizTool } from "./quiz";
import type { Tool } from "./server";

/**
 * The tools the model answering a chat may call. A new tool is a file beside `flashcards.ts` that returns a `Tool`
 * (name, description, Zod input, run) and one line here; the server lists and validates it, the chat shows its working
 * state while it runs and its stored result where the model called it. The map and the quiz are made by background jobs,
 * so they are offered only where core has a job runner (`setToolRunner`), as are a new exam, built by its own job, and a
 * deletion, which stops the jobs of a quiz it takes. The `propose_*` tools change nothing: the student decides
 * (`proposals.ts`).
 */
export function chatToolList(db: Database.Database, jobs: boolean): Tool[] {
  return [
    flashcardsTool(db),
    progressTool(db),
    proposePathTool(db),
    ...(jobs ? [mapTool(db), quizTool(db), proposeExamTool(db), proposeDeleteTool(db)] : []),
  ];
}
