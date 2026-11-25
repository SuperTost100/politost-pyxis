import { scanPictures } from "./documents";
import type { OcrPage } from "./ocr";
import { withOcrWorker } from "./recognize";
import { assertDecodable, sniffImage, uprightForOcr } from "./vision-image";

/**
 * Reads `pages` of a scanned .docx or .pptx with local OCR, in one worker thread: page N is its Nth picture in reading
 * order (`scanPictures`). Pages past the end are skipped, and the picture count comes back so the caller learns it on its
 * first batch. A picture the decoder refuses (too large, or not really a PNG or JPEG) reads as blank, so one bad picture
 * does not stop the rest. Runs in the extract worker.
 */
export async function ocrScanPictures(
  bytes: Uint8Array,
  ext: string,
  pages: number[],
  tess: string,
  scratch?: string,
): Promise<{ count: number; pages: OcrPage[] }> {
  const pictures = scanPictures(bytes, ext);
  const wanted = pages.filter((page) => page >= 1 && page <= pictures.length);
  const read = wanted.length
    ? await withOcrWorker(
        tess,
        async (recognize) => {
          const out: OcrPage[] = [];
          for (const page of wanted) {
            const picture = pictures[page - 1]!;
            const pixels = decodable(picture.read());
            out.push({ page, section: picture.section, text: pixels ? await recognize(pixels) : "" });
          }
          return out;
        },
        { scratch },
      )
    : [];
  return { count: pictures.length, pages: read };
}

/** The picture turned upright for OCR, or null when the decoder refuses it, with the same header checks every decode has. */
function decodable(bytes: Uint8Array | undefined): Uint8Array | null {
  const mime = bytes ? sniffImage(bytes) : null;
  if (!bytes || !mime) return null;
  try {
    assertDecodable(bytes, mime);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("vision-image-")) return null;
    throw error;
  }
  return uprightForOcr(bytes);
}
