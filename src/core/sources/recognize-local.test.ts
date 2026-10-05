import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const calls: Array<{
  langs: unknown;
  options: Record<string, unknown>;
  files: Record<string, string>;
}> = [];
let failRecognize = false;

vi.mock("tesseract.js", () => ({
  createWorker: async (
    langs: unknown,
    _oem: number,
    options: { langPath: string },
  ) => {
    // What tesseract.js would read: the folder it is pointed at, at the moment it starts.
    const files = Object.fromEntries(
      readdirSync(options.langPath).map((name) => [
        name,
        readFileSync(`${options.langPath}/${name}`, "utf8"),
      ]),
    );
    calls.push({ langs, options, files });
    return {
      setParameters: async () => undefined,
      recognize: async () => {
        if (failRecognize) throw new Error("recognizer failed");
        return { data: { text: " fake \n text " } };
      },
      terminate: async () => undefined,
    };
  },
}));
vi.mock("./ocr-data", async (original) => ({
  ...(await original<typeof import("./ocr-data")>()),
  readVerifiedOcrData: async (_tess: string, langs: string[]) =>
    langs.map((code) => ({ code, data: Buffer.from(`verified ${code}`) })),
}));

const { recognizeImage } = await import("./recognize");
// The run keeps its folder under the workspace (here a temp one), not in the OS temp folder.
const tess = mkdtempSync(join(tmpdir(), "pyxis-recognize-local-"));
afterAll(() => rmSync(tess, { recursive: true, force: true }));
const png = () => {
  const image = new PNG({ width: 8, height: 8 });
  image.data.fill(255);
  return new Uint8Array(PNG.sync.write(image));
};

describe("OCR hands tesseract.js only local, verified data", () => {
  beforeEach(() => {
    calls.length = 0;
    failRecognize = false;
  });

  it("points it at a private local folder of exactly the verified bytes, with no cache and no gzip fetch", async () => {
    expect(await recognizeImage(png(), tess, undefined, "eng+ita")).toBe(
      "fake text",
    );
    const [call] = calls;
    expect(call?.langs).toBe("eng+ita");
    expect(call?.options).toMatchObject({ cacheMethod: "none", gzip: false });
    // A path, never a URL, so tesseract.js has nothing to fetch and no CDN default to fall back on.
    expect(String(call?.options.langPath)).toMatch(/^[/\\]/);
    expect(call?.options.langPath).not.toMatch(/^https?:/);
    expect(String(call?.options.langPath).startsWith(join(tess, "scratch"))).toBe(true);
    expect(call?.files).toEqual({
      "eng.traineddata": "verified eng",
      "ita.traineddata": "verified ita",
    });
  });

  it("removes the folder afterwards, also when recognition fails", async () => {
    await recognizeImage(png(), tess, undefined, "eng");
    expect(existsSync(String(calls[0]?.options.langPath))).toBe(false);
    failRecognize = true;
    await expect(
      recognizeImage(png(), tess, undefined, "eng"),
    ).rejects.toThrow("recognizer failed");
    expect(existsSync(String(calls[1]?.options.langPath))).toBe(false);
  });
});
