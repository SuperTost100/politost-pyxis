import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { drawingFor, ICNS_TYPES, ICO_SIZES, LINUX_SIZES, packIco, packIcns } from "./gen-file-icon.mjs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url));
const pngSize = (png) => [png.readUInt32BE(16), png.readUInt32BE(20)];

test("each size takes the drawing that holds up at it", () => {
  assert.equal(drawingFor(16), "pyxis-file-icon-16.svg");
  assert.equal(drawingFor(17), "pyxis-file-icon-32.svg");
  assert.equal(drawingFor(32), "pyxis-file-icon-32.svg");
  assert.equal(drawingFor(33), "pyxis-file-icon.svg");
});

test("the icns packer writes each entry's type and length", () => {
  const png = Buffer.from("png");
  const out = packIcns([{ type: "ic07", png }, { type: "icp4", png }]);
  assert.equal(out.toString("ascii", 0, 4), "icns");
  assert.equal(out.readUInt32BE(4), out.length);
  assert.equal(out.toString("ascii", 8, 12), "ic07");
  assert.equal(out.readUInt32BE(12), png.length + 8);
  assert.equal(out.toString("ascii", 8 + 8 + 3, 8 + 8 + 3 + 4), "icp4");
});

test("the ico packer points each directory entry at its image", () => {
  const first = Buffer.from("aaaa");
  const second = Buffer.from("bb");
  const out = packIco([{ size: 16, png: first }, { size: 256, png: second }]);
  assert.equal(out.readUInt16LE(2), 1);
  assert.equal(out.readUInt16LE(4), 2);
  assert.equal(out.readUInt8(6), 16);
  assert.equal(out.readUInt8(6 + 16), 0);
  assert.equal(out.readUInt32LE(6 + 8), first.length);
  assert.equal(out.readUInt32LE(6 + 12), 6 + 32);
  assert.equal(out.subarray(out.readUInt32LE(6 + 16 + 12)).toString(), "bb");
});

test("the committed files hold the sizes the packagers read", () => {
  const ico = read("build/pyxis.ico");
  assert.equal(ico.readUInt16LE(4), ICO_SIZES.length);
  ICO_SIZES.forEach((size, i) => {
    const at = 6 + 16 * i;
    const png = ico.subarray(ico.readUInt32LE(at + 12), ico.readUInt32LE(at + 12) + ico.readUInt32LE(at + 8));
    assert.deepEqual(pngSize(png), [size, size]);
  });
  const icns = read("build/pyxis.icns");
  assert.equal(icns.readUInt32BE(4), icns.length);
  let at = 8;
  for (const [type, size] of ICNS_TYPES) {
    assert.equal(icns.toString("ascii", at, at + 4), type);
    const length = icns.readUInt32BE(at + 4);
    assert.deepEqual(pngSize(icns.subarray(at + 8, at + length)), [size, size]);
    at += length;
  }
  assert.equal(at, icns.length);
  for (const size of LINUX_SIZES) assert.deepEqual(pngSize(read(`build/file-icon/${size}.png`)), [size, size]);
});

test("the deb installs every Linux size and the MIME file that names the icon", () => {
  const config = readFileSync(new URL("../electron-builder.yml", import.meta.url), "utf8");
  for (const size of LINUX_SIZES)
    assert.ok(
      config.includes(
        `build/file-icon/${size}.png=/usr/share/icons/hicolor/${size}x${size}/mimetypes/application-vnd.politost.pyxis+json.png`,
      ),
      `${size} px`,
    );
  assert.ok(config.includes("build/pyxis-mime-icon.xml=/usr/share/mime/packages/z-"));
  assert.match(config, /ext: pyxis[\s\S]*?icon: pyxis\b/);
});
