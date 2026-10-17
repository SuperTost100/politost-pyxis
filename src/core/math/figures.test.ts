import { expect, it } from "vitest";
import { FIGURE_MAX, figureKey } from "../../shared/smart-text";
import {
  FIGURE_TIMEOUT_MS,
  drawFigures,
  figureCaptions,
  figureRunner,
  type FigureRunner,
} from "./figures";

const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const block = (code: string, caption = "Figura") =>
  ["```pyxis-figure", JSON.stringify({ caption, code }), "```"].join("\n");
const drawsAll: FigureRunner = async () => ({
  stdout: "",
  stderr: "",
  images: [PNG],
  timedOut: false,
  truncated: false,
});

it("runs each figure once with the time limit, up to the cap, and keeps the text around it", async () => {
  const calls: Array<{ code: string; timeout: number }> = [];
  const python: FigureRunner = async (code, timeout) => {
    calls.push({ code, timeout });
    return drawsAll(code, timeout);
  };
  const codes = Array.from(
    { length: FIGURE_MAX + 2 },
    (_, i) => `plt.plot([${i}])`,
  );
  // The first figure twice, with another caption: one run, both blocks shown.
  const text = [
    block(codes[0]!),
    block(codes[0]!, "Di nuovo"),
    ...codes.slice(1).map((code) => block(code)),
    "Fine.",
  ].join("\n\n");
  const drawn = await drawFigures(text, { python });
  expect(calls).toHaveLength(FIGURE_MAX);
  expect(calls.every((call) => call.timeout === FIGURE_TIMEOUT_MS)).toBe(true);
  expect(Object.keys(drawn.figures)).toEqual(
    codes.slice(0, FIGURE_MAX).map(figureKey),
  );
  expect(drawn.markdown.match(/```pyxis-figure/g)).toHaveLength(FIGURE_MAX + 1);
  expect(drawn.markdown).not.toContain(codes.at(-1));
  expect(drawn.markdown.endsWith("Fine.")).toBe(true);
});

it("leaves out a figure whose run threw, printed no image, or gave something that is not a PNG", async () => {
  const outcomes: Record<
    string,
    () => Promise<Awaited<ReturnType<FigureRunner>>>
  > = {
    raise: async () => {
      throw new Error("runtime-crashed");
    },
    blank: async () => ({
      stdout: "",
      stderr: "",
      images: [],
      timedOut: false,
      truncated: false,
    }),
    svg: async () => ({
      stdout: "",
      stderr: "",
      images: ["data:image/svg+xml;base64,PHN2Zy8+"],
      timedOut: false,
      truncated: false,
    }),
    flood: async () => ({
      stdout: "",
      stderr: "",
      images: [PNG],
      timedOut: false,
      truncated: true,
    }),
  };
  const python: FigureRunner = (code) =>
    outcomes[Object.keys(outcomes).find((name) => code.includes(name))!]!();
  const drawn = await drawFigures(
    [
      "Testo.",
      ...Object.keys(outcomes).map((name) => block(`# ${name}`)),
      "Fine.",
    ].join("\n\n"),
    { python },
  );
  expect(drawn).toEqual({ markdown: "Testo.\n\nFine.", figures: {} });
});

it("reuses images already drawn, stops when aborted, and turns figures into captions", async () => {
  let runs = 0;
  const python: FigureRunner = async (code, timeout) => {
    runs++;
    return drawsAll(code, timeout);
  };
  const known = { [figureKey("plt.plot([1])")]: PNG, "figure-gone": PNG };
  const drawn = await drawFigures(block("plt.plot([1])"), { python, known });
  expect(runs).toBe(0);
  expect(drawn.figures).toEqual({ [figureKey("plt.plot([1])")]: PNG });

  const controller = new AbortController();
  controller.abort();
  await expect(
    drawFigures(block("plt.plot([2])"), { python, signal: controller.signal }),
  ).rejects.toThrow();
  expect(runs).toBe(0);

  expect(figureCaptions(`Prima.\n\n${block("x", "La retta")}`, "Figure")).toBe(
    "Prima.\n\n*Figure: La retta*",
  );
  expect(figureCaptions(block("x", "La retta"))).toBe("*La retta*");
});

it("offers figures only with a sandbox: the caller's runner, or none when the runtime cannot be reached", async () => {
  expect(await figureRunner(drawsAll)).toBe(drawsAll);
  expect(await figureRunner(null)).toBeNull();
  // In a test there is no main process to ask, so the runtime counts as missing.
  expect(await figureRunner()).toBeNull();
});
