/** What the student can do with a picture in a message: keep it as a PNG file or put it on the clipboard. */

/** The bytes of a data URL, read here because the page's content policy lets `fetch` open `pyxis-blob:` but not `data:`. */
function dataUrlBlob(url: string): Blob {
  const comma = url.indexOf(",");
  const head = url.slice(5, comma);
  const type = head.split(";")[0] || "application/octet-stream";
  const body = url.slice(comma + 1);
  if (!head.endsWith(";base64")) return new Blob([decodeURIComponent(body)], { type });
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type });
}

async function sourceBlob(src: string): Promise<Blob> {
  if (src.startsWith("data:")) return dataUrlBlob(src);
  const response = await fetch(src);
  if (!response.ok) throw new Error("image-unavailable");
  return response.blob();
}

/** The picture as PNG: the clipboard takes no other image type, and a download has one type to name. */
export async function pngBlob(src: string): Promise<Blob> {
  const blob = await sourceBlob(src);
  if (blob.type === "image/png") return blob;
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("image-unavailable");
    context.drawImage(bitmap, 0, 0);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((png) => (png ? resolve(png) : reject(new Error("image-unavailable"))), "image/png"),
    );
  } finally {
    bitmap.close();
  }
}

async function base64Of(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Asks where to keep the picture, as a PNG named `filename`. Resolves to whether it was saved. */
export async function saveImage(src: string, filename: string): Promise<boolean> {
  const base64 = await base64Of(await pngBlob(src));
  return (await window.pyxis.saveArtifact({ filename, base64 })) === "saved";
}

export async function copyImage(src: string): Promise<void> {
  await navigator.clipboard.write([new ClipboardItem({ "image/png": pngBlob(src) })]);
}
