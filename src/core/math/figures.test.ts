import { expect, it } from "vitest";
import { FIGURE_KINDS, figureKinds } from "../../shared/figure-kinds";
import { FIGURE_MAX, figureKey } from "../../shared/smart-text";
import {
  drawFigures,
  figureCaptions,
  figureRunner,
  type FigureRunner,
} from "./figures";

const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const block = (code: string, caption = "Figura", kind?: string) =>
  ["```pyxis-figure", JSON.stringify({ kind, caption, code }), "```"].join("\n");
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
  expect(
    calls.every((call) => call.timeout === FIGURE_KINDS.plot.timeoutMs),
  ).toBe(true);
  expect(Object.keys(drawn.figures)).toEqual(
    codes.slice(0, FIGURE_MAX).map((code) => figureKey(code)),
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

it("draws a circuit on the drawing d and leaves out a kind the sandbox cannot draw", async () => {
  const programs: string[] = [];
  const python: FigureRunner = async (code, timeout) => {
    programs.push(code);
    return drawsAll(code, timeout);
  };
  const rc = "d += elm.Resistor().right().label('R')\nd += elm.Capacitor().down().label('C')";
  const text = [block(rc, "Un circuito RC.", "circuit"), block("plt.plot([1])"), "Fine."].join("\n\n");
  const drawn = await drawFigures(text, { python });
  expect(Object.keys(drawn.figures)).toEqual([
    figureKey(rc, "circuit"),
    figureKey("plt.plot([1])"),
  ]);
  // The circuit's elements go on a drawing that exists before the code and is drawn after it.
  const [circuit, plot] = programs.map((program) => program.split("\n"));
  expect(circuit!.indexOf("d = schemdraw.Drawing(show=False)")).toBeLessThan(
    circuit!.indexOf("d += elm.Resistor().right().label('R')"),
  );
  expect(circuit!.slice(-3)).toEqual([
    "if d.elements:",
    "    d.draw(show=False).getfig()",
    "plt.show()",
  ]);
  expect(plot!.join("\n")).not.toContain("schemdraw");

  // With Python but without the drawing pack only plots draw: the circuit's block goes and nothing runs for it.
  programs.length = 0;
  const plots = await drawFigures(text, { python, kinds: ["plot"] });
  expect(programs).toHaveLength(1);
  expect(Object.keys(plots.figures)).toEqual([figureKey("plt.plot([1])")]);
  expect(plots.markdown).not.toContain("Un circuito RC.");
  // A circuit drawn before keeps its image even then.
  const kept = await drawFigures(text, {
    python,
    kinds: ["plot"],
    known: { [figureKey(rc, "circuit")]: PNG },
  });
  expect(kept.markdown).toContain("Un circuito RC.");
  expect(Object.keys(kept.figures)).toHaveLength(2);
});

it("offers figures only with a sandbox: the caller's runner, or none when the runtime cannot be reached", async () => {
  expect(await figureRunner(drawsAll)).toEqual({
    run: drawsAll,
    kinds: figureKinds,
  });
  expect(await figureRunner(null)).toBeNull();
  // In a test there is no main process to ask, so the runtime counts as missing.
  expect(await figureRunner()).toBeNull();
});

it("draws a graph from its own text and not from a Python program, and keeps the graph under its own key", async () => {
  const calls: Array<{ code: string; timeout: number; figure: unknown }> = [];
  const python: FigureRunner = async (code, timeout, figure) => {
    calls.push({ code, timeout, figure });
    return drawsAll(code, timeout);
  };
  const dot = "digraph { q0 -> q1 [label=a]; q1 -> q0 [label=b] }";
  const text = ["Prima.", block(dot, "Un automa.", "graph"), block("plt.plot([1])"), "Dopo."].join("\n\n");
  const drawn = await drawFigures(text, { python });
  // The window gets the DOT as it was written, with the limit of its kind and what is being drawn; the plot gets a program.
  expect(calls[0]).toEqual({ code: dot, timeout: 5000, figure: { kind: "graph", code: dot } });
  expect(calls[1]!.code).toContain("import matplotlib");
  expect(calls[1]!.figure).toEqual({ kind: "plot", code: "plt.plot([1])" });
  expect(Object.keys(drawn.figures)).toEqual([figureKey(dot, "graph"), figureKey("plt.plot([1])")]);
  expect(figureKey(dot, "graph")).not.toBe(figureKey(dot));
  expect(drawn.markdown).toBe(text);
});

it("drops a graph its check refuses without asking any window, and a graph in a workspace that cannot draw graphs", async () => {
  const calls: string[] = [];
  const python: FigureRunner = async (code, timeout) => {
    calls.push(code);
    return drawsAll(code, timeout);
  };
  const refused = ['digraph { a [image="/etc/passwd"] }', 'digraph { a [URL="https://example.com"] }', "digraph { a [label=<<b>x</b>>] }"];
  const drawn = await drawFigures(["Testo.", ...refused.map((dot, i) => block(dot, `Grafo ${i}`, "graph"))].join("\n\n"), { python });
  expect(calls).toEqual([]);
  expect({ ...drawn, markdown: drawn.markdown.trim() }).toEqual({ markdown: "Testo.", figures: {} });
  // The drawing pack is missing: Python draws plots, and a graph is left out.
  const plots = await drawFigures([block("digraph { a -> b }", "Un grafo.", "graph"), block("plt.plot([1])")].join("\n\n"), { python, kinds: ["plot"] });
  expect(calls).toHaveLength(1);
  expect(Object.keys(plots.figures)).toEqual([figureKey("plt.plot([1])")]);
});
