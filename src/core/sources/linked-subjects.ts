import { extname } from "node:path";
import type Database from "better-sqlite3";
import { z } from "zod";
import { generate, type GenerateInput } from "../engine/generate";
import { contentLanguage, systemPrompt } from "../engine/prompts";
import { selectionFor } from "../engine/selection";
import { isAbort } from "../../shared/ipc";
import { MATERIAL_KINDS, MAX_SUBJECT_NAME, type LinkMode, type MaterialKind } from "../../shared/linked-folders";

/** One folder that may be a subject: its own name and the names of the files under it, relative to it. */
export type FolderCandidate = { folder: string; files: string[] };

export type DetectedSubject = {
  folder: string;
  /** The subject name to offer, tidied by the model or the folder's own name. */
  name: string;
  /** False when the folder does not look like study material, so setup offers to skip it. */
  study: boolean;
  kinds: MaterialKind[];
};

export type Detection = { by: "ai" | "names"; subjects: DetectedSubject[] };

/** What one call sends, at most: enough names to tell a subject's material apart, never a whole tree. */
const MAX_FOLDERS_SENT = 60;
const MAX_FILES_SENT = 40;
const MAX_NAME_SENT = 160;
/** A model that has not answered by then is not waited for: setup goes on with the folder names. */
const DETECT_TIMEOUT_MS = 60_000;

const answerSchema = z.object({
  folders: z
    .array(
      z.object({
        folder: z.string().max(400),
        subject: z.string().max(400),
        study: z.boolean(),
        kinds: z.array(z.enum(MATERIAL_KINDS)).max(MATERIAL_KINDS.length),
      }),
    )
    .max(MAX_FOLDERS_SENT),
});

/** Kinds read from file names and types alone, for when no model names them. Most frequent first. */
const KIND_PATTERNS: Array<[MaterialKind, RegExp]> = [
  ["exams", /esam|appell|\btemi\b|\btema\b|compit|prova|exam|midterm|final/],
  ["exercises", /eserci|exercis|problem|homework|\bes\d/],
  ["handouts", /dispens|handout/],
  ["notes", /appunt|riassunt|notes?\b|summary|schema/],
  ["slides", /slide|lezione|lecture|\blez\b/],
  ["book", /libro|book|manuale|textbook|volume/],
];

export function guessKinds(files: string[]): MaterialKind[] {
  const counts = new Map<MaterialKind, number>();
  for (const file of files) {
    const name = file.toLowerCase();
    const kinds = new Set<MaterialKind>();
    for (const [kind, pattern] of KIND_PATTERNS) if (pattern.test(name)) kinds.add(kind);
    if (extname(name) === ".pptx") kinds.add("slides");
    for (const kind of kinds) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || MATERIAL_KINDS.indexOf(a[0]) - MATERIAL_KINDS.indexOf(b[0]))
    .map(([kind]) => kind);
}

/** The folder's own name as a subject name: trimmed, and cut to what a subject holds. */
function plainName(folder: string): string {
  return folder.trim().slice(0, MAX_SUBJECT_NAME) || folder.slice(0, MAX_SUBJECT_NAME);
}

function byNames(candidates: FolderCandidate[]): Detection {
  return {
    by: "names",
    subjects: candidates.map((candidate) => ({
      folder: candidate.folder,
      name: plainName(candidate.folder),
      study: true,
      kinds: guessKinds(candidate.files),
    })),
  };
}

/**
 * Names the subjects of linked folders. One model call per 60 folders gets the folder names and the file names under
 * each, never any file's content, and tidies the names, flags folders that are not study material and names the kinds
 * of files. In `subject` mode the student picked each folder as a subject, so none is skipped. Without a ready engine,
 * or when a call fails or the calls take longer than the timeout, the folders it did not answer for keep their names
 * and nothing of theirs is skipped. Only the caller's own cancel is passed on.
 */
export async function detectSubjects(
  db: Database.Database,
  candidates: FolderCandidate[],
  options: { mode: LinkMode; signal?: AbortSignal; run?: GenerateInput["run"]; timeoutMs?: number },
): Promise<Detection> {
  const fallback = byNames(candidates);
  if (!candidates.length) return fallback;
  let selection: ReturnType<typeof selectionFor>;
  try {
    selection = selectionFor(db, "default");
  } catch {
    return fallback;
  }
  const timeout = AbortSignal.timeout(options.timeoutMs ?? DETECT_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const answers = new Map<string, z.infer<typeof answerSchema>["folders"][number]>();
  for (let at = 0; at < candidates.length; at += MAX_FOLDERS_SENT) {
    const sent = candidates.slice(at, at + MAX_FOLDERS_SENT).map((candidate) => ({
      folder: candidate.folder.slice(0, MAX_NAME_SENT),
      files: candidate.files.slice(0, MAX_FILES_SENT).map((file) => file.slice(0, MAX_NAME_SENT)),
    }));
    try {
      const result = await generate({
        prompt: JSON.stringify({ folders: sent }),
        system: systemPrompt("folders.subjects", { contentLanguage: contentLanguage(db) }),
        selection,
        schema: answerSchema,
        signal,
        run: options.run,
      });
      for (const item of (result.data as z.infer<typeof answerSchema>).folders) answers.set(item.folder, item);
    } catch (err) {
      if (options.signal?.aborted) throw err;
      if (!timeout.aborted && !isAbort(err)) console.error("pyxis-core: subject detection failed", err instanceof Error ? err.message : "unknown");
      break;
    }
  }
  if (!answers.size) return fallback;
  return {
    by: "ai",
    subjects: fallback.subjects.map((plain) => {
      const item = answers.get(plain.folder.slice(0, MAX_NAME_SENT));
      if (!item) return plain;
      const name = item.subject.replace(/\s+/g, " ").trim();
      return {
        folder: plain.folder,
        name: name && name.length <= MAX_SUBJECT_NAME ? name : plain.name,
        study: options.mode === "subject" ? true : item.study,
        kinds: [...new Set(item.kinds)],
      };
    }),
  };
}

/** Loose file names one call sorts. */
export const MAX_LOOSE_SENT = 100;

/**
 * One call of a sorter: the default feature's engine, the same time limit as naming folders, and the answer checked
 * against `schema`. `no-engine` without a ready engine, `failed` when the call fails or takes too long. Only the
 * caller's own cancel is passed on.
 */
async function askSorter<T>(
  db: Database.Database,
  template: "folders.sort" | "library.sort",
  prompt: unknown,
  schema: z.ZodType<T>,
  options: { signal?: AbortSignal; run?: GenerateInput["run"]; timeoutMs?: number },
): Promise<T | "no-engine" | "failed"> {
  let selection: ReturnType<typeof selectionFor>;
  try {
    selection = selectionFor(db, "default");
  } catch {
    return "no-engine";
  }
  const timeout = AbortSignal.timeout(options.timeoutMs ?? DETECT_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  try {
    const result = await generate({
      prompt: JSON.stringify(prompt),
      system: systemPrompt(template, { contentLanguage: contentLanguage(db) }),
      selection,
      schema,
      signal,
      run: options.run,
    });
    return result.data as T;
  } catch (err) {
    if (options.signal?.aborted) throw err;
    if (!timeout.aborted && !isAbort(err)) console.error("pyxis-core: file sorting failed", err instanceof Error ? err.message : "unknown");
    return "failed";
  }
}

const sortSchema = z.object({
  files: z
    .array(z.object({ file: z.string().max(400), folder: z.string().max(400) }))
    .max(MAX_LOOSE_SENT),
});

/**
 * Sorts files that lie loose at the top of a study folder into its subjects, by their names alone: one model call for
 * at most `MAX_LOOSE_SENT` names, never any file's content. Returns, for each file the model answered for, the
 * subfolder of its subject, or null when no subject clearly fits. Returns `no-engine` without a ready engine, and
 * `failed` when the call fails or takes longer than the timeout; either way the files stay without a subject. Only the
 * caller's own cancel is passed on.
 */
export async function sortLooseFiles(
  db: Database.Database,
  subjects: Array<{ folder: string; name: string }>,
  files: string[],
  options: { signal?: AbortSignal; run?: GenerateInput["run"]; timeoutMs?: number },
): Promise<Map<string, string | null> | "no-engine" | "failed"> {
  if (!subjects.length || !files.length) return new Map();
  const sent = files.slice(0, MAX_LOOSE_SENT);
  const folders = new Set(subjects.map((subject) => subject.folder));
  const answer = await askSorter(
    db,
    "folders.sort",
    {
      subjects: subjects.map((subject) => ({
        folder: subject.folder.slice(0, MAX_NAME_SENT),
        name: subject.name.slice(0, MAX_NAME_SENT),
      })),
      files: sent.map((file) => file.slice(0, MAX_NAME_SENT)),
    },
    sortSchema,
    options,
  );
  if (typeof answer === "string") return answer;
  // A folder name cut to what was sent is matched back to the folder it came from.
  const byShown = new Map(subjects.map((subject) => [subject.folder.slice(0, MAX_NAME_SENT), subject.folder]));
  const byFile = new Map(sent.map((file) => [file.slice(0, MAX_NAME_SENT), file]));
  const sorted = new Map<string, string | null>();
  for (const item of answer.files) {
    const file = byFile.get(item.file);
    if (file === undefined) continue;
    const folder = byShown.get(item.folder);
    sorted.set(file, folder !== undefined && folders.has(folder) ? folder : null);
  }
  return sorted;
}

/** Existing subject names one Library sort sends, at most, and how much of what a file is about. */
const MAX_SUBJECTS_SENT = 200;
const MAX_ABOUT_SENT = 400;

const librarySchema = z.object({
  files: z
    .array(z.object({ id: z.string().max(40), subject: z.string().max(400), newSubject: z.string().max(400) }))
    .max(MAX_LOOSE_SENT),
});

/**
 * Where a Library sort puts a file: a subject the student has (by the id it had when the call was made), a new one it
 * proposes, or none (null).
 */
export type LibraryPlacement = { subjectId: string } | { proposed: string } | null;

/**
 * Sorts files the student added to the Library into their subjects, as `sortLooseFiles` does for a linked folder: one
 * model call for at most `MAX_LOOSE_SENT` files, with the names of the subjects the student has. Each file goes with an
 * `id` that is its place in the call ("1", "2", ...) and its title beside it, and the model answers by `id`, so two
 * files with one title, or titles that only differ after the cut, never share an answer. Each file also goes with the
 * start of its text (`about`) once it is read, so a file called "scan 3.pdf" can still be placed. When no subject fits
 * but the file clearly belongs to one, the model proposes a new subject's name, the same name for files that belong
 * together; a proposed name that matches a subject the student has (in any case) is that subject. Returns, by the
 * file's place in `files`, where each answered file goes. A file the answer leaves out, or answers for with an `id`
 * that was not sent, is not in the map, and one that fits nowhere is null. `no-engine` and `failed` as for
 * `sortLooseFiles`.
 */
export async function sortLibraryFiles(
  db: Database.Database,
  subjects: Array<{ id: string; name: string }>,
  files: Array<{ title: string; about?: string }>,
  options: { signal?: AbortSignal; run?: GenerateInput["run"]; timeoutMs?: number },
): Promise<Map<number, LibraryPlacement> | "no-engine" | "failed"> {
  if (!files.length) return new Map();
  const sentFiles = files.slice(0, MAX_LOOSE_SENT);
  const sentSubjects = subjects.slice(0, MAX_SUBJECTS_SENT);
  const answer = await askSorter(
    db,
    "library.sort",
    {
      subjects: sentSubjects.map((subject) => subject.name.slice(0, MAX_NAME_SENT)),
      files: sentFiles.map((item, index) => ({
        id: String(index + 1),
        file: item.title.slice(0, MAX_NAME_SENT),
        ...(item.about ? { about: item.about.replace(/\s+/g, " ").trim().slice(0, MAX_ABOUT_SENT) } : {}),
      })),
    },
    librarySchema,
    options,
  );
  if (typeof answer === "string") return answer;
  const byName = new Map(sentSubjects.map((subject) => [subject.name.slice(0, MAX_NAME_SENT).toLocaleLowerCase(), subject.id]));
  const sorted = new Map<number, LibraryPlacement>();
  for (const item of answer.files) {
    const id = item.id.trim();
    const index = /^[1-9]\d*$/.test(id) ? Number(id) - 1 : -1;
    if (index < 0 || index >= sentFiles.length || sorted.has(index)) continue;
    const existing = byName.get(item.subject.trim().toLocaleLowerCase());
    const proposed = item.newSubject.replace(/\s+/g, " ").trim();
    const same = byName.get(proposed.toLocaleLowerCase());
    sorted.set(
      index,
      existing !== undefined
        ? { subjectId: existing }
        : same !== undefined
          ? { subjectId: same }
          : proposed && proposed.length <= MAX_SUBJECT_NAME
            ? { proposed }
            : null,
    );
  }
  return sorted;
}
