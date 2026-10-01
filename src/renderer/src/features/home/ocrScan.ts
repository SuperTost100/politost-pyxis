import { getDocument, GlobalWorkerOptions } from "pdfjs-dist/legacy/build/pdf.mjs";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.mjs?url";
import { invoke } from "../../lib/ipc";

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

/** Render each PDF page to a PNG and send the pixels to OCR. */
export async function ocrPdfBlob(sourceId: string, sha: string): Promise<void> {
  GlobalWorkerOptions.workerSrc = workerUrl;
  const response = await fetch(`pyxis-blob://${sha}`);
  if (!response.ok) throw new Error("blob-missing");
  const data = new Uint8Array(await response.arrayBuffer());
  const doc = await getDocument({
    data,
    isEvalSupported: false,
    useSystemFonts: true,
  }).promise;
  const count = doc.numPages;
  for (let pageNumber = 1; pageNumber <= count; pageNumber += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    const page = await doc.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1.5 });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("canvas-missing");
    await page.render({ canvasContext: context, viewport }).promise;
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("png-missing");
    const png = new Uint8Array(await blob.arrayBuffer());
    await invoke("sources.ocrImage", {
      sourceId,
      pngBase64: bytesToBase64(png),
      page: pageNumber,
      last: pageNumber === count,
    });
  }
  await doc.destroy();
}
