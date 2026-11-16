import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { createPlan, readPlan } from "../plans/create";
import { exportPlan, importPlan } from "../plans/file";
import { importSmartbook } from "../sources/smartbook";
import { exportMarkdown } from "../share/markdown";
import { planFileSchema } from "../../shared/plan-file";
import { figureKey } from "../../shared/smart-text";
import { isFigureFixCall } from "../engine/recorded-plan";
import type { FigureRunner } from "../math/figures";
import { rewriteLessonSection, writeLesson } from "./openLesson";

const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const figure = (caption: string, code: string, kind?: string) =>
  ["```pyxis-figure", JSON.stringify({ kind, caption, code }), "```"].join("\n");
const parabola = "x = np.linspace(-2, 2)\nplt.plot(x, x**2)";
const broken = "plt.plot(undefined_name)";

// A recorded lesson reply: one figure that draws, one whose code fails.
const recorded = [
  "## Velocità",
  "",
  "La velocità è lo spostamento diviso il tempo.",
  "",
  figure("La parabola $y = x^2$.", parabola),
  "",
  "## Accelerazione",
  "",
  "L'accelerazione cambia la velocità.",
  "",
  figure("Un grafico che non si disegna.", broken),
  "",
  "Fine della lezione.",
].join("\n");

function setup() {
  const db = openDatabase(":memory:");
  const imported = importSmartbook(
    db,
    zipSync({
      "smartbook.json": strToU8(
        JSON.stringify({
          id: "demo",
          title: "Fisica",
          access: "public",
          chapters: [{ id: "c1", number: 1, title: "Moti", file: "01.md" }],
        }),
      ),
      "chapters/01.md": strToU8(
        "## p1 | Velocità\nLa velocità descrive il moto.\n\n## p2 | Accelerazione\nL'accelerazione cambia la velocità.\n",
      ),
    }),
  );
  db.prepare(
    "INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES ('default', ?, 1)",
  ).run(JSON.stringify({ provider: "claude", model: "m" }));
  const { planId } = createPlan(db, {
    title: "Fisica 1",
    sourceIds: [imported.sourceId],
  });
  const topicId = readPlan(db, planId)!.topics[0]!.id;
  const systems: string[] = [];
  // The calls that correct a figure, and their answers in turn: a corrected code, or none to leave the code as it was.
  const fixes: Array<string | null> = [];
  const fixCalls: Array<{ model: string; request: Record<string, string> }> = [];
  let text = recorded;
  const run: Parameters<typeof writeLesson>[3] = async (input) => {
    if (isFigureFixCall(input.system)) {
      const request = JSON.parse(input.prompt) as Record<string, string>;
      fixCalls.push({ model: input.selection.model, request });
      const code = fixes[fixCalls.length - 1] ?? request.code!;
      return { text: JSON.stringify({ code }), structured: { code }, provider: "claude", model: "fixer", inputTokens: 1 };
    }
    systems.push(input.system ?? "");
    return { text, provider: "claude", model: "m", inputTokens: 1 };
  };
  const programs: string[] = [];
  // The sandbox stand-in: code that names an undefined variable fails like Python would, the rest draws.
  const python: FigureRunner = async (code) => {
    programs.push(code);
    return code.includes("undefined_name")
      ? {
          stdout: "",
          stderr: "NameError: name 'undefined_name' is not defined\n",
          images: [],
          timedOut: false,
          truncated: false,
        }
      : {
          stdout: "",
          stderr: "",
          images: [PNG],
          timedOut: false,
          truncated: false,
        };
  };
  return {
    db,
    planId,
    topicId,
    run,
    python,
    systems,
    programs,
    fixes,
    fixCalls,
    reply: (next: string) => {
      text = next;
    },
  };
}

describe("lesson figures", () => {
  it("draws a lesson's figures in the sandbox, leaves out the one that fails and caches the rest", async () => {
    const { db, planId, topicId, run, python, systems, programs } = setup();
    const lesson = await writeLesson(db, planId, topicId, run, { python });
    expect(systems[0]).toContain("pyxis-figure");
    expect(programs).toHaveLength(2);
    expect(programs[0]).toContain(parabola);
    expect(programs[0]!.trim().endsWith("plt.show()")).toBe(true);
    // The failed figure is gone; the lesson around it is intact.
    expect(lesson.markdown).toContain("La parabola $y = x^2$.");
    expect(lesson.markdown).not.toContain("undefined_name");
    expect(lesson.markdown).not.toContain("Un grafico che non si disegna.");
    expect(lesson.markdown).toContain(
      "L'accelerazione cambia la velocità.\n\nFine della lezione.",
    );
    expect(lesson.figures).toEqual({ [figureKey(parabola)]: PNG });
    const body = JSON.parse(
      (
        db
          .prepare("SELECT body_json FROM items WHERE id = ?")
          .get(lesson.itemId) as { body_json: string }
      ).body_json,
    ) as { figures?: Record<string, string> };
    expect(body.figures).toEqual(lesson.figures);

    // Opening it again reads the cache: no model call, no sandbox run.
    const again = await writeLesson(db, planId, topicId, run, { python });
    expect(again).toEqual(lesson);
    expect([systems.length, programs.length]).toEqual([1, 2]);

    // Exports carry the caption, not the code.
    const exported = exportMarkdown(db, {
      planId,
      topicId,
      kind: "lesson",
    }).markdown;
    expect(exported).toContain("*Figura: La parabola $y = x^2$.*");
    expect(exported).not.toContain("plt.plot");
    db.close();
  });

  it("drops figures a run could not give, offers none without a sandbox, and keeps drawn ones through a rewrite", async () => {
    const { db, planId, topicId, run, systems, programs, python, reply } =
      setup();
    // An image from a run that hit its time limit is not trusted.
    const timedOut: FigureRunner = async () => ({
      stdout: "",
      stderr: "",
      images: [PNG],
      timedOut: true,
      truncated: false,
    });
    const late = await writeLesson(db, planId, topicId, run, {
      python: timedOut,
    });
    expect(late.figures).toBeUndefined();
    expect(late.markdown).not.toContain("pyxis-figure");

    // Without the Python runtime the prompt does not offer figures, and any the model writes anyway are dropped.
    const none = await writeLesson(db, planId, topicId, run, {
      python: null,
      regenerate: true,
    });
    expect(systems.at(-1)).not.toContain("pyxis-figure");
    expect(none.markdown).not.toContain("pyxis-figure");

    const drawn = await writeLesson(db, planId, topicId, run, {
      python,
      regenerate: true,
    });
    expect(Object.keys(drawn.figures ?? {})).toEqual([figureKey(parabola)]);
    const before = programs.length;
    // Rewriting the second part keeps the first part's figure without drawing it again, even with no sandbox now.
    reply(
      "## Accelerazione\n\nL'accelerazione è la variazione della velocità.",
    );
    const rewritten = await rewriteLessonSection(db, planId, topicId, run, {
      section: 1,
      python: null,
    });
    expect(rewritten.figures).toEqual(drawn.figures);
    expect(rewritten.markdown).toContain("La parabola $y = x^2$.");
    expect(programs.length).toBe(before);
    // A rewritten part with a new figure draws only that one.
    const circle = "t = np.linspace(0, 6.3)\nplt.plot(np.cos(t), np.sin(t))";
    reply(
      `## Accelerazione\n\nUn moto circolare.\n\n${figure("Una circonferenza.", circle)}`,
    );
    const withCircle = await rewriteLessonSection(db, planId, topicId, run, {
      section: 1,
      python,
    });
    expect(programs.slice(before)).toHaveLength(1);
    expect(programs.at(-1)).toContain(circle);
    expect(Object.keys(withCircle.figures ?? {}).sort()).toEqual(
      [figureKey(parabola), figureKey(circle)].sort(),
    );
    db.close();
  });

  it("draws a circuit with schemdraw and stores it under its own key", async () => {
    const { db, planId, topicId, run, python, systems, programs, reply } = setup();
    const rc = "d += elm.SourceV().up().label('V')\nd += elm.Resistor().right().label('R')\nd += elm.Capacitor().down().label('C')\nd += elm.Line().left()";
    reply(
      `## Il circuito RC\n\nUn resistore e un condensatore in serie.\n\n${figure("Il circuito RC in serie.", rc, "circuit")}\n\nFine.`,
    );
    const lesson = await writeLesson(db, planId, topicId, run, { python });
    // The prompt offers the kind, and the code runs on the drawing the sandbox prepared.
    expect(systems[0]).toContain('"circuit"');
    expect(systems[0]).not.toContain("[figure");
    expect(programs).toHaveLength(1);
    expect(programs[0]).toContain("import schemdraw.elements as elm");
    expect(programs[0]).toContain(rc);
    expect(lesson.markdown).toContain("Il circuito RC in serie.");
    // The same code as a plot would have another key, so a circuit never shows a plot's image.
    expect(lesson.figures).toEqual({ [figureKey(rc, "circuit")]: PNG });
    expect(figureKey(rc, "circuit")).not.toBe(figureKey(rc));
    db.close();
  });

  it("corrects a figure that failed once, keeps the fixed one in the cached lesson and never asks about it again", async () => {
    const { db, planId, topicId, run, python, programs, fixes, fixCalls } = setup();
    const mended = "x = np.linspace(-1, 1)\nplt.plot(x, x)";
    fixes.push(mended);
    const lesson = await writeLesson(db, planId, topicId, run, { python });
    // The call named the lesson's engine and held the block and the error.
    expect(fixCalls).toHaveLength(1);
    expect(fixCalls[0]!.model).toBe("m");
    expect(fixCalls[0]!.request).toMatchObject({ kind: "plot", caption: "Un grafico che non si disegna.", code: broken });
    expect(fixCalls[0]!.request.error).toContain("NameError");
    // Both figures are in the lesson, the second under the corrected code, and its block carries that code.
    expect(lesson.figures).toEqual({ [figureKey(parabola)]: PNG, [figureKey(mended)]: PNG });
    expect(lesson.markdown).toContain(figure("Un grafico che non si disegna.", mended));
    expect(lesson.markdown).not.toContain("undefined_name");
    expect(programs).toHaveLength(3);
    // Opening it again reads the cache: no model call, no fix, no drawing.
    await writeLesson(db, planId, topicId, run, { python });
    expect([fixCalls.length, programs.length]).toEqual([1, 3]);
    db.close();
  });

  it("draws a figure's code as the model wrote it: the escapes of its Python strings reach the sandbox unchanged, in the saved block too", async () => {
    const { db, planId, topicId, run, python, programs, reply } = setup();
    const labelled = "plt.plot([1, 2])\nplt.ylabel('Voltage\\n(V)')\nplt.xlabel(r'$\\theta$ \\nu')";
    reply(`## Velocità\n\nUn grafico.\n\n${figure("Con etichette.", labelled)}\n`);
    const lesson = await writeLesson(db, planId, topicId, run, { python });
    expect(programs.some((program) => program.includes("plt.ylabel('Voltage\\n(V)')"))).toBe(true);
    expect(programs.some((program) => program.includes("plt.xlabel(r'$\\theta$ \\nu')"))).toBe(true);
    expect(lesson.figures).toEqual({ [figureKey(labelled)]: PNG });
    expect(lesson.markdown).toContain(figure("Con etichette.", labelled));
    db.close();
  });

  it("saves nothing and ends as stopped when Stop is pressed while a figure is being corrected, and writes the lesson again afterwards", async () => {
    const { db, planId, topicId, run, python, systems } = setup();
    const stop = new AbortController();
    const stopping: typeof run = async (input) => {
      if (!isFigureFixCall(input.system)) return run(input);
      stop.abort();
      throw new DOMException("aborted", "AbortError");
    };
    await expect(writeLesson(db, planId, topicId, stopping, { python, signal: stop.signal })).rejects.toMatchObject({ name: "AbortError" });
    // Nothing of the lesson was kept: opening it again asks the model again, and draws.
    const written = systems.length;
    const again = await writeLesson(db, planId, topicId, run, { python });
    expect(systems.length).toBe(written + 1);
    expect(again.markdown).toContain("La velocità è lo spostamento diviso il tempo.");
    db.close();
  });

  it("asks for no fix when no sandbox can draw, and for one at most per failed figure in a rewritten section", async () => {
    const { db, planId, topicId, run, python, fixCalls, reply } = setup();
    await writeLesson(db, planId, topicId, run, { python: null });
    expect(fixCalls).toEqual([]);
    await writeLesson(db, planId, topicId, run, { python, regenerate: true });
    // The unfixed failure above (a fix that changed nothing) is one call; a rewritten section with two new failures
    // adds one call for each.
    expect(fixCalls).toHaveLength(1);
    reply(
      `## Accelerazione\n\nDue grafici.\n\n${figure("Uno.", "plt.plot(undefined_name_one)")}\n\n${figure("Due.", "plt.plot(undefined_name_two)")}`,
    );
    await rewriteLessonSection(db, planId, topicId, run, { section: 1, python });
    expect(fixCalls.map((call) => call.request.caption)).toEqual(["Un grafico che non si disegna.", "Uno.", "Due."]);
    db.close();
  });

  it("carries figures in a shared plan file and refuses one that is not a PNG", async () => {
    const { db, planId, topicId, run, python } = setup();
    const lesson = await writeLesson(db, planId, topicId, run, { python });
    const file = planFileSchema.parse(
      JSON.parse(JSON.stringify(exportPlan(db, planId))),
    );
    const item = file.items!.find((entry) => entry.kind === "lesson")!;
    expect((item.body as { figures?: unknown }).figures).toEqual(
      lesson.figures,
    );

    const fresh = openDatabase(":memory:");
    const copy = importPlan(fresh, file, Date.now() + 5000);
    const copiedTopic = readPlan(fresh, copy)!.topics[0]!.id;
    const offline: Parameters<typeof writeLesson>[3] = async () => {
      throw new Error("no model in this test");
    };
    const sandbox: FigureRunner = async () => {
      throw new Error("an imported lesson runs no figure code");
    };
    fresh
      .prepare(
        "INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES ('default', ?, 1)",
      )
      .run(JSON.stringify({ provider: "claude", model: "m" }));
    const opened = await writeLesson(fresh, copy, copiedTopic, offline, {
      python: sandbox,
    });
    expect(opened.figures).toEqual(lesson.figures);
    expect(opened.markdown).toBe(lesson.markdown);

    const svg = JSON.parse(JSON.stringify(file)) as typeof file;
    (
      svg.items!.find((entry) => entry.kind === "lesson")!.body as {
        figures: Record<string, string>;
      }
    ).figures = {
      [figureKey(parabola)]: "data:image/svg+xml;base64,PHN2Zy8+",
    };
    expect(planFileSchema.safeParse(svg).success).toBe(false);
    db.close();
    fresh.close();
  });
});
