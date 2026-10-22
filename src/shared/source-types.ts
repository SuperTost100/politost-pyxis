/** Photos, without the dot. */
export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "heic", "heif"] as const;
/** Documents the extractors read, without the dot. */
export const DOCUMENT_EXTENSIONS = ["pdf", "docx", "pptx", "txt", "md"] as const;
/** Extensions the library imports, without the dot. The picker, a dropped file and a folder scan all use this list. */
export const SOURCE_EXTENSIONS = ["ptsb", ...DOCUMENT_EXTENSIONS, ...IMAGE_EXTENSIONS] as const;

/** Replacing a source needs a document the extractors can version, not a photo. */
export const REPLACE_EXTENSIONS = DOCUMENT_EXTENSIONS;

/** A folder scan lists this many files, and does not open folders nested deeper. It says so when either cuts the list. */
export const MAX_FOLDER_FILES = 2000;
export const MAX_FOLDER_DEPTH = 12;
/** A folder scan stops after reading this many entries, files and folders alike, importable or not. */
export const MAX_FOLDER_ENTRIES = 20_000;

/** The most files one drop can hand to main. */
export const MAX_DROPPED_FILES = 20;

/** The most one imported document may weigh. Reads check the size first, so a larger file never gets a buffer. */
export const MAX_SOURCE_BYTES = 256 * 1024 * 1024;
/** Photos are capped lower. A decoded phone photo takes about 4 bytes a pixel. */
export const MAX_IMAGE_BYTES = 40 * 1024 * 1024;
/** The longest base64 text of a photo at that cap, so a page sent as text is bounded before anything decodes it. */
export const MAX_IMAGE_BASE64 = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;
const DOTTED_IMAGES = new Set<string>(IMAGE_EXTENSIONS.map((ext) => `.${ext}`));

/** Whether an extension with the dot, in any case, names a photo. */
export function isImageExt(ext: string): boolean {
  return DOTTED_IMAGES.has(ext.toLowerCase());
}

/** Size cap for one imported file, from its extension with the dot. */
export function maxSourceBytes(ext: string): number {
  return isImageExt(ext) ? MAX_IMAGE_BYTES : MAX_SOURCE_BYTES;
}
