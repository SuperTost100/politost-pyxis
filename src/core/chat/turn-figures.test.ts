import { afterEach, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import type { EngineResult } from "../engine/funnel";
import type { FigureRunner } from "../math/figures";
import { figureKey } from "../../shared/smart-text";
import { isFigureFixCall } from "../engine/recorded-plan";
import { setUsageRecorder, storeUsage } from "../engine/usage";
import { askTurn, readChat } from "./turn";
import { visibleText } from "./visible";

const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
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
function setup(fixes: Array<string | Error> = []) {
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
  expect(calls[0]!.system).toContain("pyxis-figure");
  const message = result.message!;
  expect(message.figures).toEqual({ [figureKey(sine)]: PNG });
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

it("offers no figures without a sandbox or in a Socratic turn, and keeps none in a stopped reply", async () => {
  const { db, calls, run } = setup();
  const plain = await askTurn(db, {
    text: "Il seno?",
    allowGeneral: true,
    run,
    python: null,
  });
  expect(calls[0]!.system).not.toContain("pyxis-figure");
  expect(plain.message!.body).not.toContain("pyxis-figure");
  expect(plain.message!.figures).toBeUndefined();
  expect(readChat(db, plain.chatId).at(-1)!.figures).toBeUndefined();

  await askTurn(db, { text: "Il seno?", way: "guided", run, python });
  expect(calls.at(-1)!.system).not.toContain("pyxis-figure");

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
  expect(message.figures).toEqual({ [figureKey(sine)]: PNG, [figureKey(mended)]: PNG });
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
    expect(message.figures).toEqual({ [figureKey(sine)]: PNG });
    expect(message.body).not.toContain("raise ValueError");
    expect(message.body).not.toContain("Un circuito che non si disegna.");
    expect(message.body).toContain("Il periodo è $2\\pi$.");
    expect(message.body).toContain(figure("Il grafico di $\\sin x$.", sine));
  }
});

it("asks for no fix in a turn that offers no figures", async () => {
  const { db, fixCalls, run } = setup(["plt.plot([1])"]);
  await askTurn(db, { text: "Il seno?", allowGeneral: true, run, python: null });
  await askTurn(db, { text: "Il seno?", way: "guided", run, python });
  expect(fixCalls).toEqual([]);
});
