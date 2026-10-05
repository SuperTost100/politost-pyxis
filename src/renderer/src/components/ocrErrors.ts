/** The message keys core raises when a photo, scan or chat image is refused for lack of local OCR data. */
const refusals = [
  "sources.ocrDataMissing",
  "sources.ocrDataIntegrity",
  "sources.ocrDataOffline",
];
export const isOcrRefusal = (key: string | null | undefined): key is string =>
  key != null && refusals.includes(key);

/** The plain message for a raw code the download job (or a read that needed its data) stopped with. */
export function ocrErrorKey(code: string): string | null {
  const found =
    /ocr-data-(offline|download|too-big|declined|integrity|missing)/.exec(
      code,
    )?.[1];
  if (!found) return null;
  return found === "missing"
    ? "sources.ocrDataMissing"
    : `sources.ocrData.errors.${found}`;
}
