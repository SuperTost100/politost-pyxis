import { crc32, deflateSync, inflateSync } from "node:zlib";
import { FIGURE_IMAGE_MAX } from "../../shared/smart-text";

/**
 * A figure for the dark theme, made from the picture drawn for the light one. Every kind (a plot, a circuit, a graph) is
 * drawn once, on white, and this turns its pixels: the white ground becomes the dark ground the viewer and the figure's
 * card use, black ink becomes light ink, a light fill becomes a dark one, and a colour in the middle keeps its hue and is
 * lifted a little so it reads on the dark. Nothing about the drawing's code or its library matters, so a second render
 * is not needed.
 */

/** The ground of a figure drawn for the dark theme: `--surface` of the dark theme, which the card around it also has. */
export const DARK_GROUND: readonly [number, number, number] = [23, 27, 34];
/** The ink on it: `--ink` of the dark theme. */
const DARK_INK: readonly [number, number, number] = [232, 234, 239];
/** The lightest and darkest lightness a colour gets. */
const LIGHTEST = 0.92;
const DARKEST = 0.09;
/** How much a colour in the middle is lifted, at most. */
const LIFT = 0.14;

function hsl(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = d / (1 - Math.abs(2 * l - 1));
  const rr = r / 255;
  const gg = g / 255;
  let h: number;
  if (max === rr) h = ((gg - b / 255) / d) % 6;
  else if (max === gg) h = (b / 255 - rr) / d + 2;
  else h = (rr - gg) / d + 4;
  return [(h * 60 + 360) % 360, s, l];
}

function fromHsl(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

const linear = (value: number) => {
  const v = value / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const luminance = (r: number, g: number, b: number) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
const GROUND_LUMINANCE = luminance(...DARK_GROUND);
/** The contrast ratio of a colour on the dark ground. */
export function contrastOnDark(r: number, g: number, b: number): number {
  return (luminance(r, g, b) + 0.05) / (GROUND_LUMINANCE + 0.05);
}

/**
 * The contrast a colour must keep on the dark ground, by its lightness on the white one. Ink, text and the dark colours
 * (up to 0.5) reach 4.7:1, which is text's 4.5:1 with room, strokes in the middle (0.7) reach 3.5:1, the 3:1 a line needs,
 * and the floor falls away to nothing for light tints (0.85 and up), which are fills and gridlines and stay quiet.
 */
function floorFor(lightness: number): number {
  if (lightness <= 0.5) return 4.7;
  if (lightness <= 0.7) return 4.7 - ((lightness - 0.5) / 0.2) * 1.2;
  if (lightness <= 0.85) return 3.5 - ((lightness - 0.7) / 0.15) * 2.5;
  return 1;
}

/** One pixel for the dark theme. Greys run from the dark ground (white) to the light ink (black), colours keep their hue. */
export function darkPixel(r: number, g: number, b: number): [number, number, number] {
  const [h, s, l] = hsl(r, g, b);
  const grey = DARK_GROUND.map((ground, i) => ground * l + DARK_INK[i]! * (1 - l));
  const inverted = DARKEST + (1 - l) * (LIGHTEST - DARKEST);
  const lifted = Math.min(LIGHTEST, inverted + LIFT * (1 - Math.abs(2 * inverted - 1)));
  const weight = s < 0.02 ? 0 : Math.min(1, s * 2);
  let colour = (s < 0.02 ? grey : fromHsl(h, s, lifted).map((value, i) => value * weight + grey[i]! * (1 - weight))).map((value) =>
    Math.max(0, Math.min(255, Math.round(value))),
  ) as [number, number, number];
  // A colour that is text or a stroke on white must still read on the dark: its lightness is raised until it does.
  const floor = floorFor(l);
  if (floor > 1 && contrastOnDark(...colour) < floor) {
    const [ch, cs, cl] = hsl(...colour);
    for (let step = cl + 0.01; step <= 0.97; step += 0.01) {
      colour = fromHsl(ch, cs, step).map((value) => Math.max(0, Math.min(255, Math.round(value)))) as [number, number, number];
      if (contrastOnDark(...colour) >= floor) break;
    }
  }
  return colour;
}

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
/** The most pixels a picture may have to be turned: the sandbox draws far less. */
const PIXELS_MAX = 8_000_000;

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, tail]);
}

/** The pixels of a PNG with 8 bits a channel in RGB or RGBA, not interlaced; null for any other. */
function decode(png: Buffer): { width: number; height: number; channels: 3 | 4; pixels: Buffer } | null {
  if (png.length < 33 || !png.subarray(0, 8).equals(SIGNATURE)) return null;
  let width = 0;
  let height = 0;
  let channels: 3 | 4 | 0 = 0;
  const data: Buffer[] = [];
  for (let at = 8; at + 12 <= png.length; ) {
    const length = png.readUInt32BE(at);
    const type = png.toString("latin1", at + 4, at + 8);
    const body = png.subarray(at + 8, at + 8 + length);
    if (body.length !== length) return null;
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const [depth, colour, , , interlace] = [body[8], body[9], body[10], body[11], body[12]];
      if (depth !== 8 || interlace !== 0) return null;
      channels = colour === 6 ? 4 : colour === 2 ? 3 : 0;
    } else if (type === "IDAT") data.push(body);
    else if (type === "IEND") break;
    at += 12 + length;
  }
  if (!channels || !width || !height || width * height > PIXELS_MAX || data.length === 0) return null;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(data), { maxOutputLength: (stride + 1) * height });
  if (raw.length !== (stride + 1) * height) return null;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const line = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? pixels[y * stride + x - channels]! : 0;
      const b = y > 0 ? pixels[(y - 1) * stride + x]! : 0;
      const c = x >= channels && y > 0 ? pixels[(y - 1) * stride + x - channels]! : 0;
      let predictor: number;
      if (filter === 0) predictor = 0;
      else if (filter === 1) predictor = a;
      else if (filter === 2) predictor = b;
      else if (filter === 3) predictor = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else return null;
      pixels[y * stride + x] = (raw[line + x]! + predictor) & 255;
    }
  }
  return { width, height, channels, pixels };
}

function encode(width: number, height: number, channels: 3 | 4, pixels: Buffer): Buffer {
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    // Filter 1 (Sub): flat areas and gradients deflate far better than unfiltered lines.
    raw[y * (stride + 1)] = 1;
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? pixels[y * stride + x - channels]! : 0;
      raw[y * (stride + 1) + 1 + x] = (pixels[y * stride + x]! - left) & 255;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, channels === 4 ? 6 : 2, 0, 0, 0], 8);
  return Buffer.concat([SIGNATURE, chunk("IHDR", header), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

const PREFIX = "data:image/png;base64,";

/**
 * The picture as the dark theme shows it, or null when it cannot be made: not a PNG data URL, a PNG of another kind than
 * 8-bit RGB or RGBA, or a result past `max`, what a figure's image may be.
 */
export function darkFigure(image: string, max = FIGURE_IMAGE_MAX): string | null {
  if (!image.startsWith(PREFIX)) return null;
  try {
    const source = decode(Buffer.from(image.slice(PREFIX.length), "base64"));
    if (!source) return null;
    const { width, height, channels, pixels } = source;
    // A picture has few colours, so each is turned once.
    const seen = new Map<number, number>();
    for (let i = 0; i < pixels.length; i += channels) {
      const key = (pixels[i]! << 16) | (pixels[i + 1]! << 8) | pixels[i + 2]!;
      let turned = seen.get(key);
      if (turned === undefined) {
        const [r, g, b] = darkPixel(pixels[i]!, pixels[i + 1]!, pixels[i + 2]!);
        turned = (r << 16) | (g << 8) | b;
        seen.set(key, turned);
      }
      pixels[i] = turned >> 16;
      pixels[i + 1] = (turned >> 8) & 255;
      pixels[i + 2] = turned & 255;
    }
    const result = `${PREFIX}${encode(width, height, channels, pixels).toString("base64")}`;
    return result.length <= max ? result : null;
  } catch {
    return null;
  }
}
