import { SCAN_KINDS } from "../../../shared/source-types";

/**
 * Whether a scan's file is there to read: Pyxis's stored copy, or a file in a linked folder that the last look found.
 * A linked scan has no stored copy, so the copy alone would call it missing and hide "Read the scan".
 */
export function hasScanFile(source: { blobSha: string | null; linked?: { missing: boolean } | null }): boolean {
  return !!source.blobSha || (!!source.linked && !source.linked.missing);
}

/**
 * A scan whose OCR found no text is marked failed with no sections. It can be read again, so it keeps the scan notice. A
 * failed import names its error, and has nothing to read.
 */
export function scanFoundNothing(source: {
  kind: string;
  status: string;
  sections: number;
  blobSha: string | null;
  linked?: { missing: boolean } | null;
  error?: string;
}): boolean {
  return (
    source.status === "failed" &&
    SCAN_KINDS.includes(source.kind) &&
    source.sections === 0 &&
    hasScanFile(source) &&
    !source.error
  );
}
