import { afterEach, beforeEach, expect, it, vi } from "vitest";

// Main's side of the runtime, as core sees it: the packs that are downloaded, the Python sandbox, and the drawing window,
// which answers a graph the way main does (a picture, or the short error of the check or of Graphviz). Only the process
// boundary is faked: the routing by kind, the checks, the fix call and the chat turn are the real ones.
const main = vi.hoisted(() => ({
  requests: [] as Array<{ operation: string; payload: Record<string, unknown> }>,
  /** What the drawing window answers for a DOT text: a picture, or the error it would give. */
  window: (_code: string): { image: string } | { error: string; timedOut?: boolean } => ({ error: "runtime-draw-failed" }),
  /** What the Python sandbox answers for a program. */
  python: (_code: string): Record<string, unknown> => ({}),
}));
vi.mock("../math/runtime-client", () => ({
  runtimeRequest: async (operation: string, payload: Record<string, unknown>) => {
    main.requests.push({ operation, payload });
    if (operation === "status") return { packs: { pyodide: "ready", drawing: "ready" } };
    if (operation === "draw") return main.window(String(payload.code));
    return main.python(String(payload.code));
  },
}));

import { openDatabase } from "../db/connection";
import type { EngineResult } from "../engine/funnel";
import { isFigureFixCall } from "../engine/recorded-plan";
import { darkFigureKey, figureKey } from "../../shared/smart-text";
import { darkFigure } from "../math/dark-figure";
import { setUsageRecorder } from "../engine/usage";
import { askTurn, readChat } from "./turn";

const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const block = (caption: string, code: string, kind = "graph") =>
  ["```pyxis-figure", JSON.stringify({ kind, caption, code }), "```"].join("\n");

const good = "digraph { q0 -> q1 [label=a]; q1 -> q0 [label=b] }";
// The checks pass this text and Graphviz cannot read it: the window answers with the short error of its own, line and token.
const broken = "digraph {\n  q0 -> q1\n  q1 -> boom\n}";
const brokenError = 'syntax error in line 3, near "boom"';
/** The drawing window: a text with `boom` fails as Graphviz would, the rest draws. */
/** What a turn stores for figures drawn with these keys: each picture and its dark one. */
const figuresWithDark = (...keys: string[]) =>
  Object.fromEntries(keys.flatMap((key) => [[key, PNG], [darkFigureKey(key), darkFigure(PNG)!]]));
const withDark = (...keys: string[]) => keys.flatMap((key) => [key, darkFigureKey(key)]);
const window = (code: string) => (code.includes("boom") ? { error: brokenError } : { image: PNG });

const intro = "Un automa a due stati.";
const outro = "Gli stati si alternano.";
const answerWith = (...blocks: string[]) => [intro, "", ...blocks, "", outro].join("\n");

/** A recorded engine: the tutor answers `reply`, and each call that corrects a figure answers the next of `fixes`. */
function setup(reply: string, fixes: Array<string | Error> = [], stop?: AbortController) {
  const db = openDatabase(":memory:");
  db.prepare("INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES ('default', ?, 1)").run(
    JSON.stringify({ provider: "claude", model: "claude-sonnet-5" }),
  );
  const fixCalls: Array<{ system: string; request: Record<string, string>; model: string }> = [];
  const run = async (input: { system?: string; prompt: string; selection?: { model: string } }): Promise<EngineResult> => {
    if (isFigureFixCall(input.system)) {
      // The student presses Stop while the figure is corrected: the call ends the way a stopped call does.
      if (stop) {
        stop.abort();
        throw new DOMException("aborted", "AbortError");
      }
      fixCalls.push({
        system: input.system ?? "",
        request: JSON.parse(input.prompt) as Record<string, string>,
        model: input.selection?.model ?? "",
      });
      const next = fixes[fixCalls.length - 1] ?? (JSON.parse(input.prompt) as { code: string }).code;
      if (next instanceof Error) throw next;
      return { text: JSON.stringify({ code: next }), structured: { code: next }, provider: "claude", model: "fixer", inputTokens: 5 };
    }
    if (input.system?.startsWith("Extract mathematical claims"))
      return { text: '{"checks": []}', structured: { checks: [] }, provider: "claude", model: "m", inputTokens: 1 };
    return { text: reply, provider: "claude", model: "m", inputTokens: 1 };
  };
  return { db, fixCalls, run };
}
const drawn = () => main.requests.filter((request) => request.operation === "draw").map((request) => request.payload);
const ask = (db: ReturnType<typeof openDatabase>, run: ReturnType<typeof setup>["run"], signal?: AbortSignal) =>
  askTurn(db, { text: "Com'è fatto un automa?", allowGeneral: true, run, signal });

const draws = { stdout: "", stderr: "", images: [PNG], timedOut: false, truncated: false };
beforeEach(() => {
  main.requests.length = 0;
  main.window = window;
  main.python = () => draws;
});
afterEach(() => setUsageRecorder(undefined));

it("corrects a graph the drawing window could not read with one fix call, and shows the corrected graph", async () => {
  const { db, fixCalls, run } = setup(answerWith(block("Un automa.", broken)), [good]);
  const result = await ask(db, run);
  // One call, on the turn's engine, holding the block and the window's short error: no Graphviz text, no answer around it.
  expect(fixCalls).toHaveLength(1);
  expect(fixCalls[0]!.model).toBe("claude-sonnet-5");
  expect(fixCalls[0]!.request).toEqual({ kind: "graph", caption: "Un automa.", code: broken, error: brokenError });
  expect(fixCalls[0]!.system).toContain("Graphviz DOT");
  expect(JSON.stringify(fixCalls[0]!.request)).not.toContain(intro);
  // The window drew the text as written, and then the corrected text: never a Python program, and no Python at all.
  expect(drawn()).toEqual([
    { kind: "graph", code: broken, timeoutMs: 5000 },
    { kind: "graph", code: good, timeoutMs: 5000 },
  ]);
  expect(main.requests.some((request) => request.operation === "python")).toBe(false);
  // Shown: the image is stored under the corrected code, and the saved block carries that code.
  const message = result.message!;
  expect(message.figures).toEqual(figuresWithDark(figureKey(good, "graph")));
  expect(message.body).toContain(block("Un automa.", good));
  expect(message.body).not.toContain("boom");
  expect(message.body).toContain(intro);
  expect(readChat(db, result.chatId).at(-1)!.figures).toEqual(message.figures);
});

it("hands the model the check's message for a graph the check refuses, and draws nothing for it", async () => {
  const refused = "digraph { layout=NEATO; a -> b }";
  const { db, fixCalls, run } = setup(answerWith(block("Un grafo.", refused)), [good]);
  const result = await ask(db, run);
  expect(fixCalls).toHaveLength(1);
  expect(fixCalls[0]!.request.error).toBe(
    "layout=NEATO is not allowed: use one of dot, neato, circo, fdp, twopi, in lower case with no spaces",
  );
  // The refused text never reached the window; the corrected one did.
  expect(drawn()).toEqual([{ kind: "graph", code: good, timeoutMs: 5000 }]);
  expect(result.message!.figures).toEqual(figuresWithDark(figureKey(good, "graph")));
});

it("drops the graph and keeps the answer whole when the fix call fails or its answer fails too", async () => {
  for (const fixes of [[new Error("the engine is out")], ["digraph {\n  a -> boom\n}"]]) {
    main.requests.length = 0;
    const { db, fixCalls, run } = setup(answerWith(block("Un automa.", broken)), fixes);
    const result = await ask(db, run);
    // One call and at most one more drawing: the retry is the same for a graph as for a plot.
    expect(fixCalls).toHaveLength(1);
    expect(drawn().length).toBe(fixes[0] instanceof Error ? 1 : 2);
    const message = result.message!;
    expect(message.figures).toBeUndefined();
    expect(message.body).not.toContain("pyxis-figure");
    expect(message.body).toContain(intro);
    expect(message.body).toContain(outro);
    expect(message.stopped).toBeFalsy();
  }
});

it("asks for no more than four fixes in an answer, and none for a graph the window could not be asked about", async () => {
  const many = Array.from({ length: 6 }, (_, i) => block(`Grafo ${i}.`, `digraph {\n  a${i} -> boom\n}`));
  const { db, fixCalls, run } = setup(answerWith(...many));
  const result = await ask(db, run);
  expect(fixCalls).toHaveLength(4);
  expect(result.message!.figures).toBeUndefined();
  expect(result.message!.body).toContain(outro);
  // The window is gone (no window, a crash): no new text could help, so no call is made.
  main.requests.length = 0;
  main.window = () => ({ error: "runtime-draw-crashed" });
  const crashed = setup(answerWith(block("Un automa.", good)));
  const again = await ask(crashed.db, crashed.run);
  expect(crashed.fixCalls).toEqual([]);
  expect(again.message!.figures).toBeUndefined();
});

it("hands the corrected text to the window as the model wrote it: the backslash and the n of a DOT label stay", async () => {
  const labelled = 'digraph { a [label="Primo\\nSecondo"]; a -> b }';
  const { db, run } = setup(answerWith(block("Un nodo con due righe.", broken)), [labelled]);
  const result = await ask(db, run);
  expect(drawn().at(-1)).toEqual({ kind: "graph", code: labelled, timeoutMs: 5000 });
  expect(result.message!.figures).toEqual(figuresWithDark(figureKey(labelled, "graph")));
});

it("keeps the whole answer, with the graph left out, when Stop is pressed while the graph is corrected, and keeps the chat", async () => {
  const stop = new AbortController();
  const { db, run } = setup(answerWith(block("Un automa.", broken)), [], stop);
  const result = await ask(db, run, stop.signal);
  const message = result.message!;
  expect(message.stopped).toBe(true);
  expect(message.body).toContain(intro);
  expect(message.body).toContain(outro);
  expect(message.body).not.toContain("pyxis-figure");
  expect(message.figures).toBeUndefined();
  // No second drawing was asked of the window, and the chat is still there with the saved reply.
  expect(drawn()).toEqual([{ kind: "graph", code: broken, timeoutMs: 5000 }]);
  expect(readChat(db, result.chatId).at(-1)!.body).toBe(message.body);
  expect(db.prepare("SELECT COUNT(*) FROM chats WHERE id = ?").pluck().get(result.chatId)).toBe(1);
});

it("treats a graph and a plot in one answer alike: each is corrected once, a graph by the window and a plot by Python", async () => {
  const plot = "raise ValueError('no')";
  const plotted = "plt.plot([1, 2])";
  // The Python sandbox fails the plot's first program, as Python would, and draws the rest.
  main.python = (code) =>
    code.includes("raise ValueError")
      ? { stdout: "", stderr: "ValueError: no\n", images: [], timedOut: false, truncated: false }
      : draws;
  const { db, fixCalls, run } = setup(answerWith(block("Un automa.", broken), block("Una retta.", plot, "plot")), [good, plotted]);
  const result = await ask(db, run);
  expect(fixCalls.map((call) => call.request.kind)).toEqual(["graph", "plot"]);
  expect(fixCalls[1]!.request.error).toContain("ValueError: no");
  expect(Object.keys(result.message!.figures ?? {})).toEqual(withDark(figureKey(good, "graph"), figureKey(plotted)));
  expect(main.requests.filter((request) => request.operation === "python")).toHaveLength(2);
  expect(drawn()).toHaveLength(2);
});
