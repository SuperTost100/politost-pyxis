import { crc32, deflateSync } from "node:zlib";

/** Pictures made here, so a spec needs no image fixture: a plot-like figure on white or on the dark ground, and a photo. */

function png(width: number, height: number, pixel: (x: number, y: number) => [number, number, number]): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x++) raw.set(pixel(x, y), row + 1 + x * 3);
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
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A velocity-time plot: a grid, a rising line and the area under it. `dark` draws it on the dark ground with light lines. */
export function plotPng(dark: boolean): Buffer {
  const ground: [number, number, number] = dark ? [23, 27, 34] : [255, 255, 255];
  const grid: [number, number, number] = dark ? [43, 49, 60] : [228, 230, 234];
  const ink: [number, number, number] = dark ? [232, 234, 239] : [27, 30, 36];
  const line: [number, number, number] = dark ? [138, 168, 240] : [47, 95, 208];
  const area: [number, number, number] = dark ? [47, 55, 80] : [225, 230, 247];
  return png(640, 400, (x, y) => {
    const left = 60;
    const bottom = 360;
    const top = 40;
    const right = 600;
    if (x === left || y === bottom) return ink;
    if (x > left && x < right && y > top && y < bottom) {
      const lineY = bottom - (x - left) * 0.5 - 40;
      if (Math.abs(y - lineY) < 2) return line;
      if (x > 150 && x < 450 && y > lineY && y < bottom) return area;
      if ((x - left) % 90 === 0 || (bottom - y) % 80 === 0) return grid;
    }
    return ground;
  });
}

/** A photo of a page of notes with a sloped plane drawn on it, as tall as a phone's portrait shot of a page. */
export function photoPng(): Buffer {
  return png(312, 400, (x, y) => {
    if (y > 150 && y < 154 && x > 60 && x < 220) return [40, 56, 110];
    if (Math.abs(y - (210 - (x - 60) * 0.6)) < 2 && x > 60 && x < 220) return [40, 56, 110];
    return y % 28 === 0 ? [196, 205, 222] : [233, 228, 216];
  });
}

export const dataUrl = (bytes: Buffer) => `data:image/png;base64,${bytes.toString("base64")}`;
