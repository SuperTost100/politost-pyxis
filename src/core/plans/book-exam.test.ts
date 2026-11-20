import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import type { GenerateInput } from "../engine/generate";
import { createRunner } from "../jobs/runner";
import { folderTransport } from "../sources/books";
import { sourceHandlers } from "../sources/handlers";
import { markStoppedImport, registerSourceJobs } from "../sources/jobs";
import { parseSmartbook } from "../sources/smartbook";
import { enqueuePlan, planBuildState, registerPlanJobs } from "./jobs";
import { readPlan } from "./create";

const dirs: string[] = [];
// What a test must undo even when an assertion failed: the folders go last, after what still reads from them.
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
const temp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

/** A free PoliTost book with real text, laid out as the catalog site has it. */
function site() {
  const bytes = zipSync({
    "smartbook.json": strToU8(
      JSON.stringify({
        id: "fisica-demo",
        title: "Fisica di prova",
        version: "1.0.0",
        access: "public",
        chapters: [{ id: "moti", number: 1, title: "Moti", file: "01.md" }],
      }),
    ),
    "chapters/01.md": strToU8(
      "## p1 | Velocità\nLa velocità media è lo spazio percorso diviso il tempo.\n\n## p2 | Accelerazione\nL'accelerazione è la variazione di velocità nel tempo.\n",
    ),
  });
  const dir = temp("pyxis-book-exam-site-");
  mkdirSync(join(dir, "books"));
  writeFileSync(join(dir, "books", "fisica-demo@1.0.0.ptsb"), bytes);
  writeFileSync(
    join(dir, "catalog.json"),
    JSON.stringify({
      catalogVersion: 1,
      books: [
        {
          id: "fisica-demo",
          title: "Fisica di prova",
          subject: "Fisica",
          authors: ["PoliTost"],
          version: "1.0.0",
          chapters: 1,
          package: "books/fisica-demo@1.0.0.ptsb",
          bytes: bytes.byteLength,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        },
      ],
    }),
  );
  return folderTransport(dir);
}

const answer = (data: unknown) => ({
  text: JSON.stringify(data),
  structured: data,
  provider: "claude" as const,
  model: "fixture",
  inputTokens: 10,
});

describe("an exam created with the offered PoliTost book", () => {
  it("waits for the book to be read, then builds from its chapters", async () => {
    const workspace = temp("pyxis-book-exam-");
    const db = openDatabase(":memory:");
    db.prepare("INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES ('default', ?, 1)").run(
      JSON.stringify({ provider: "claude", model: "claude-sonnet-5" }),
    );
    const runner = createRunner(db, (job) => markStoppedImport(db, job));
    // The read of the book is held until the test lets it go: a slow disk, or a long book.
    let startRead!: () => void;
    const reading = new Promise<void>((resolve) => (startRead = resolve));
    let readEntered!: () => void;
    const entered = new Promise<void>((resolve) => (readEntered = resolve));
    // A failed assertion must not leave the book held, or the database open under the build that polls it.
    cleanups.push(() => {
      startRead();
      db.close();
    });
    // The source handlers register the app's own reader, so the held one goes in after them.
    const handlers = sourceHandlers(db, workspace, runner, undefined, undefined, site());
    registerSourceJobs(db, workspace, runner, (async (input: { path: string }) => {
      readEntered();
      await reading;
      return { book: parseSmartbook(new Uint8Array(readFileSync(input.path))) };
    }) as never);
    const run: GenerateInput["run"] = async (input) => {
      if (input.system?.startsWith("Write")) return answer({ markdown: "Il moto [P1]." });
      const content = JSON.parse(input.prompt) as { passages: Array<{ id: string }> };
      return answer({
        questions: Array.from({ length: 10 }, (_, i) => ({
          stem: `Domanda ${i}`,
          options: ["a", "b", "c", "d"],
          correct: 0,
          topicIndex: 0,
          passageIds: [content.passages[0]!.id],
          explanation: "Spiegazione",
        })),
      });
    };
    registerPlanJobs(db, runner, run);

    // "Crea l'esame" downloads the book and creates the exam at once, as the page does, before the book is read.
    const added = await handlers.importBook({ id: "fisica-demo" });
    await entered;
    const status = () => (db.prepare("SELECT status FROM sources WHERE id = ?").get(added.sourceId) as { status: string }).status;
    expect(status()).not.toBe("ready");
    const built = enqueuePlan(db, runner, { title: "Fisica", sourceIds: [added.sourceId] });

    // The build waits on its first step with nothing wrong, and the exam has no topics yet.
    for (let i = 0; i < 200 && planBuildState(db, built.planId)?.steps[0]?.state !== "running"; i += 1)
      await new Promise((resolve) => setTimeout(resolve, 5));
    expect(planBuildState(db, built.planId)).toMatchObject({
      state: "running",
      error: null,
      steps: [{ name: "sources", state: "running" }, ...Array(4).fill(expect.anything())],
    });
    expect(status()).not.toBe("ready");
    expect(readPlan(db, built.planId)!.topics).toEqual([]);

    // Once the book is read, the exam is built from it.
    startRead();
    for (let i = 0; i < 400 && planBuildState(db, built.planId)?.state !== "succeeded"; i += 1) {
      if (planBuildState(db, built.planId)?.state === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(planBuildState(db, built.planId)).toMatchObject({ state: "succeeded", error: null });
    expect(status()).toBe("ready");
    const plan = readPlan(db, built.planId)!;
    expect(plan.topics.map((topic) => topic.title)).toEqual(["Moti"]);
    expect(plan.topics[0]!.subtopics).toEqual(["Velocità", "Accelerazione"]);
  });
});
