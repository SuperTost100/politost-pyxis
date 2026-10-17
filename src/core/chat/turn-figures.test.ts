import { expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import type { EngineResult } from "../engine/funnel";
import type { FigureRunner } from "../math/figures";
import { figureKey } from "../../shared/smart-text";
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

function setup() {
  const db = openDatabase(":memory:");
  db.prepare(
    "INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES ('default', ?, 1)",
  ).run(JSON.stringify({ provider: "claude", model: "claude-sonnet-5" }));
  const calls: Array<{ system: string; prompt: string }> = [];
  const run = async (input: {
    system?: string;
    prompt: string;
  }): Promise<EngineResult> => {
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
  return { db, calls, run };
}

it("draws an answer's figures, leaves out the one that fails, and stores the images with the message", async () => {
  const { db, calls, run } = setup();
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

  await askTurn(db, { text: "Il seno?", mode: "socratic", run, python });
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
