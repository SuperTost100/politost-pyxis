import { afterEach, expect, it, vi } from "vitest";
import { openDatabase } from "../db/connection";
import type { EngineResult } from "../engine/funnel";
import type { FigureRunner } from "../math/figures";
import { darkFigureKey, figureKey } from "../../shared/smart-text";
import { darkFigure } from "../math/dark-figure";
import { isFigureFixCall } from "../engine/recorded-plan";
import { setUsageRecorder, storeUsage } from "../engine/usage";
import { askTurn, readChat, regenerateTurn } from "./turn";
import { contextBlock } from "./prompts";
import { visibleText } from "./visible";

const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
/** What a turn stores for figures drawn with these keys: each picture and its dark one. */
const figuresWithDark = (...keys: string[]) =>
  Object.fromEntries(keys.flatMap((key) => [[key, PNG], [darkFigureKey(key), darkFigure(PNG)!]]));
const withDark = (...keys: string[]) => keys.flatMap((key) => [key, darkFigureKey(key)]);
const figure = (caption: string, code: string) =>
  ["```pyxis-figure", JSON.stringify({ caption, code }), "```"].join("\n");
const sine = "x = np.linspace(0, 6.3)\nplt.plot(x, np.sin(x))";
// A recorded answer: a figure that draws and one whose code raises.
const answer = [
  "Il seno oscilla tra $-1$ e $1$.",
  "",
  figure("Il grafico di $\\sin x$.", sine),
  "",
  figure("Un circuito che non si disegna.", "raise ValueError('no')"),
  "",
  "Il periodo è $2\\pi$.",
  "<followups>",
  "E il coseno?",
  "</followups>",
].join("\n");
const python: FigureRunner = async (code) =>
  code.includes("raise ValueError")
    ? {
        stdout: "",
        stderr: "ValueError: no\n",
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

/**
 * `fixes` answer the calls that correct a figure, in turn: a corrected code, or an error for a call that fails. Without
 * them a fix call answers with the code it was sent, which changes nothing.
 */
function setup(fixes: Array<string | Error> = [], stop?: AbortController) {
  const db = openDatabase(":memory:");
  db.prepare(
    "INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES ('default', ?, 1)",
  ).run(JSON.stringify({ provider: "claude", model: "claude-sonnet-5" }));
  const calls: Array<{ system: string; prompt: string }> = [];
  const fixCalls: Array<{ prompt: string; model: string }> = [];
  const run = async (input: {
    system?: string;
    prompt: string;
    selection?: { model: string };
  }): Promise<EngineResult> => {
    if (isFigureFixCall(input.system)) {
      // The student presses Stop while the figure is being corrected: the call ends the way a stopped call does.
      if (stop) {
        stop.abort();
        throw new DOMException("aborted", "AbortError");
      }
      fixCalls.push({ prompt: input.prompt, model: input.selection?.model ?? "" });
      const next = fixes[fixCalls.length - 1] ?? (JSON.parse(input.prompt) as { code: string }).code;
      if (next instanceof Error) throw next;
      return { text: JSON.stringify({ code: next }), structured: { code: next }, provider: "claude", model: "fixer", inputTokens: 5 };
    }
    calls.push({ system: input.system ?? "", prompt: input.prompt });
    // The math check extraction gets an empty list; the tutor gets the recorded answer.
    if (input.system?.startsWith("Extract mathematical claims"))
      return {
        text: '{"checks": []}',
        structured: { checks: [] },
        provider: "claude",
        model: "m",
        inputTokens: 1,
      };
    return { text: answer, provider: "claude", model: "m", inputTokens: 1 };
  };
  return { db, calls, fixCalls, run };
}

afterEach(() => setUsageRecorder(undefined));

it("draws an answer's figures, leaves out the one that fails and cannot be fixed, and stores the images with the message", async () => {
  const { db, calls, fixCalls, run } = setup();
  const result = await askTurn(db, {
    text: "Com'è fatto il seno?",
    allowGeneral: true,
    run,
    python,
  });
  // The system prompt carries the instruction for every kind, and the context block of the message names the kinds that can be drawn.
  expect(calls[0]!.system).toContain("pyxis-figure");
  expect(calls[0]!.prompt).toContain("Figures you can draw: plot, circuit, graph.");
  const message = result.message!;
  expect(message.figures).toEqual(figuresWithDark(figureKey(sine)));
  // The figure block stays as the model wrote it; the failed one is gone.
  expect(message.body).toContain(figure("Il grafico di $\\sin x$.", sine));
  expect(message.body).not.toContain("raise ValueError");
  // The failed one was sent to a fix call once, and a fix that changed nothing left it out.
  expect(fixCalls).toHaveLength(1);
  expect(message.body).toContain("Il periodo è $2\\pi$.");
  expect(message.followups).toEqual(["E il coseno?"]);
  const stored = readChat(db, result.chatId).at(-1)!;
  expect(stored.figures).toEqual(message.figures);
  expect(stored.body).toBe(message.body);
  // Search and export read the caption, not the code.
  const raw = (
    db.prepare("SELECT body FROM messages WHERE id = ?").get(message.id) as {
      body: string;
    }
  ).body;
  expect(visibleText("assistant", raw)).toContain("*Il grafico di $\\sin x$.*");
  expect(visibleText("assistant", raw)).not.toContain("np.sin");

  // The next turn shows the model its earlier figure as a caption.
  await askTurn(db, {
    chatId: result.chatId,
    text: "E il coseno?",
    allowGeneral: true,
    run,
    python,
  });
  const next = calls
    .filter((call) => !call.system.startsWith("Extract"))
    .at(-1)!;
  expect(next.prompt).toContain("*Figure: Il grafico di $\\sin x$.*");
  expect(next.prompt).not.toContain("np.sin");
});

it("offers no figures without a sandbox, and keeps none in a stopped reply", async () => {
  const { db, calls, run } = setup();
  const plain = await askTurn(db, {
    text: "Il seno?",
    allowGeneral: true,
    run,
    python: null,
  });
  expect(calls[0]!.prompt).toContain("Figures you can draw: none.");
  expect(calls[0]!.prompt).toContain("Impostazioni › Studio › Disegni");
  expect(calls[0]!.prompt).toContain("ASCII");
  expect(plain.message!.body).not.toContain("pyxis-figure");
  expect(plain.message!.figures).toBeUndefined();
  expect(readChat(db, plain.chatId).at(-1)!.figures).toBeUndefined();

  // The system prompt is the same with and without the drawing pack.
  await askTurn(db, { text: "Il seno?", allowGeneral: true, run, python });
  expect(calls.filter((call) => !call.system.startsWith("Extract")).at(-1)!.system).toBe(calls[0]!.system);

  const stopped = await askTurn(db, {
    text: "Il seno?",
    allowGeneral: true,
    python,
    run: async (input) => {
      input.onDelta?.(`Il seno.\n\n${figure("Il grafico.", sine)}\n\nE poi`);
      throw new DOMException("aborted", "AbortError");
    },
  });
  expect(stopped.message!.stopped).toBe(true);
  expect(stopped.message!.body).toBe("Il seno.\n\nE poi");
});

it("corrects a figure that failed with one call on this turn's engine, shows the fixed one, and counts the call with the chat", async () => {
  const mended = "x = np.linspace(0, 1)\nplt.plot(x, x)";
  const { db, calls, fixCalls, run } = setup([mended]);
  setUsageRecorder((usage, where) => storeUsage(db, usage, where));
  const result = await askTurn(db, { text: "Com'è fatto il seno?", allowGeneral: true, run, python });
  // The call named the engine the turn chose, and held the block and the error, nothing of the answer around it.
  expect(fixCalls).toHaveLength(1);
  expect(fixCalls[0]!.model).toBe("claude-sonnet-5");
  const request = JSON.parse(fixCalls[0]!.prompt) as Record<string, string>;
  expect(request).toMatchObject({ kind: "plot", caption: "Un circuito che non si disegna.", code: "raise ValueError('no')" });
  expect(request.error).toContain("ValueError: no");
  expect(fixCalls[0]!.prompt).not.toContain("Il seno oscilla");
  // Both figures are drawn and stored, the second under the corrected code, and the saved block carries it.
  const message = result.message!;
  expect(message.figures).toEqual(figuresWithDark(figureKey(sine), figureKey(mended)));
  expect(message.body).toContain(figure("Un circuito che non si disegna.", mended));
  expect(message.body).not.toContain("raise ValueError");
  expect(readChat(db, result.chatId).at(-1)!.figures).toEqual(message.figures);
  expect(
    db.prepare("SELECT COUNT(*) FROM engine_usage WHERE chat_id = ? AND model = 'fixer'").pluck().get(result.chatId),
  ).toBe(1);
  expect(calls.filter((call) => call.system.includes("could not be drawn"))).toEqual([]);
});

it("drops a figure whose fix fails or fails again, and the answer around it is saved whole", async () => {
  for (const fixes of [[new Error("the engine is out")], ["raise ValueError('still')"]]) {
    const { db, fixCalls, run } = setup(fixes);
    const result = await askTurn(db, { text: "Com'è fatto il seno?", allowGeneral: true, run, python });
    expect(fixCalls).toHaveLength(1);
    const message = result.message!;
    expect(message.figures).toEqual(figuresWithDark(figureKey(sine)));
    expect(message.body).not.toContain("raise ValueError");
    expect(message.body).not.toContain("Un circuito che non si disegna.");
    expect(message.body).toContain("Il periodo è $2\\pi$.");
    expect(message.body).toContain(figure("Il grafico di $\\sin x$.", sine));
  }
});

it("draws the code of a figure as written, and the corrected code as the fix call gave it, with the escapes of its Python strings intact", async () => {
  const titled = "plt.plot([3])\nplt.title('Primo\\nSecondo')";
  const label = "plt.plot([1, 2])\nplt.ylabel('Voltage\\n(V)')";
  const withEscape = [
    "Due grafici.",
    "",
    figure("Il primo.", titled),
    "",
    figure("Un circuito che non si disegna.", "raise ValueError('no')"),
  ].join("\n");
  const { db, run } = setup([label]);
  const programs: string[] = [];
  const drawing: FigureRunner = async (code, timeoutMs) => {
    programs.push(code);
    return python(code, timeoutMs);
  };
  const replying: typeof run = async (input) =>
    isFigureFixCall(input.system) || input.system?.startsWith("Extract mathematical claims")
      ? run(input)
      : { text: withEscape, provider: "claude", model: "m", inputTokens: 1 };
  const result = await askTurn(db, { text: "Com'è fatto il seno?", allowGeneral: true, run: replying, python: drawing });
  // The code as the model wrote it, and the corrected code as the fix call gave it, reach the sandbox with the backslash
  // and the n of their Python strings, which a line break in their place would break.
  expect(programs.some((program) => program.includes("plt.title('Primo\\nSecondo')")), "the code as the model wrote it").toBe(true);
  expect(programs.some((program) => program.includes("plt.ylabel('Voltage\\n(V)')")), "the corrected code").toBe(true);
  expect(Object.keys(result.message!.figures ?? {})).toEqual(withDark(figureKey(titled), figureKey(label)));
  expect(result.message!.body).toContain(figure("Un circuito che non si disegna.", label));
});

it("keeps the whole answer when Stop is pressed while a figure is being corrected, with the figure that was already drawn, and keeps the chat", async () => {
  const stop = new AbortController();
  const { db, run } = setup([], stop);
  const result = await askTurn(db, { text: "Com'è fatto il seno?", allowGeneral: true, run, python, signal: stop.signal });
  const message = result.message!;
  // What the student had read is saved whole, marked stopped. The sine had drawn before the stop and stays with its
  // picture; the figure being corrected is left out.
  expect(message.stopped).toBe(true);
  expect(message.body).toContain("Il seno oscilla tra $-1$ e $1$.");
  expect(message.body).toContain("Il periodo è $2\\pi$.");
  expect(message.body).toContain(figure("Il grafico di $\\sin x$.", sine));
  expect(message.body).not.toContain("raise ValueError");
  expect(message.figures).toEqual(figuresWithDark(figureKey(sine)));
  const saved = readChat(db, result.chatId);
  expect(saved.at(-1)!.body).toBe(message.body);
  expect(db.prepare("SELECT COUNT(*) FROM chats WHERE id = ?").pluck().get(result.chatId)).toBe(1);
});

it("keeps the whole answer when Stop is pressed while a figure is being drawn, between two figures, or after the last one", async () => {
  for (const when of ["during the first drawing", "after the first drawing"]) {
    const stop = new AbortController();
    const { db, run } = setup();
    const drawing: FigureRunner = async (code, timeoutMs) => {
      const result = await python(code, timeoutMs);
      if (when === "during the first drawing" || code.includes("np.sin")) stop.abort();
      return result;
    };
    const result = await askTurn(db, { text: "Com'è fatto il seno?", allowGeneral: true, run, python: drawing, signal: stop.signal });
    expect(result.message!.stopped, when).toBe(true);
    expect(result.message!.body, when).toContain("Il periodo è $2\\pi$.");
    expect(result.message!.body, when).not.toContain("pyxis-figure");
    expect(db.prepare("SELECT COUNT(*) FROM chats WHERE id = ?").pluck().get(result.chatId), when).toBe(1);
  }
});

it("asks for no fix in a turn that offers no figures", async () => {
  const { db, fixCalls, run } = setup(["plt.plot([1])"]);
  await askTurn(db, { text: "Il seno?", allowGeneral: true, run, python: null });
  expect(fixCalls).toEqual([]);
});

it("tells the chat each figure as it is drawn, and a stop keeps the ones already drawn with their images, as the saved reply", async () => {
  const first = "x = np.linspace(0, 1)\nplt.plot(x, x)";
  const last = "x = np.linspace(0, 2)\nplt.plot(x, x**2)";
  const reply = ["Tre figure.", "", figure("La prima.", first), "", figure("Una che non si disegna.", "raise ValueError('no')"), "", figure("L'ultima.", last), "", "Fine."].join("\n");
  const { db, run } = setup();
  const stop = new AbortController();
  let fixing!: () => void;
  const asked = new Promise<void>((resolve) => {
    fixing = resolve;
  });
  const replying: typeof run = async (input) => {
    if (isFigureFixCall(input.system)) {
      // The fix is out and never comes back; the stop is what ends it.
      fixing();
      return new Promise<EngineResult>((_, reject) => stop.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    }
    return input.system?.startsWith("Extract mathematical claims") ? run(input) : { text: reply, provider: "claude", model: "m", inputTokens: 1 };
  };
  const seen: Array<{ key: string; image: string | null }> = [];
  const asking = askTurn(db, {
    text: "Disegna tre figure.",
    allowGeneral: true,
    run: replying,
    python,
    signal: stop.signal,
    onFigure: (figure) => seen.push(figure),
  });
  await asked;
  // While the third is being corrected the other two are told, each under the key of its block.
  await vi.waitFor(() => expect(seen).toHaveLength(2));
  expect(seen.map((figure) => figure.key).sort()).toEqual([figureKey(first), figureKey(last)].sort());
  stop.abort();
  const result = await asking;
  const message = result.message!;
  expect(message.stopped).toBe(true);
  expect(message.figures).toEqual(figuresWithDark(figureKey(first), figureKey(last)));
  expect(message.body).toContain(figure("La prima.", first));
  expect(message.body).toContain(figure("L'ultima.", last));
  expect(message.body).not.toContain("raise ValueError");
  expect(message.body).toContain("Fine.");
  // What was shown is what is saved: a reload finds the same two pictures and the chat is still there.
  expect(readChat(db, result.chatId).at(-1)!.figures).toEqual(message.figures);
  expect(db.prepare("SELECT COUNT(*) FROM chats WHERE id = ?").pluck().get(result.chatId)).toBe(1);
});

/** A chat whose reply was stopped while its third figure was being corrected: the other two are drawn and saved with it. */
async function stoppedWithTwoFigures() {
  const first = "x = np.linspace(0, 1)\nplt.plot(x, x)";
  const last = "x = np.linspace(0, 2)\nplt.plot(x, x**2)";
  const reply = ["Tre figure.", "", figure("La prima.", first), "", figure("Una che non si disegna.", "raise ValueError('no')"), "", figure("L'ultima.", last), "", "Fine."].join("\n");
  const { db, run } = setup();
  const stop = new AbortController();
  let fixing!: () => void;
  const asked = new Promise<void>((resolve) => {
    fixing = resolve;
  });
  const replying: typeof run = async (input) => {
    if (isFigureFixCall(input.system)) {
      fixing();
      return new Promise<EngineResult>((_, reject) => stop.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    }
    return input.system?.startsWith("Extract mathematical claims") ? run(input) : { text: reply, provider: "claude", model: "m", inputTokens: 1 };
  };
  const asking = askTurn(db, { text: "Disegna tre figure.", allowGeneral: true, run: replying, python, signal: stop.signal });
  await asked;
  stop.abort();
  const stopped = await asking;
  expect(stopped.message!.stopped).toBe(true);
  expect(Object.keys(stopped.message!.figures ?? {}).sort()).toEqual(withDark(figureKey(first), figureKey(last)).sort());
  return { db, chatId: stopped.chatId, first, last, saved: stopped.message! };
}
const savedFigures = (db: ReturnType<typeof setup>["db"], chatId: string) => {
  const replies = readChat(db, chatId).filter((row) => row.role === "assistant");
  return { count: replies.length, last: replies.at(-1)! };
};

it("keeps the figures of a stopped reply when its continuation is stopped or fails, and when it finishes", async () => {
  const { db, chatId, first, last } = await stoppedWithTwoFigures();
  const kept = figuresWithDark(figureKey(first), figureKey(last));
  // Continua, and the continuation streams a little and is stopped again.
  const stopAgain = new AbortController();
  const stopping: ReturnType<typeof setup>["run"] = async (input) => {
    (input as { onDelta?: (text: string) => void }).onDelta?.("\n\nE un'ultima frase");
    stopAgain.abort();
    throw new DOMException("aborted", "AbortError");
  };
  const again = await regenerateTurn(db, { chatId, resume: true, run: stopping, python, signal: stopAgain.signal });
  expect(again.message!.stopped).toBe(true);
  expect(again.message!.body).toContain("E un'ultima frase");
  expect(again.message!.figures).toEqual(kept);
  expect(again.message!.body).toContain(figure("La prima.", first));
  expect(again.message!.body).toContain(figure("L'ultima.", last));
  expect(again.message!.body).not.toContain("raise ValueError");
  expect(savedFigures(db, chatId).count).toBe(1);
  expect(savedFigures(db, chatId).last.figures).toEqual(kept);
  // Continua again, and the engine fails after some text: the reply is kept with its error and still has the two.
  const failing: ReturnType<typeof setup>["run"] = async (input) => {
    (input as { onDelta?: (text: string) => void }).onDelta?.("\n\nUn'altra frase");
    throw new Error("the engine dropped");
  };
  const failed = await regenerateTurn(db, { chatId, resume: true, run: failing, python });
  expect(failed.message!.stopped).toBe(true);
  expect(failed.message!.body).toContain("Un'altra frase");
  expect(failed.message!.figures).toEqual(kept);
  expect(savedFigures(db, chatId).count).toBe(1);
  // Continua once more, and it finishes: the figures are kept without drawing them again, even with no sandbox to draw in.
  let runs = 0;
  const finishing: ReturnType<typeof setup>["run"] = async () => ({ text: "\n\nFine davvero.", provider: "claude", model: "m", inputTokens: 1 });
  const unavailable: FigureRunner = async () => {
    runs++;
    return { stdout: "", stderr: "runtime-unavailable", images: [], timedOut: false, truncated: false };
  };
  const done = await regenerateTurn(db, { chatId, resume: true, run: finishing, python: unavailable });
  expect(done.message!.stopped).toBe(false);
  expect(done.message!.body).toContain("Fine davvero.");
  expect(done.message!.figures).toEqual(kept);
  expect(runs).toBe(0);
  expect(savedFigures(db, chatId).count).toBe(1);
  // A reload finds the same.
  expect(readChat(db, chatId).at(-1)!.figures).toEqual(kept);
});

it("keeps the earlier reply, figures included, when a regenerated one is stopped", async () => {
  const { db, chatId, first, last } = await stoppedWithTwoFigures();
  const stopAgain = new AbortController();
  const stopping: ReturnType<typeof setup>["run"] = async (input) => {
    (input as { onDelta?: (text: string) => void }).onDelta?.("Un'altra risposta");
    stopAgain.abort();
    throw new DOMException("aborted", "AbortError");
  };
  await expect(regenerateTurn(db, { chatId, run: stopping, python, signal: stopAgain.signal })).rejects.toMatchObject({ name: "AbortError" });
  const kept = savedFigures(db, chatId);
  expect(kept.count).toBe(1);
  expect(kept.last.figures).toEqual(figuresWithDark(figureKey(first), figureKey(last)));
});

it("tells the tutor the right Settings path for drawings when no figure kinds can be drawn", () => {
  const itBlock = contextBlock({
    language: "Italian",
    planLine: "",
    subject: "",
    profile: "",
    followups: true,
    figures: [],
  });
  expect(itBlock).toContain("Impostazioni › Studio › Disegni");
  expect(itBlock).toContain("do not draw with ASCII or text characters");
  const enBlock = contextBlock({
    language: "English",
    planLine: "",
    subject: "",
    profile: "",
    followups: true,
    figures: [],
  });
  expect(enBlock).toContain("Settings › Study › Drawings");
  expect(enBlock).not.toContain("Impostazioni");
});
