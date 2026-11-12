import type { FileKind } from "@shared/file-kind";

/**
 * A file's kind in words, then its file type when that adds something: "Esercizi · PDF", but "Foto" alone for a photo
 * and "Slide" alone for a PowerPoint file.
 */
export function kindWords(
  source: { kind: string; fileKind: FileKind },
  t: (key: string, options?: Record<string, unknown>) => string,
): string[] {
  const kind = t(`sources.fileKind.${source.fileKind}`);
  const type = t(`sources.kind.${source.kind}`, { defaultValue: source.kind });
  return source.kind === "image" || type === kind ? [kind] : [kind, type];
}
