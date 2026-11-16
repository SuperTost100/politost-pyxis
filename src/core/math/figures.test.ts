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
  // Stopped before it began: nothing is drawn, and the result says it was stopped.
  expect(await drawFigures(block("plt.plot([2])"), { python, signal: controller.signal })).toEqual({
    markdown: "",
    figures: {},
    stopped: true,
  });
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

it("keeps the figures that drew while another one is being fixed, in the place they were written, and draws the corrected one last", async () => {
  const order: string[] = [];
  const python: FigureRunner = (code, timeout) => {
    order.push(code);
    return raises(code, timeout);
  };
  const text = [block("plt.plot([0])", "A"), block(broken, "B"), block("plt.plot([9])", "C")].join("\n\n");
  const drawn = await drawFigures(text, { python, fix: async () => mended });
  // Every figure's first drawing starts at once, in the order written; the corrected code comes after the fix, so last.
  expect(order).toEqual([
    expect.stringContaining("plt.plot([0])"),
    expect.stringContaining(broken),
    expect.stringContaining("plt.plot([9])"),
    expect.stringContaining(mended),
  ]);
  // The text keeps them in the places they were written.
  expect(drawn.markdown.indexOf("plt.plot([0])")).toBeLessThan(drawn.markdown.indexOf(mended));
  expect(drawn.markdown.indexOf(mended)).toBeLessThan(drawn.markdown.indexOf("plt.plot([9])"));
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

it("stops when the work is stopped during a fix, without drawing the corrected code or asking again", async () => {
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
  const drawn = await drawFigures(text, { python, fix, signal: controller.signal });
  expect(drawn).toEqual({ markdown: "", figures: {}, stopped: true });
  // Both first drawings ran together, and the corrected code was not drawn.
  expect(runs).toBe(2);
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

it("hands back the corrected code as the model wrote it: an escape inside a Python string is not turned into a line break", async () => {
  const label = "plt.plot([1, 2])\nplt.ylabel('Voltage\\n(V)')\nplt.xlabel('Time \\t(s)')";
  const figure = { figureKind: "plot", caption: "x", code: "plt.plot([1])" } as const;
  // A structured reply, as the providers that support it give it, and a text reply that holds the same JSON.
  const asText = async () => ({ text: JSON.stringify({ code: label }), provider: "claude", model: "fixer", inputTokens: 1 });
  for (const run of [async () => answer(label), asText])
    expect(await figureFixer({ selection, run })(figure, "ValueError: x")).toBe(label);
});

/** A promise that is settled from outside, for a test that holds a call until it says so. */
function gate<T = void>() {
  let release!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

it("shows each figure as soon as it is drawn, whatever the others are doing: the ones that are fine do not wait for a fix", async () => {
  const mended = "plt.plot([5, 6])";
  const fixing = gate<string>();
  const asked = gate();
  const seen: Array<{ key: string; image: string | null }> = [];
  const text = [block("plt.plot([0])", "Un grafico."), block(broken, "Un circuito rotto."), block("plt.plot([9])", "Un altro.")].join("\n\n");
  const drawing = drawFigures(text, {
    python: raises,
    fix: async () => {
      asked.release();
      return fixing.promise;
    },
    onFigure: (figure) => seen.push(figure),
  });
  await asked.promise;
  // The fix is still out: the two figures that were fine are already drawn and told, each under its own key.
  await vi.waitFor(() => expect(seen).toHaveLength(2));
  expect(seen).toEqual(
    expect.arrayContaining([
      { key: figureKey("plt.plot([0])"), image: PNG },
      { key: figureKey("plt.plot([9])"), image: PNG },
    ]),
  );
  expect(seen.some((figure) => figure.key === figureKey(broken))).toBe(false);
  // The fix comes back: the corrected figure is told under the key of the block as it was written, and that is the last.
  fixing.release(mended);
  const drawn = await drawing;
  expect(seen).toHaveLength(3);
  expect(seen.at(-1)).toEqual({ key: figureKey(broken), image: PNG });
  // The saved form is as before: the images under the code each block carries, and the corrected block in its place.
  expect(Object.keys(drawn.figures).sort()).toEqual([figureKey("plt.plot([0])"), figureKey(mended), figureKey("plt.plot([9])")].sort());
  expect(drawn.markdown).toContain(mended);
  expect(drawn).not.toHaveProperty("stopped");
});

it("tells at once that a figure was left out, when it failed and nothing can correct it, and when its fix failed", async () => {
  const seen: Array<{ key: string; image: string | null }> = [];
  const text = [block("plt.plot([0])", "A"), block(broken, "B")].join("\n\n");
  // No fix at all: the failed one is reported as left out while the other is drawn.
  await drawFigures(text, { python: raises, onFigure: (figure) => seen.push(figure) });
  expect(seen).toEqual(
    expect.arrayContaining([
      { key: figureKey("plt.plot([0])"), image: PNG },
      { key: figureKey(broken), image: null },
    ]),
  );
  // A fix that fails, or answers with code that fails again, ends the same way.
  for (const fix of [async () => null, async () => "raise ValueError('still')"] as FigureFix[]) {
    seen.length = 0;
    await drawFigures(text, { python: raises, fix, onFigure: (figure) => seen.push(figure) });
    expect(seen.find((figure) => figure.key === figureKey(broken))).toEqual({ key: figureKey(broken), image: null });
  }
});

it("keeps the figures already drawn when it is stopped, drops the one being fixed, and says it was stopped", async () => {
  const controller = new AbortController();
  const asked = gate();
  const text = ["Prima.", block("plt.plot([0])", "Un grafico."), block(broken, "Un circuito rotto."), block("plt.plot([9])", "Un altro."), "Dopo."].join("\n\n");
  const seen: Array<{ key: string; image: string | null }> = [];
  const drawing = drawFigures(text, {
    python: raises,
    signal: controller.signal,
    // The fix never answers: only the stop ends it.
    fix: () => {
      asked.release();
      return new Promise<string | null>(() => undefined);
    },
    onFigure: (figure) => seen.push(figure),
  });
  await asked.promise;
  await vi.waitFor(() => expect(seen).toHaveLength(2));
  controller.abort();
  const drawn = await drawing;
  expect(drawn.stopped).toBe(true);
  expect(Object.keys(drawn.figures).sort()).toEqual([figureKey("plt.plot([0])"), figureKey("plt.plot([9])")].sort());
  // The text around them is whole, the drawn blocks stay and the one in progress is gone.
  expect(drawn.markdown).toContain("Prima.");
  expect(drawn.markdown).toContain("Dopo.");
  expect(drawn.markdown).toContain("plt.plot([0])");
  expect(drawn.markdown).toContain("plt.plot([9])");
  expect(drawn.markdown).not.toContain(broken);
  // Nothing is told after the stop, whatever the work still in the air does.
  expect(seen).toHaveLength(2);
});

it("returns at once with what it has when the stop comes while a figure is still being drawn", async () => {
  const controller = new AbortController();
  const started = gate();
  const python: FigureRunner = (code, timeout) => {
    if (code.includes("plt.plot([2])")) {
      started.release();
      return new Promise(() => undefined);
    }
    return drawsAll(code, timeout);
  };
  const drawing = drawFigures([block("plt.plot([1])"), block("plt.plot([2])")].join("\n\n"), { python, signal: controller.signal });
  await started.promise;
  controller.abort();
  const drawn = await drawing;
  expect(drawn.stopped).toBe(true);
  expect(Object.keys(drawn.figures)).toEqual([figureKey("plt.plot([1])")]);
});

it("tells that a block past the limit is left out, once, and tells nothing once the work is stopped", async () => {
  const blocks = Array.from({ length: FIGURE_MAX + 2 }, (_, i) => block(`plt.plot([${i}])`, `Figura ${i}`));
  const seen: Array<{ key: string; image: string | null }> = [];
  const text = [...blocks, blocks[FIGURE_MAX + 1]!].join("\n\n");
  const drawn = await drawFigures(text, { python: drawsAll, onFigure: (figure) => seen.push(figure) });
  // The first FIGURE_MAX are drawn, the two after them are removed and told as left out, and a repeated block is told once.
  expect(seen.filter((figure) => figure.image !== null)).toHaveLength(FIGURE_MAX);
  expect(seen.filter((figure) => figure.image === null).map((figure) => figure.key).sort()).toEqual(
    [figureKey(`plt.plot([${FIGURE_MAX}])`), figureKey(`plt.plot([${FIGURE_MAX + 1}])`)].sort(),
  );
  expect(seen).toHaveLength(FIGURE_MAX + 2);
  expect(Object.keys(drawn.figures)).toHaveLength(FIGURE_MAX);
  // Stopped before it began: nothing is told, over the limit or not.
  const controller = new AbortController();
  controller.abort();
  const told: unknown[] = [];
  await drawFigures(text, { python: drawsAll, signal: controller.signal, onFigure: (figure) => told.push(figure) });
  expect(told).toEqual([]);
});

it("keeps the pictures it was given when the stop comes before it begins, as it does when the stop comes after", async () => {
  const controller = new AbortController();
  controller.abort();
  const known = { [figureKey("plt.plot([1])")]: PNG };
  let runs = 0;
  const python: FigureRunner = async (code, timeout) => {
    runs++;
    return drawsAll(code, timeout);
  };
  const drawn = await drawFigures(["Prima.", block("plt.plot([1])", "Nota."), block("plt.plot([2])", "Nuova."), "Dopo."].join("\n\n"), {
    python,
    known,
    signal: controller.signal,
  });
  expect(drawn.stopped).toBe(true);
  // The figure that already had its picture stays with it; the new one, never started, is left out.
  expect(drawn.figures).toEqual({ [figureKey("plt.plot([1])")]: PNG });
  expect(drawn.markdown).toContain("plt.plot([1])");
  expect(drawn.markdown).not.toContain("plt.plot([2])");
  expect(drawn.markdown).toContain("Dopo.");
  expect(runs).toBe(0);
});

it("tells nothing after a callback that throws in the request loop, and leaves no unhandled rejection", async () => {
  const controller = new AbortController();
  const added = vi.spyOn(controller.signal, "addEventListener");
  const removed = vi.spyOn(controller.signal, "removeEventListener");
  const held = gate();
  const python: FigureRunner = async (code, timeout) => {
    if (code.includes("plt.plot([2])")) await held.promise;
    return drawsAll(code, timeout);
  };
  const known = "plt.plot([3])";
  const told: string[] = [];
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    // The first block's drawing is in the air when the known one throws in the request loop.
    const drawing = drawFigures([block("plt.plot([2])"), block(known)].join("\n\n"), {
      python,
      signal: controller.signal,
      known: { [figureKey(known)]: PNG },
      onFigure: (event) => {
        told.push(event.key);
        throw new Error("the page could not take it");
      },
    });
    await expect(drawing).rejects.toThrow("the page could not take it");
    expect(told).toEqual([figureKey(known)]);
    // Whatever was attached to the signal is let go.
    expect(removed.mock.calls.length).toBeGreaterThanOrEqual(added.mock.calls.length);
    held.release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(told).toHaveLength(1);
    expect(unhandled).toEqual([]);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

it("tells nothing after it has rejected, and lets go of the signal", async () => {
  const controller = new AbortController();
  const removed = vi.spyOn(controller.signal, "removeEventListener");
  const held = gate();
  const python: FigureRunner = async (code, timeout) => {
    if (code.includes("plt.plot([2])")) await held.promise;
    return drawsAll(code, timeout);
  };
  let calls = 0;
  const drawing = drawFigures([block("plt.plot([1])"), block("plt.plot([2])")].join("\n\n"), {
    python,
    signal: controller.signal,
    onFigure: () => {
      calls++;
      throw new Error("the page could not take it");
    },
  });
  await expect(drawing).rejects.toThrow("the page could not take it");
  expect(calls).toBe(1);
  // The other figure is drawn after the rejection and tells nobody.
  held.release();
  await vi.waitFor(() => expect(removed).toHaveBeenCalled());
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(calls).toBe(1);
});
