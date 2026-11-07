/**
 * Whether a scan's file is there to read: Pyxis's stored copy, or a file in a linked folder that the last look found.
 * A linked scan has no stored copy, so the copy alone would call it missing and hide "Read the scan".
 */
export function hasScanFile(source: { blobSha: string | null; linked?: { missing: boolean } | null }): boolean {
  return !!source.blobSha || (!!source.linked && !source.linked.missing);
}
