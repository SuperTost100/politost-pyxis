import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import type { Page } from "@playwright/test";
import { PNG } from "pngjs";
import { OCR_DATA_FILES, ocrDataDir } from "../../src/core/sources/ocr-data";

/** Page size in pixels. The PDF page is 612 x 792 pt, so the image maps 1:1.5 and the renderer's 1.5 scale is exact. */
const WIDTH = 918;
const HEIGHT = 1188;

/**
 * Words the pinned English model reads reliably at this size. One distinct word set per page, so a page that was stored
 * twice or not at all shows in the text.
 */
export const SCAN_PAGES = [
  ["FORCE EQUALS MASS TIMES ACCELERATION", "MOTION"],
  ["ENERGY IS CONSERVED IN CLOSED SYSTEMS", "PENDULUM"],
] as const;

/**
 * The pinned files the runtime task downloaded once, when they are on this machine and match their pins. Nothing is
 * fetched here: a machine without them skips the real-OCR tests instead of reaching the network.
 */
export function stagedTessdata(): string | null {
  const dir =
    process.env.PYXIS_TESSDATA_DIR ??
    join(process.cwd(), ".tmp", "tessdata-fast");
  const ok = Object.entries(OCR_DATA_FILES).every(([lang, pinned]) => {
    const file = join(dir, `${lang}.traineddata`);
    if (!existsSync(file)) return false;
    const bytes = readFileSync(file);
    return (
      bytes.length === pinned.size &&
      createHash("sha256").update(bytes).digest("hex") === pinned.sha256
    );
  });
  return ok ? dir : null;
}

export function installTessdata(userData: string, staged: string): void {
  const dir = ocrDataDir(join(userData, "workspace", "runtimes", "tesseract"));
  mkdirSync(dir, { recursive: true });
  for (const lang of Object.keys(OCR_DATA_FILES))
    copyFileSync(
      join(staged, `${lang}.traineddata`),
      join(dir, `${lang}.traineddata`),
    );
}

/** Draws each page's text on a white canvas in the app's own renderer and returns the PNG bytes. */
export async function drawScanPages(page: Page): Promise<Buffer[]> {
  const urls = await page.evaluate(
    ({ pages, width, height }) =>
      pages.map((lines) => {
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d")!;
        context.fillStyle = "#fff";
        context.fillRect(0, 0, width, height);
        context.fillStyle = "#000";
        context.font = "bold 44px Arial, Helvetica, sans-serif";
        lines.forEach((line, index) =>
          context.fillText(line, 40, 160 + index * 120, width - 80),
        );
        return canvas.toDataURL("image/png");
      }),
    {
      pages: SCAN_PAGES.map((lines) => [...lines]),
      width: WIDTH,
      height: HEIGHT,
    },
  );
  return urls.map((url) => Buffer.from(url.split(",")[1]!, "base64"));
}

/**
 * A PDF whose pages are each one gray image and nothing else: no text operators, no fonts. Built here from the PNG pages
 * with node:zlib, so the fixture is generated, disposable and adds no dependency.
 */
export function imageOnlyPdf(pngs: Buffer[]): Buffer {
  const objects: Buffer[] = [];
  const add = (body: string | Buffer): number => {
    objects.push(Buffer.isBuffer(body) ? body : Buffer.from(body, "latin1"));
    return objects.length;
  };
  const pagesId = 2;
  add("<< /Type /Catalog /Pages 2 0 R >>");
  add(""); // the page tree is written once every page object number is known
  const kids: number[] = [];
  for (const png of pngs) {
    const { data, width, height } = PNG.sync.read(png);
    const gray = Buffer.alloc(width * height);
    for (let index = 0; index < gray.length; index += 1)
      gray[index] = data[index * 4]!;
    const packed = deflateSync(gray);
    const image = add(
      Buffer.concat([
        Buffer.from(
          `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${packed.length} >>\nstream\n`,
          "latin1",
        ),
        packed,
        Buffer.from("\nendstream", "latin1"),
      ]),
    );
    const draw = "q 612 0 0 792 0 0 cm /Im0 Do Q";
    const content = add(
      `<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`,
    );
    kids.push(
      add(
        `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 ${image} 0 R >> >> /Contents ${content} 0 R >>`,
      ),
    );
  }
  objects[pagesId - 1] = Buffer.from(
    `<< /Type /Pages /Kids [${kids.map((id) => `${id} 0 R`).join(" ")}] /Count ${kids.length} >>`,
    "latin1",
  );
  const chunks: Buffer[] = [Buffer.from("%PDF-1.4\n", "latin1")];
  const offsets: number[] = [];
  let size = chunks[0]!.length;
  objects.forEach((body, index) => {
    offsets.push(size);
    const piece = Buffer.concat([
      Buffer.from(`${index + 1} 0 obj\n`, "latin1"),
      body,
      Buffer.from("\nendobj\n", "latin1"),
    ]);
    chunks.push(piece);
    size += piece.length;
  });
  const xref = [
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`,
    ...offsets.map(
      (offset) => `${String(offset).padStart(10, "0")} 00000 n \n`,
    ),
  ].join("");
  chunks.push(
    Buffer.from(
      `${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${size}\n%%EOF\n`,
      "latin1",
    ),
  );
  return Buffer.concat(chunks);
}

export function writeScanPdf(path: string, pngs: Buffer[]): void {
  writeFileSync(path, imageOnlyPdf(pngs));
}
