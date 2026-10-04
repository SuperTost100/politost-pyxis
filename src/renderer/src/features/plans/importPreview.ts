import { planFileSchema, type PlanFile } from "../../../../shared/plan-file";

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
  createdAt?: number;
  language?: "it" | "en" | null;
  counts: Record<
    "topics" | "lessons" | "quizzes" | "cards" | "maps" | "exercises",
    number
  >;
  progress: boolean;
  sources: PreviewSource[];
  missing: PreviewSource[];
};

/** Parses with the one plan-file schema; null means the file is not a valid plan. */
export function parsePlanText(text: string): PlanFile | null {
  try {
    const parsed = planFileSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
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
