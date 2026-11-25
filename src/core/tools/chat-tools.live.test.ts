import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { askTurn } from "../chat/turn";
import { endConversations, runTurn, setScratch } from "../engine/funnel";
import { importSmartbook } from "../sources/smartbook";
import { tempDir } from "../test-temp";
import { chatToolList } from "./registry";
import { setTools, stopToolServer } from "./server";

/**
 * The chat's flashcard tool on a signed-in CLI, with fixture material. It spends subscription usage, so it runs only
 * with PYXIS_LIVE_CHAT_TOOLS=1:
 *
 *   PYXIS_LIVE_CHAT_TOOLS=1 PYXIS_LIVE_ENGINE=claude/claude-sonnet-5-5/medium PYXIS_LIVE_OUT=.tmp/chat-tools \
 *   npm test -- src/core/tools/chat-tools.live.test.ts
 *
 * PYXIS_LIVE_SCENARIOS picks scenarios by name (comma-separated); PYXIS_LIVE_RUNS repeats the first two. Each turn's
 * reply, the cards it created and the time it took go to PYXIS_LIVE_OUT as JSON, for reading.
 */
const live = process.env["PYXIS_LIVE_CHAT_TOOLS"] === "1";

const CHAPTER = `## p1 | Il primo principio della dinamica
Un corpo non soggetto a forze, o soggetto a forze con risultante nulla, mantiene il suo stato di quiete o di moto rettilineo uniforme. Questo principio, detto anche principio d'inerzia, vale nei sistemi di riferimento inerziali.

## p2 | Il secondo principio della dinamica
L'accelerazione di un corpo è proporzionale alla forza risultante che agisce su di esso e inversamente proporzionale alla sua massa: $\\vec F = m\\vec a$. Nel Sistema Internazionale la forza si misura in newton, con $1\\,\\mathrm{N} = 1\\,\\mathrm{kg\\,m/s^2}$.

## p3 | Il terzo principio della dinamica
Se un corpo A esercita una forza su un corpo B, allora B esercita su A una forza uguale in modulo e direzione e opposta in verso: $\\vec F_{AB} = -\\vec F_{BA}$. Le due forze agiscono su corpi diversi e quindi non si annullano.

## p4 | Massa e peso
La massa misura l'inerzia di un corpo e si misura in chilogrammi. Il peso è la forza con cui la Terra attrae il corpo, $\\vec P = m\\vec g$, con $g \\approx 9{,}81\\,\\mathrm{m/s^2}$, e si misura in newton.
`;

function setup(provider: string, model: string, effort?: string) {
  const db = openDatabase(":memory:");
  db.prepare("INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES ('default', ?, 1), ('chat', ?, 1)").run(
    JSON.stringify({ provider, model, ...(effort ? { effort } : {}) }),
    JSON.stringify({ provider, model, ...(effort ? { effort } : {}) }),
  );
  const book = zipSync({
    "smartbook.json": strToU8(
      JSON.stringify({ id: "dinamica", title: "Dinamica", access: "public", chapters: [{ id: "c1", number: 1, title: "Dinamica", file: "01.md" }] }),
    ),
    "chapters/01.md": strToU8(CHAPTER),
  });
  const { sourceId } = importSmartbook(db, book);
  db.prepare("INSERT INTO subjects (id, name, created_at) VALUES ('phys', 'Fisica 1', 1)").run();
  db.prepare("UPDATE sources SET subject_id = 'phys' WHERE id = ?").run(sourceId);
  setTools(chatToolList(db, false));
  return db;
}

type Turn = { question: string; body: string; ms: number; provider: string | null; model: string | null; cards: Array<{ front: string; back: string }> };

describe.skipIf(!live)("chat tools, live", () => {
  it("creates flashcards when asked, and only then", { timeout: 120 * 60_000 }, async () => {
    const out = process.env["PYXIS_LIVE_OUT"] ?? ".tmp/chat-tools";
    mkdirSync(out, { recursive: true });
    setScratch(tempDir("pyxis-live-scratch-"));
    const [provider, model, effort] = (process.env["PYXIS_LIVE_ENGINE"] ?? "claude/claude-sonnet-5-5/medium").split("/") as [string, string, string?];
    const runs = Number(process.env["PYXIS_LIVE_RUNS"] ?? 3);
    const wanted = process.env["PYXIS_LIVE_SCENARIOS"]?.split(",");

    const db = setup(provider, model, effort);
    let seen = 0;
    const newCards = () => {
      const rows = db.prepare("SELECT front, back FROM cards WHERE removed = 0 ORDER BY rowid").all() as Turn["cards"];
      const fresh = rows.slice(seen);
      seen = rows.length;
      return fresh;
    };
    const ask = async (chatId: string | undefined, question: string, options: { noTools?: boolean } = {}) => {
      const started = Date.now();
      const result = await askTurn(db, {
        chatId,
        text: question,
        subject: chatId ? undefined : "Fisica 1",
        // A turn of a session that started without tools, as one opened before this version or on a tool without them.
        ...(options.noTools ? { run: (input) => runTurn({ ...input, tools: undefined }) } : {}),
      });
      const turn: Turn = {
        question,
        body: result.message?.body ?? "",
        ms: Date.now() - started,
        provider: result.message?.provider ?? null,
        model: result.message?.modelId ?? null,
        cards: newCards(),
      };
      return { chatId: result.chatId, turn };
    };

    const scenarios: Record<string, () => Promise<Turn[]>> = {
      asked: async () => [(await ask(undefined, "Fammi 8 flashcard sui tre principi della dinamica.")).turn],
      question: async () => [(await ask(undefined, "Che differenza c'è tra massa e peso?")).turn],
      offer: async () => {
        const first = await ask(undefined, "Spiegami il terzo principio della dinamica. Alla fine chiedimi se voglio delle flashcard su questo.");
        const second = await ask(first.chatId, "Sì, grazie.");
        return [first.turn, second.turn];
      },
      restart: async () => {
        const first = await ask(undefined, "Spiegami il secondo principio della dinamica. Alla fine chiedimi se voglio delle flashcard su questo.");
        // An app restart: the live CLI process ends and the server comes back on another port with another token.
        endConversations();
        await stopToolServer();
        const second = await ask(first.chatId, "Sì, fammele.");
        return [first.turn, second.turn];
      },
      "no-tools-first": async () => {
        const first = await ask(undefined, "Spiegami il primo principio della dinamica.", { noTools: true });
        const second = await ask(first.chatId, "Fammi 5 flashcard su questo.");
        return [first.turn, second.turn];
      },
      hundred: async () => [(await ask(undefined, "Fammi 100 flashcard sulla dinamica.")).turn],
    };
    const repeat = new Set(["asked", "question"]);
    const report: Array<{ scenario: string; run: number; turns: Turn[] }> = [];
    for (const [name, scenario] of Object.entries(scenarios)) {
      if (wanted && !wanted.includes(name)) continue;
      for (let run = 1; run <= (repeat.has(name) ? runs : 1); run += 1) {
        let turns: Turn[];
        try {
          turns = await scenario();
        } catch (err) {
          turns = [{ question: "(failed)", body: err instanceof Error ? `${err.name}: ${err.message}` : String(err), ms: 0, provider: null, model: null, cards: newCards() }];
        }
        report.push({ scenario: name, run, turns });
        writeFileSync(join(out, `${provider}-${model}.json`), JSON.stringify(report, null, 2));
      }
    }
    endConversations();
    await stopToolServer();
    expect(report.length).toBeGreaterThan(0);
  });
});
