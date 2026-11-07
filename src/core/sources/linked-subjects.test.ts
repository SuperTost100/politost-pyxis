import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import type { GenerateInput } from "../engine/generate";
import { detectSubjects, guessKinds } from "./linked-subjects";

type Run = NonNullable<GenerateInput["run"]>;

function db(withEngine = true) {
  const database = openDatabase(":memory:");
  if (withEngine)
    database
      .prepare("INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES ('default', ?, 1)")
      .run(JSON.stringify({ provider: "claude", model: "claude-sonnet-5" }));
  return database;
}

const answer = (folders: unknown[]): Run => async () => ({
  text: "",
  provider: "claude",
  model: "claude-sonnet-5",
  inputTokens: 1,
  structured: { folders },
});

const candidates = [
  { folder: "Fisica 1", files: ["Mazzoldi.pdf", "Lezione 4.pptx", "Temi d'esame/2025-02.pdf"] },
  { folder: "GAL", files: ["dispense.pdf", "appunti.md"] },
  { folder: "Erasmus", files: ["learning agreement.pdf"] },
];

describe("subject detection", () => {
  it("sends folder and file names only, and takes the tidied names, skips and kinds from the answer", async () => {
    let sent: Parameters<Run>[0] | undefined;
    const run: Run = async (input) => {
      sent = input;
      return answer([
        { folder: "Fisica 1", subject: "Fisica I", study: true, kinds: ["book", "slides", "exams"] },
        { folder: "GAL", subject: "Geometria e algebra lineare", study: true, kinds: ["handouts", "notes"] },
        { folder: "Erasmus", subject: "Erasmus", study: false, kinds: [] },
      ])(input);
    };
    const detection = await detectSubjects(db(), candidates, { mode: "root", run });
    expect(detection).toEqual({
      by: "ai",
      subjects: [
        { folder: "Fisica 1", name: "Fisica I", study: true, kinds: ["book", "slides", "exams"] },
        { folder: "GAL", name: "Geometria e algebra lineare", study: true, kinds: ["handouts", "notes"] },
        { folder: "Erasmus", name: "Erasmus", study: false, kinds: [] },
      ],
    });
    const prompt = JSON.parse(sent!.prompt) as { folders: Array<{ folder: string; files: string[] }> };
    expect(prompt.folders).toEqual(candidates);
    expect(sent!.system).toContain("You never see what the files contain");
  });

  it("never skips a folder the student picked as a subject", async () => {
    const detection = await detectSubjects(db(), [candidates[2]!], {
      mode: "subject",
      run: answer([{ folder: "Erasmus", subject: "Erasmus", study: false, kinds: [] }]),
    });
    expect(detection.subjects[0]).toMatchObject({ study: true });
  });

  it("keeps the folder name for a folder the answer leaves out or names badly", async () => {
    const detection = await detectSubjects(db(), candidates.slice(0, 2), {
      mode: "root",
      run: answer([{ folder: "GAL", subject: "   ", study: true, kinds: ["notes", "notes"] }]),
    });
    expect(detection.subjects).toEqual([
      { folder: "Fisica 1", name: "Fisica 1", study: true, kinds: ["slides", "exams"] },
      { folder: "GAL", name: "GAL", study: true, kinds: ["notes"] },
    ]);
  });

  it("uses the folder names as they are and skips nothing without an engine", async () => {
    let called = false;
    const detection = await detectSubjects(db(false), candidates, {
      mode: "root",
      run: async () => {
        called = true;
        throw new Error("unreachable");
      },
    });
    expect(called).toBe(false);
    expect(detection.by).toBe("names");
    expect(detection.subjects.map((subject) => [subject.name, subject.study])).toEqual([
      ["Fisica 1", true],
      ["GAL", true],
      ["Erasmus", true],
    ]);
  });

  it("falls back to the folder names when the call fails or takes too long", async () => {
    const failed = await detectSubjects(db(), candidates, {
      mode: "root",
      run: async () => {
        throw new Error("network");
      },
    });
    expect(failed.by).toBe("names");
    const slow = await detectSubjects(db(), candidates, {
      mode: "root",
      timeoutMs: 20,
      run: (input) =>
        new Promise((_, reject) => input.signal?.addEventListener("abort", () => reject(input.signal!.reason))),
    });
    expect(slow.by).toBe("names");
    expect(slow.subjects.every((subject) => subject.study)).toBe(true);
  });

  it("passes on the caller's own cancel instead of falling back", async () => {
    const controller = new AbortController();
    const pending = detectSubjects(db(), candidates, {
      mode: "root",
      signal: controller.signal,
      run: (input) =>
        new Promise((_, reject) => input.signal?.addEventListener("abort", () => reject(input.signal!.reason))),
    });
    controller.abort();
    await expect(pending).rejects.toBeDefined();
  });

  it("guesses kinds from file names and types, most frequent first", () => {
    expect(guessKinds(["Lezione 1.pptx", "Lezione 2.pptx", "Appello giugno.pdf", "riassunto.md"])).toEqual([
      "slides",
      "exams",
      "notes",
    ]);
    expect(guessKinds(["IMG_2041.jpg"])).toEqual([]);
  });
});
