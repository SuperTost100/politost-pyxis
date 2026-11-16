import { expect, it, vi } from "vitest";
import { FIGURE_KINDS, figureKinds } from "../../shared/figure-kinds";
import { FIGURE_MAX, figureKey } from "../../shared/smart-text";
import {
  FIGURE_ERROR_MAX,
  drawFigures,
  figureCaptions,
  figureFixer,
  figureRunner,
  type FigureFix,
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

/** The sandbox stand-in of the retry tests: code that raises fails like Python would, the rest draws. */
const raises: FigureRunner = async (code) =>
  code.includes("raise ")
    ? {
        stdout: "",
        stderr: `Traceback (most recent call last):\n  File "<exec>", line 9, in <module>\nValueError: ${/raise ValueError\('(.*?)'\)/.exec(code)?.[1] ?? "boom"}\n`,
        images: [],
        timedOut: false,
        truncated: false,
      }
    : drawsAll(code, 0);
const broken = "raise ValueError('quantity missing')";
const mended = "plt.plot([1, 2, 3])";
const noFix = (): { fix: FigureFix; calls: Array<{ code: string; error: string; kind: string; caption: string }> } => {
  const calls: Array<{ code: string; error: string; kind: string; caption: string }> = [];
  return {
    calls,
    fix: async (figure, error) => {
      calls.push({ code: figure.code, error, kind: figure.figureKind, caption: figure.caption });
      return null;
    },
  };
};

it("draws a figure again with the code the fix gives, and the block carries that code", async () => {
  const calls: Array<{ code: string; error: string; kind: string; caption: string }> = [];
  const fix: FigureFix = async (figure, error) => {
    calls.push({ code: figure.code, error, kind: figure.figureKind, caption: figure.caption });
    return `  ${mended}\n`;
  };
  const text = ["Prima.", block(broken, "Una retta."), "Dopo."].join("\n\n");
  const drawn = await drawFigures(text, { python: raises, fix });
  // One call, with the block's kind, caption and code and the error the drawing ended with.
  expect(calls).toEqual([
    {
      code: broken,
      kind: "plot",
      caption: "Una retta.",
      error: expect.stringContaining("ValueError: quantity missing"),
    },
  ]);
  // The image is stored for the corrected code, the caption stays as written, and the text around it is untouched.
  expect(Object.keys(drawn.figures)).toEqual([figureKey(mended)]);
  expect(drawn.markdown).toBe(
    ["Prima.", block(mended, "Una retta.").replace('"kind":null,', ""), "Dopo."].join("\n\n"),
  );
  expect(drawn.markdown).not.toContain("quantity missing");
});

it("asks for a circuit's fix as a circuit, and keeps the kind in the corrected block", async () => {
  const kinds: string[] = [];
  const fix: FigureFix = async (figure) => {
    kinds.push(figure.figureKind);
    return "d += elm.Resistor().right()";
  };
  const text = block("raise ValueError('no element')", "Un resistore.", "circuit");
  const drawn = await drawFigures(text, { python: raises, fix });
  expect(kinds).toEqual(["circuit"]);
  expect(Object.keys(drawn.figures)).toEqual([figureKey("d += elm.Resistor().right()", "circuit")]);
  expect(drawn.markdown).toContain('"kind":"circuit"');
  expect(drawn.markdown).toContain("d += elm.Resistor().right()");
});

it("drops a figure that fails again after its fix, and one whose fix call failed, and asks once for each", async () => {
  const again = vi.fn<FigureFix>(async () => "raise ValueError('still wrong')");
  const text = ["Prima.", block(broken), "Dopo."].join("\n\n");
  const twice = await drawFigures(text, { python: raises, fix: again });
  expect(again).toHaveBeenCalledTimes(1);
  expect(twice).toEqual({ markdown: "Prima.\n\nDopo.", figures: {} });
  const none = noFix();
  expect(await drawFigures(text, { python: raises, fix: none.fix })).toEqual({
    markdown: "Prima.\n\nDopo.",
    figures: {},
  });
  expect(none.calls).toHaveLength(1);
  // A fix that gives back the code it was sent has nothing new to draw.
  let runs = 0;
  const counting: FigureRunner = (code, timeout) => {
    runs++;
    return raises(code, timeout);
  };
  const same = await drawFigures(text, { python: counting, fix: async (figure) => figure.code });
  expect([runs, same.markdown]).toEqual([1, "Prima.\n\nDopo."]);
});

it("keeps the figures that drew while another one is being fixed, in the order they were written", async () => {
  const order: string[] = [];
  const python: FigureRunner = (code, timeout) => {
    order.push(code);
    return raises(code, timeout);
  };
  const text = [block("plt.plot([0])", "A"), block(broken, "B"), block("plt.plot([9])", "C")].join("\n\n");
  const drawn = await drawFigures(text, { python, fix: async () => mended });
  expect(order).toEqual([
    expect.stringContaining("plt.plot([0])"),
    expect.stringContaining(broken),
    expect.stringContaining(mended),
    expect.stringContaining("plt.plot([9])"),
  ]);
  expect(Object.keys(drawn.figures).sort()).toEqual(
    [figureKey("plt.plot([0])"), figureKey(mended), figureKey("plt.plot([9])")].sort(),
  );
});

it("makes no fix call for a kind it cannot draw, a figure it already has, or a runtime that is missing", async () => {
  const none = noFix();
  const circuit = block("raise ValueError('x')", "Un circuito.", "circuit");
  // Python without the drawing pack: the circuit goes, and nobody is asked about it.
  await drawFigures(circuit, { python: raises, kinds: ["plot"], fix: none.fix });
  // An image drawn before is kept, whatever its code would do now.
  const known = { [figureKey(broken)]: PNG };
  const kept = await drawFigures(block(broken), { python: raises, known, fix: none.fix });
  expect(Object.keys(kept.figures)).toEqual([figureKey(broken)]);
  // No sandbox, a crashed one and one that threw: new code would not help.
  for (const python of [
    async () => ({ stdout: "", stderr: "runtime-unavailable", images: [], timedOut: false, truncated: false }),
    async () => ({ stdout: "", stderr: "runtime-crashed", images: [], timedOut: false, truncated: false }),
    async (): Promise<never> => {
      throw new Error("runtime-crashed");
    },
  ] as FigureRunner[])
    await drawFigures(block("plt.plot([1])"), { python, fix: none.fix });
  expect(none.calls).toEqual([]);
});

it("sends the fix a message the model can act on: the time limit that passed, or that nothing was drawn", async () => {
  const none = noFix();
  const slow: FigureRunner = async () => ({ stdout: "", stderr: "", images: [PNG], timedOut: true, truncated: false });
  await drawFigures(block("while True: pass"), { python: slow, fix: none.fix });
  expect(none.calls.at(-1)!.error).toMatch(/longer than 8 seconds/);
  const blank: FigureRunner = async () => ({ stdout: "", stderr: "", images: [], timedOut: false, truncated: false });
  await drawFigures(block("x = 1"), { python: blank, fix: none.fix });
  expect(none.calls.at(-1)!.error).toMatch(/drew nothing/);
});

it("asks for at most four fixes in one text, one per figure", async () => {
  const none = noFix();
  const text = Array.from({ length: 7 }, (_, i) => block(`raise ValueError('no ${i}')`, `Figura ${i}`)).join("\n\n");
  const drawn = await drawFigures(text, { python: raises, fix: none.fix });
  expect(none.calls.map((call) => call.caption)).toEqual(["Figura 0", "Figura 1", "Figura 2", "Figura 3"]);
  expect(drawn).toEqual({ markdown: "", figures: {} });
});

it("stops when the work is stopped during a fix, without drawing or asking again", async () => {
  const controller = new AbortController();
  let runs = 0;
  const python: FigureRunner = (code, timeout) => {
    runs++;
    return raises(code, timeout);
  };
  const fix: FigureFix = async () => {
    controller.abort();
    return mended;
  };
  const text = [block(broken, "A"), block("raise ValueError('b')", "B")].join("\n\n");
  await expect(drawFigures(text, { python, fix, signal: controller.signal })).rejects.toThrow();
  expect(runs).toBe(1);
});

const selection = { provider: "claude", model: "fixer" } as const;
const answer = (code: string) => ({
  text: JSON.stringify({ code }),
  structured: { code },
  provider: "claude",
  model: "fixer",
  inputTokens: 1,
});

it("the fix call is one structured call on the caller's engine with only the block and the error", async () => {
  const sent: Array<{ system?: string; prompt: string; model: string; hasSchema: boolean }> = [];
  const run = async (input: { system?: string; prompt: string; selection: { model: string }; responseSchema?: unknown }) => {
    sent.push({ system: input.system, prompt: input.prompt, model: input.selection.model, hasSchema: Boolean(input.responseSchema) });
    return answer(mended);
  };
  const fix = figureFixer({ selection, run });
  const traceback = `Traceback (most recent call last):\n${"  File \"<exec>\", line 1\n".repeat(200)}ValueError: quantity missing`;
  const figure = { figureKind: "circuit", caption: "Un resistore.", code: "d += elm.Nothing()" } as const;
  expect(await fix(figure, traceback)).toBe(mended);
  expect(sent).toHaveLength(1);
  expect(sent[0]!.model).toBe("fixer");
  expect(sent[0]!.hasSchema).toBe(true);
  const request = JSON.parse(sent[0]!.prompt) as Record<string, string>;
  expect(Object.keys(request).sort()).toEqual(["caption", "code", "error", "kind"]);
  expect(request).toMatchObject({ kind: "circuit", caption: "Un resistore.", code: "d += elm.Nothing()" });
  // The end of a long traceback, cut at a line start: the part that names the cause.
  expect(request.error!.length).toBeLessThanOrEqual(FIGURE_ERROR_MAX);
  expect(request.error!.endsWith("ValueError: quantity missing")).toBe(true);
  expect(request.error!.startsWith("  File")).toBe(true);
  // It carries the rules for code of this kind, and the instruction to correct without obeying the code.
  expect(sent[0]!.system).toContain("could not be drawn");
  expect(sent[0]!.system).toContain("schemdraw code that adds elements to the drawing d");
  expect(sent[0]!.system).not.toContain("matplotlib");
});

it("a fix call that fails leaves the figure unfixed, and one that is stopped stops the work", async () => {
  const failing = figureFixer({
    selection,
    run: async () => {
      throw new Error("the engine is out");
    },
  });
  const figure = { figureKind: "plot", caption: "x", code: "raise ValueError('x')" } as const;
  expect(await failing(figure, "ValueError: x")).toBeNull();
  const controller = new AbortController();
  const stopped = figureFixer({
    selection,
    signal: controller.signal,
    run: async (input) => {
      controller.abort();
      input.signal?.throwIfAborted();
      return answer(mended);
    },
  });
  await expect(stopped(figure, "ValueError: x")).rejects.toThrow();
});
