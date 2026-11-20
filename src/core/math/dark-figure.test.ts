import { crc32, deflateSync, inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { FIGURE_IMAGE_MAX } from "../../shared/smart-text";
import { darkFigure, darkPixel, DARK_GROUND } from "./dark-figure";

/** A PNG of 8-bit RGB or RGBA with the filter given for every line. */
function png(width: number, height: number, channels: 3 | 4, pixel: (x: number, y: number) => number[], options: { filter?: number; colour?: number; interlace?: number } = {}) {
  const stride = width * channels;
  const flat = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) flat.set(pixel(x, y).slice(0, channels), y * stride + x * channels);
  const filter = options.filter ?? 0;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = filter;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? flat[y * stride + x - channels]! : 0;
      const b = y > 0 ? flat[(y - 1) * stride + x]! : 0;
      const c = x >= channels && y > 0 ? flat[(y - 1) * stride + x - channels]! : 0;
      const p = a + b - c;
      const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
      const predictor = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][filter]!;
      raw[y * (stride + 1) + 1 + x] = (flat[y * stride + x]! - predictor) & 255;
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc32(body));
    return Buffer.concat([head, body, tail]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, options.colour ?? (channels === 4 ? 6 : 2), 0, 0, options.interlace ?? 0], 8);
  return `data:image/png;base64,${Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]).toString("base64")}`;
}

/** The pixels of a PNG this module wrote: inflated, with the Sub filter undone. */
function read(url: string, channels: 3 | 4) {
  const bytes = Buffer.from(url.slice("data:image/png;base64,".length), "base64");
  const idat = bytes.subarray(bytes.indexOf("IDAT") + 4, bytes.lastIndexOf("IEND") - 8);
  const width = bytes.readUInt32BE(16);
  const raw = inflateSync(idat);
  const stride = width * channels;
  const out: number[][] = [];
  for (let y = 0; y < raw.length / (stride + 1); y++) {
    const line: number[] = [];
    for (let x = 0; x < stride; x++) line.push((raw[y * (stride + 1) + 1 + x]! + (x >= channels ? line[x - channels]! : 0)) & 255);
    out.push(line);
  }
  return out;
}

const luminance = ([r, g, b]: number[]) => (0.2126 * r! + 0.7152 * g! + 0.0722 * b!) / 255;

describe("darkPixel", () => {
  it("turns white into the dark ground and black into the light ink", () => {
    expect(darkPixel(255, 255, 255)).toEqual([...DARK_GROUND]);
    expect(darkPixel(0, 0, 0)).toEqual([232, 234, 239]);
  });

  it("makes a light fill dark and a dark ink light, with their hue kept", () => {
    const fill = darkPixel(225, 230, 247);
    expect(luminance(fill)).toBeLessThan(0.25);
    expect(fill[2]).toBeGreaterThan(fill[0]);
    const ink = darkPixel(40, 56, 110);
    expect(luminance(ink)).toBeGreaterThan(0.6);
    expect(ink[2]).toBeGreaterThan(ink[0]);
  });

  it("lifts a colour in the middle so it reads on the dark ground, and keeps its hue", () => {
    const blue = darkPixel(47, 95, 208);
    expect(luminance(blue)).toBeGreaterThan(luminance([47, 95, 208]));
    expect(blue[2]).toBeGreaterThan(blue[1]);
    expect(blue[1]).toBeGreaterThan(blue[0]);
    // 4.5:1 is for text; a line needs 3:1 against the ground.
    const ground = luminance([...DARK_GROUND]);
    expect((luminance(blue) + 0.05) / (ground + 0.05)).toBeGreaterThan(3);
  });
});

describe("darkFigure", () => {
  const plot = (x: number, y: number) => (y > 30 && y < 33 ? [47, 95, 208, 255] : x < 8 ? [225, 230, 247, 255] : [255, 255, 255, 255]);

  it("turns every pixel of an RGBA picture and keeps its size and its alpha", () => {
    const dark = darkFigure(png(40, 40, 4, (x, y) => (x === 5 && y === 5 ? [10, 10, 10, 128] : plot(x, y))));
    const lines = read(dark!, 4);
    expect(lines).toHaveLength(40);
    expect(lines[0]!.slice(4 * 20, 4 * 21)).toEqual([...DARK_GROUND, 255]);
    expect(lines[5]!.slice(4 * 5, 4 * 6)[3]).toBe(128);
    expect(luminance(lines[31]!.slice(4 * 20, 4 * 21))).toBeGreaterThan(0.25);
  });

  it("reads every filter a PNG writer may use", () => {
    for (const filter of [0, 1, 2, 3, 4]) {
      const dark = darkFigure(png(24, 24, 4, plot, { filter }));
      expect(read(dark!, 4)[0]!.slice(0, 4), `filter ${filter}`).toEqual([...darkPixel(225, 230, 247), 255]);
    }
  });

  it("turns an RGB picture too", () => {
    const dark = darkFigure(png(10, 10, 3, () => [255, 255, 255]));
    expect(read(dark!, 3)[0]!.slice(0, 3)).toEqual([...DARK_GROUND]);
  });

  it("is null for what it cannot turn: not a PNG, a palette or interlaced picture, a damaged one", () => {
    expect(darkFigure("")).toBeNull();
    expect(darkFigure("data:image/jpeg;base64,AAAA")).toBeNull();
    expect(darkFigure("data:image/png;base64,AAAA")).toBeNull();
    expect(darkFigure(png(4, 4, 3, () => [1, 2, 3], { colour: 3 }))).toBeNull();
    expect(darkFigure(png(4, 4, 3, () => [1, 2, 3], { interlace: 1 }))).toBeNull();
    expect(darkFigure(png(8, 8, 4, plot).slice(0, 80))).toBeNull();
  });

  it("is null when the result would not fit a stored figure", () => {
    const picture = png(40, 40, 4, plot);
    expect(darkFigure(picture)).not.toBeNull();
    expect(darkFigure(picture, 50)).toBeNull();
    expect(darkFigure(picture)!.length).toBeLessThanOrEqual(FIGURE_IMAGE_MAX);
  });
});
