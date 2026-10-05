import { PNG } from "pngjs";

/** The stored original stays HEIC. These pixels only feed OCR, quality and vision. */
export const HEIC_EXT = new Set([".heic", ".heif"]);
export const MAX_HEIC_BYTES = 40 * 1024 * 1024;
/** Decoded RGBA is 4 bytes a pixel, so this caps the one big allocation near 200 MB. */
export const MAX_HEIC_PIXELS = 50_000_000;
export const HEIC_PNG_EDGE = 2560;

const BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"]);

export function isHeicExt(ext: string): boolean {
  return HEIC_EXT.has(ext.toLowerCase());
}

export function imageMime(ext: string): string {
  const lower = ext.toLowerCase();
  if (lower === ".png") return "image/png";
  if (lower === ".webp") return "image/webp";
  if (lower === ".heic") return "image/heic";
  if (lower === ".heif") return "image/heif";
  return "image/jpeg";
}

/** ISO BMFF `ftyp` box with a HEIF brand. Checked before any decoder sees the bytes. */
export function isHeicBytes(bytes: Uint8Array): boolean {
  if (bytes.length < 16) return false;
  const text = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  if (text(4, 8) !== "ftyp") return false;
  const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
  const end = Math.min(size >= 16 ? size : 16, bytes.length, 64);
  if (BRANDS.has(text(8, 12))) return true;
  for (let at = 16; at + 4 <= end; at += 4) if (BRANDS.has(text(at, at + 4))) return true;
  return false;
}

/** The slice of libheif-js used here: `new HeifDecoder().decode(bytes)` then `display`. */
export type HeifImage = {
  get_width(): number;
  get_height(): number;
  is_primary?(): boolean;
  display(
    target: { data: Uint8ClampedArray; width: number; height: number },
    done: (result: unknown) => void,
  ): void;
  free?(): void;
};
export type HeifApi = {
  HeifDecoder: new () => { decode(bytes: Uint8Array): HeifImage[]; free?(): void; decoder?: unknown };
  heif_context_free?: (context: unknown) => void;
};

async function loadLibheif(): Promise<HeifApi> {
  let mod: unknown;
  try {
    // The wasm-bundle build embeds the WASM, so no runtime path or asar unpack is needed.
    mod = (await import("libheif-js/wasm-bundle.js")).default;
  } catch {
    throw new Error("heic-decoder-unavailable");
  }
  const api = ((mod as { default?: unknown })?.default ?? mod) as HeifApi & {
    ready?: Promise<unknown>;
  };
  if (api.ready && typeof api.ready.then === "function") await api.ready;
  if (typeof api.HeifDecoder !== "function") throw new Error("heic-decoder-unavailable");
  return api;
}

/** Box-average RGBA down so the long edge is at most `edge`. The output is opaque. */
export function shrink(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  edge = HEIC_PNG_EDGE,
): { data: Buffer; width: number; height: number } {
  const scale = Math.max(1, Math.max(width, height) / edge);
  const outW = Math.max(1, Math.round(width / scale));
  const outH = Math.max(1, Math.round(height / scale));
  const out = Buffer.alloc(outW * outH * 4);
  for (let y = 0; y < outH; y += 1) {
    const y0 = Math.floor((y * height) / outH);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * height) / outH));
    for (let x = 0; x < outW; x += 1) {
      const x0 = Math.floor((x * width) / outW);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * width) / outW));
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = y0; sy < y1; sy += 1) {
        for (let sx = x0; sx < x1; sx += 1) {
          const i = (sy * width + sx) * 4;
          r += rgba[i] ?? 0;
          g += rgba[i + 1] ?? 0;
          b += rgba[i + 2] ?? 0;
        }
      }
      const n = (y1 - y0) * (x1 - x0);
      const o = (y * outW + x) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = 255;
    }
  }
  return { data: out, width: outW, height: outH };
}

/**
 * Decode the primary HEIC/HEIF image to a bounded PNG. Errors: `heic-invalid` (not HEIC,
 * corrupt or empty), `heic-too-large`, `heic-decoder-unavailable`.
 */
export async function heicToPng(
  bytes: Uint8Array,
  api?: HeifApi,
): Promise<{ png: Uint8Array; width: number; height: number }> {
  if (bytes.length > MAX_HEIC_BYTES) throw new Error("heic-too-large");
  if (!isHeicBytes(bytes)) throw new Error("heic-invalid");
  const heif = api ?? (await loadLibheif());
  const decoder = new heif.HeifDecoder();
  let images: HeifImage[] = [];
  try {
    try {
      images = decoder.decode(bytes);
    } catch {
      throw new Error("heic-invalid");
    }
    const image = images.find((image) => image.is_primary?.()) ?? images[0];
    if (!image) throw new Error("heic-invalid");
    const width = image.get_width();
    const height = image.get_height();
    if (!(width > 0 && height > 0)) throw new Error("heic-invalid");
    // Size is read from the header, so this rejects before the RGBA buffer exists.
    if (width * height > MAX_HEIC_PIXELS) throw new Error("heic-too-large");
    const target = { data: new Uint8ClampedArray(width * height * 4), width, height };
    const ok = await new Promise<boolean>((resolve) => {
      try {
        image.display(target, (result) => resolve(Boolean(result)));
      } catch {
        resolve(false);
      }
    });
    if (!ok) throw new Error("heic-invalid");
    const small = shrink(target.data, width, height);
    const png = new PNG({ width: small.width, height: small.height });
    small.data.copy(png.data);
    return { png: new Uint8Array(PNG.sync.write(png)), width: small.width, height: small.height };
  } finally {
    for (const image of images) {
      try {
        image.free?.();
      } catch {
        /* Freed already. */
      }
    }
    try {
      if (decoder.free) decoder.free();
      else if (decoder.decoder != null) heif.heif_context_free?.(decoder.decoder);
    } catch {
      /* Not every build exposes free. */
    }
  }
}
