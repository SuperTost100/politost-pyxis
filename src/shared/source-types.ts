/** Extensions the library imports, without the dot. The picker, a dropped file and a folder scan all use this list. */
export const SOURCE_EXTENSIONS = [
  "ptsb",
  "pdf",
  "docx",
  "pptx",
  "txt",
  "md",
  "png",
  "jpg",
  "jpeg",
  "webp",
  "heic",
  "heif",
] as const;

/** Replacing a source needs a document the extractors can version, not a photo. */
export const REPLACE_EXTENSIONS = ["pdf", "docx", "pptx", "txt", "md"] as const;

/** A folder scan lists this many files, and does not open folders nested deeper. It says so when either cuts the list. */
export const MAX_FOLDER_FILES = 2000;
export const MAX_FOLDER_DEPTH = 12;

/** The most files one drop can hand to main. */
export const MAX_DROPPED_FILES = 20;

/** The most one imported document may weigh. Reads check the size first, so a larger file never gets a buffer. */
export const MAX_SOURCE_BYTES = 256 * 1024 * 1024;
/** Photos are capped lower. A decoded phone photo takes about 4 bytes a pixel. */
export const MAX_IMAGE_BYTES = 40 * 1024 * 1024;
/** The longest base64 text of a photo at that cap, so a page sent as text is bounded before anything decodes it. */
export const MAX_IMAGE_BASE64 = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".heic", ".heif"]);

/** Size cap for one imported file, from its extension with the dot. */
export function maxSourceBytes(ext: string): number {
  return IMAGE_EXTENSIONS.has(ext.toLowerCase()) ? MAX_IMAGE_BYTES : MAX_SOURCE_BYTES;
}
