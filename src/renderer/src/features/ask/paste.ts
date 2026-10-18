/** `tools.stagePng` takes PNGs up to 3 MB; this many base64 characters, with its prefix, stays under that. */
const STAGE_MAX_CHARS = 3_900_000;

/**
 * A pasted image as a PNG data URL `tools.stagePng` accepts. Screenshots arrive as PNG already; anything else is
 * redrawn, and an image too large to stage is scaled down until it fits.
 */
export async function pastedPng(image: Blob): Promise<string> {
  if (image.type === "image/png" && image.size <= (STAGE_MAX_CHARS * 3) / 4 - 64)
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error ?? new Error("png-invalid"));
      reader.readAsDataURL(image);
    });
  const bitmap = await createImageBitmap(image);
  try {
    let scale = 1;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const url = canvas.toDataURL("image/png");
      if (url.length <= STAGE_MAX_CHARS) return url;
      scale *= 0.75;
    }
    throw new Error("png-invalid");
  } finally {
    bitmap.close();
  }
}
