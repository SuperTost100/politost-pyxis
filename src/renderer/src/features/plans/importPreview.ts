import {
  PLAN_FILE_PARTS,
  PLAN_FILE_REASONS,
  planFileReason,
  planFileSchema,
  type PlanFile,
  type PlanFilePart,
  type PlanFileReason,
} from "../../../../shared/plan-file";

/** Resolve originals separately from the quoted passages already used by the plan. */
export type SourceChoice = "library" | "file" | "excerpts" | "skip";
export type PreviewSource = {
  index: number;
  title: string;
  bytes: number;
  embedded: boolean;
  /** Passages of this source the plan keeps as text excerpts. */
  excerpts: number;
  /** Library source with the same content hash. */
  libraryId?: string;
};
export type PlanPreview = {
  title: string;
  author?: string;
  createdAt?: number;
  language?: "it" | "en" | null;
  counts: Record<
    "topics" | "lessons" | "quizzes" | "cards" | "maps" | "exercises",
    number
  >;
  progress: boolean;
  /** Active topics the model wrote without source material (PLAN-11). */
  generalTopics: number;
  sources: PreviewSource[];
  missing: PreviewSource[];
};

/**
 * Parses with the one plan-file schema. A file that is not a plan says why: not JSON or no plan version at all
 * (`not-a-plan`), a version this app does not know, a source over the limit, or any other damage.
 */
export function readPlanText(text: string): { file: PlanFile } | { reason: PlanFileReason } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { reason: "not-a-plan" };
  }
  if (!value || typeof value !== "object" || typeof (value as { version?: unknown }).version !== "number")
    return { reason: "not-a-plan" };
  const parsed = planFileSchema.safeParse(value);
  return parsed.success ? { file: parsed.data } : { reason: planFileReason(parsed.error.issues) };
}

/** Parses with the one plan-file schema; null means the file is not a valid plan. */
export function parsePlanText(text: string): PlanFile | null {
  const read = readPlanText(text);
  return "file" in read ? read.file : null;
}

/** Why `plans.import` refused a file, and the parts of it the plan can go without, from the error the core sent. */
export function importFailure(error: unknown): { reason: PlanFileReason; without: PlanFilePart[] } | null {
  const body = error as { code?: unknown; detail?: unknown; params?: { without?: unknown } } | null;
  if (body?.code !== "plan-file") return null;
  const reason = PLAN_FILE_REASONS.find((known) => known === body.detail);
  if (!reason) return null;
  const named = typeof body.params?.without === "string" ? body.params.without.split(",") : [];
  return { reason, without: PLAN_FILE_PARTS.filter((part) => named.includes(part)) };
}

export function previewPlan(
  file: PlanFile,
  library: ReadonlyArray<{ id: string; blobSha: string | null }>,
): PlanPreview {
  const items = file.items ?? [];
  const sources = (file.sources ?? []).map((source, index) => {
    const libraryId = source.sha
      ? library.find((row) => row.blobSha === source.sha)?.id
      : undefined;
    return {
      index,
      title: source.title,
      bytes: source.bytes,
      embedded: source.data !== undefined,
      excerpts: (file.passages ?? []).filter(
        (passage) => source.id !== undefined && passage.sourceId === source.id,
      ).length,
      ...(libraryId ? { libraryId } : {}),
    };
  });
  return {
    title: file.title,
    author: file.author,
    createdAt: file.createdAt,
    language: file.language,
    counts: {
      topics: file.topics.length,
      lessons: items.filter((item) => item.kind === "lesson").length,
      quizzes: items.filter((item) => item.kind === "quiz").length,
      cards: file.cards.length,
      maps: (file.maps ?? []).reduce((sum, map) => sum + map.entries.length, 0),
      exercises: (file.exercises ?? []).length,
    },
    progress: (file.progress ?? []).length > 0,
    generalTopics: file.topics.filter(
      (topic) => !topic.archived && topic.grounding === "general",
    ).length,
    sources,
    missing: sources.filter((source) => !source.embedded),
  };
}

/** Default per missing source: reuse the library copy when it is there, else keep excerpts only. */
export function defaultChoices(
  preview: PlanPreview,
): Record<number, SourceChoice> {
  return Object.fromEntries(
    preview.missing.map((source) => [
      source.index,
      source.libraryId ? "library" : "excerpts",
    ]),
  );
}

export type ImportRequest = PlanFile & {
  /** Parts of the file to leave out, after the student agreed to a plan without them. */
  without?: PlanFilePart[];
  /** Source index -> library source whose stored original replaces the missing one; main checks the hash. */
  libraryFor?: Record<string, string>;
};

export function importRequest(
  file: PlanFile,
  preview: PlanPreview,
  choices: Record<number, SourceChoice>,
  located: Record<number, string>,
): ImportRequest {
  const libraryFor: Record<string, string> = {};
  const skipped = new Set<string>();
  const sources: NonNullable<PlanFile["sources"]> = [];
  (file.sources ?? []).forEach((source, index) => {
    const choice = choices[index];
    if (choice === "skip") {
      if (source.id) skipped.add(source.id);
      return;
    }
    const next = sources.length;
    const libraryId = preview.sources[index]?.libraryId;
    if (choice === "library" && libraryId && source.data === undefined)
      libraryFor[String(next)] = libraryId;
    sources.push(
      choice === "file" && located[index]
        ? { ...source, data: located[index] }
        : source,
    );
  });
  return {
    ...file,
    sources,
    documents: file.documents?.filter(
      (document) => !skipped.has(document.sourceId),
    ),
    passages: file.passages?.map((passage) =>
      passage.sourceId && skipped.has(passage.sourceId)
        ? { ...passage, sourceId: null, documentId: null, sourceSha: null }
        : passage,
    ),
    exercises: file.exercises?.map((exercise) =>
      exercise.sourceId && skipped.has(exercise.sourceId)
        ? { ...exercise, sourceId: null }
        : exercise,
    ),
    ...(Object.keys(libraryFor).length ? { libraryFor } : {}),
  };
}

function toBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
}

/** Accepts a located file only when size and SHA-256 match what the plan expects. */
export async function locatedData(
  source: { bytes: number; sha: string | null },
  file: Blob,
): Promise<string | null> {
  if (file.size !== source.bytes) return null;
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length !== source.bytes) return null;
  if (source.sha) {
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const hex = Array.from(new Uint8Array(digest), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
    if (hex !== source.sha) return null;
  }
  return toBase64(bytes);
}
