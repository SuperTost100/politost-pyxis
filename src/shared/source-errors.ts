/**
 * The message for each error code a source import or a source request stops with. Core raises these keys on IPC
 * errors, and the renderer shows them for a background job that stopped, whose record keeps only the raw code.
 */
const SOURCE_ERROR_KEYS: Record<string, string> = {
  "encrypted-smartbook": "sources.encrypted",
  "licensed-smartbook": "sources.encrypted",
  "smartbook-json-missing": "sources.smartbookBroken",
  "chapter-missing": "sources.smartbookBroken",
  "not-smartbook": "sources.smartbookBroken",
  "archive-too-large": "sources.archiveTooLarge",
  "archive-corrupt": "sources.archiveUnreadable",
  "archive-unsupported": "sources.archiveUnreadable",
  "source-worker-memory": "sources.workerMemory",
  "paste-short": "sources.pasteShort",
  "page-empty": "sources.pageEmpty",
  "link-scheme": "sources.linkScheme",
  "link-failed": "sources.linkFailed",
  "link-timeout": "sources.linkFailed",
  "link-redirect": "sources.linkFailed",
  "link-too-big": "sources.linkFailed",
  "heic-invalid": "sources.importFailed",
  "heic-too-large": "sources.importFailed",
  "heic-decoder-unavailable": "sources.importFailed",
  "source-too-big": "sources.tooBig",
  "source-changed": "sources.changed",
  "source-unreadable": "sources.unreadable",
  "vision-image-unsupported": "sources.imageUnsupported",
  "vision-image-too-large": "sources.imageTooLarge",
  "ocr-data-missing": "sources.ocrDataMissing",
  "ocr-data-integrity": "sources.ocrDataIntegrity",
  "ocr-data-offline": "sources.ocrDataOffline",
  "ocr-data-download": "sources.ocrDataOffline",
  "ocr-data-too-big": "sources.ocrDataIntegrity",
  "ocr-data-declined": "sources.ocrDataMissing",
  "embed-hash": "sources.embedHash",
  "embed-unpinned": "sources.embedHash",
  "source-missing": "sources.importFailed",
  "source-file-missing": "sources.fileMissing",
  "ocr-out-of-order": "sources.ocrInterrupted",
  "ocr-not-active": "sources.ocrInterrupted",
  "ocr-stale": "sources.ocrInterrupted",
  "source-busy": "sources.busy",
  "reextract-unavailable": "sources.reextractUnavailable",
  "reextract-no-text": "sources.reextractNoText",
  "replace-no-text": "sources.replaceNoText",
  "title-empty": "sources.titleEmpty",
  "books-offline": "sources.books.offline",
  "books-catalog": "sources.books.catalog",
  "books-too-big": "sources.books.catalog",
  "books-integrity": "sources.books.integrity",
  "books-missing": "sources.books.missing",
  "book-up-to-date": "sources.books.upToDate",
};

/** The message key for a source error code, or null when the code has no specific message. */
export function sourceErrorKey(code: string): string | null {
  // A photo import stops when the vision engine's data notice is not confirmed (`engine-disclosure-required`, or
  // a confirmation that timed out or was cancelled).
  if (code.startsWith("engine-disclosure")) return "engines.errors.disclosure-required";
  return SOURCE_ERROR_KEYS[code] ?? null;
}

/** Every message key the map can return, so a test can check that each one exists in both languages. */
export const SOURCE_ERROR_MESSAGE_KEYS = [
  ...new Set([...Object.values(SOURCE_ERROR_KEYS), "engines.errors.disclosure-required"]),
];
