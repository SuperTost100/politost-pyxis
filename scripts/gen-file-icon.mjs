import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Makes the icon of a .pyxis file in every format the installers take, from the three drawings in
// src/renderer/src/design-system/logo: pyxis-file-icon.svg for 64 px and more, -32 for 17 to 32 px and -16 for 16 px
// and less, where the full drawing turns to mush. It writes
//   build/pyxis.icns         macOS, the document type's icon (electron-builder picks it up for the "pyxis" extension)
//   build/pyxis.ico          Windows, the same for the association the installer registers
//   build/file-icon/<n>.png  Linux, installed into the hicolor theme by the deb (electron-builder.yml, deb.fpm)
// Run it with `node scripts/gen-file-icon.mjs` after changing a drawing and commit the results. It needs the
// Chromium that Playwright installs; the packaging itself does not run it.

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const drawings = join(root, "src/renderer/src/design-system/logo");

/** The drawing that holds up at a size in pixels. */
export function drawingFor(px) {
  return px <= 16 ? "pyxis-file-icon-16.svg" : px <= 32 ? "pyxis-file-icon-32.svg" : "pyxis-file-icon.svg";
}

/** The sizes of the .icns, with the type each one is stored under (PNG data in every entry). */
export const ICNS_TYPES = [
  ["icp4", 16],
  ["icp5", 32],
  ["icp6", 64],
  ["ic07", 128],
  ["ic08", 256],
  ["ic09", 512],
  ["ic10", 1024],
  ["ic11", 32],
  ["ic12", 64],
  ["ic13", 256],
  ["ic14", 512],
];
export const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
export const LINUX_SIZES = [16, 32, 64, 128, 256, 512];

/** An Apple icon: the "icns" header, then each entry as its type, its length with the header and its PNG. */
export function packIcns(entries) {
  const body = Buffer.concat(
    entries.map(({ type, png }) => {
      const head = Buffer.alloc(8);
      head.write(type, 0, "ascii");
      head.writeUInt32BE(png.length + 8, 4);
      return Buffer.concat([head, png]);
    }),
  );
  const head = Buffer.alloc(8);
  head.write("icns", 0, "ascii");
  head.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([head, body]);
}

/** A Windows icon with a PNG in each entry (read since Windows Vista); 256 is written as 0 in the directory. */
export function packIco(entries) {
  const head = Buffer.alloc(6 + 16 * entries.length);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(entries.length, 4);
  let offset = head.length;
  entries.forEach(({ size, png }, i) => {
    const at = 6 + 16 * i;
    head.writeUInt8(size >= 256 ? 0 : size, at);
    head.writeUInt8(size >= 256 ? 0 : size, at + 1);
    head.writeUInt16LE(1, at + 4);
    head.writeUInt16LE(32, at + 6);
    head.writeUInt32LE(png.length, at + 8);
    head.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([head, ...entries.map((entry) => entry.png)]);
}

async function renderAll(sizes) {
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const out = new Map();
    for (const px of sizes) {
      const svg = await readFile(join(drawings, drawingFor(px)), "utf8");
      await page.setViewportSize({ width: px, height: px });
      await page.setContent(
        `<style>html,body{margin:0;background:transparent}img{display:block;width:${px}px;height:${px}px}</style>` +
          `<img alt="" src="data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}">`,
      );
      await page.evaluate(() => document.images[0].decode());
      out.set(px, await page.screenshot({ omitBackground: true, type: "png" }));
    }
    return out;
  } finally {
    await browser.close();
  }
}

async function main() {
  const sizes = [...new Set([...ICNS_TYPES.map(([, px]) => px), ...ICO_SIZES, ...LINUX_SIZES])];
  const png = await renderAll(sizes);
  const build = join(root, "build");
  await mkdir(join(build, "file-icon"), { recursive: true });
  await writeFile(join(build, "pyxis.icns"), packIcns(ICNS_TYPES.map(([type, px]) => ({ type, png: png.get(px) }))));
  await writeFile(join(build, "pyxis.ico"), packIco(ICO_SIZES.map((size) => ({ size, png: png.get(size) }))));
  for (const px of LINUX_SIZES) await writeFile(join(build, "file-icon", `${px}.png`), png.get(px));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
