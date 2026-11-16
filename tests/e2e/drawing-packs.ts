import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The pinned packs a workspace has once the student has downloaded them, copied into its folder. */
export function stagePacks(userData: string, packs: Array<"pyodide" | "drawing">): void {
  for (const pack of packs) {
    const { version } = JSON.parse(readFileSync(`resources/${pack}-manifest.json`, "utf8")) as { version: string };
    const folder = join(userData, "workspace/runtimes", pack, version);
    mkdirSync(folder, { recursive: true });
    cpSync(`.tmp/${pack}`, folder, { recursive: true });
  }
}

/** The staged folder of the drawing pack, for a test that damages one of its files. */
export function stagedDrawingPack(userData: string): string {
  const { version } = JSON.parse(readFileSync("resources/drawing-manifest.json", "utf8")) as { version: string };
  return join(userData, "workspace/runtimes/drawing", version);
}

export const drawingPinned = () => existsSync(".tmp/drawing/graphviz.js");
export const pythonPinned = () => existsSync(".tmp/pyodide/pyodide.js");

/** A PNG data URL's width and height from its header, or null when it is not a PNG. */
export function pngSize(dataUrl: string): { width: number; height: number } | null {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match) return null;
  const bytes = Buffer.from(match[1]!, "base64");
  if (bytes.length < 24 || bytes.toString("latin1", 1, 4) !== "PNG") return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}
