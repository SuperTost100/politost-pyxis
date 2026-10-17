import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { createRunner } from "../jobs/runner";
import type { GenerateInput } from "../engine/generate";
import { loadTemplate } from "../engine/prompts";
import { readPlan } from "../plans/create";
import { exportPlan } from "../plans/file";
import { startRebuild } from "../plans/jobs";
import { removeSource } from "../sources/manage";
import {
  addPastPaper,
  pastPaperViews,
  pastStyle,
  registerPastPaperJobs,
  removePastPaper,
  spaceOptions,
  startPastPractice,
  styleSlots,
  type PastStyle,
} from "./pastPapers";
import { flagTarget } from "./flags";
import { readQuiz } from "./quizJobs";
import {
  enqueueSimulation,
  readSimulationBuild,
  registerSimulationJobs,
  startSimulation,
  openSimulation,
} from "./simulation";

const engine = (db: ReturnType<typeof openDatabase>) =>
  db
    .prepare(
      "INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES ('default', ?, 1)",
    )
    .run(JSON.stringify({ provider: "claude", model: "claude-sonnet-5" }));

function fixture() {
  const db = openDatabase(":memory:");
  engine(db);
  db.prepare(
    "INSERT INTO plans (id, title, status, created_at, updated_at) VALUES ('plan', 'Analisi 1', 'ready', 1, 1)",
  ).run();
  db.prepare(
    "INSERT INTO topics (id, plan_id, title, position, created_at) VALUES ('t0', 'plan', 'Limiti', 0, 1)",
  ).run();
  db.prepare(
    "INSERT INTO topics (id, plan_id, title, position, created_at) VALUES ('t1', 'plan', 'Derivate', 1, 1)",
  ).run();
  for (const t of [0, 1]) {
    db.prepare(
      "INSERT INTO sources (id, kind, title, status, created_at, updated_at) VALUES (?, 'pdf', ?, 'ready', 1, 1)",
    ).run(`notes${t}`, `Dispense ${t}`);
    db.prepare("INSERT INTO plan_sources (plan_id, source_id) VALUES ('plan', ?)").run(`notes${t}`);
    for (const p of [0, 1]) {
      db.prepare(
        "INSERT INTO passages (id, source_id, text, created_at) VALUES (?, ?, ?, 1)",
      ).run(`p${t}${p}`, `notes${t}`, `Testo ${t}${p}`);
      db.prepare("INSERT INTO topic_passages (topic_id, passage_id) VALUES (?, ?)").run(`t${t}`, `p${t}${p}`);
    }
  }
  return db;
}

/** A source holding the text of one exam, or of one page of it. */
function addSource(
  db: ReturnType<typeof openDatabase>,
  id: string,
  text: string,
  status = "ready",
  created = 2,
) {
  db.prepare(
    "INSERT INTO sources (id, kind, title, status, created_at, updated_at) VALUES (?, 'pdf', ?, ?, ?, ?)",
  ).run(id, `Appello ${id}`, status, created, created);
  if (text)
    db.prepare("INSERT INTO passages (id, source_id, text, created_at) VALUES (?, ?, ?, 1)").run(
      `${id}-p`,
      id,
      text,
    );
}

type Reply = {
  title: string;
  minutes: number | null;
  totalPoints: number | null;
  questions: Array<{
    text: string;
    type: "open" | "choice" | "numeric" | "proof";
    points: number | null;
    minutes: number | null;
    difficulty: "easy" | "medium" | "hard";
    reference: string;
  }>;
};

const question = (
  type: Reply["questions"][number]["type"],
  difficulty: Reply["questions"][number]["difficulty"] = "medium",
  text = `Domanda ${type}`,
): Reply["questions"][number] => ({
  text,
  type,
  points: 6,
  minutes: null,
  difficulty,
  reference: `Risposta ${type}`,
});

/** The recorded reply of the reading call. Each call sees the prompts it was given. */
const prompts: Array<{ system: string; prompt: string }> = [];
function reader(reply: Reply): NonNullable<GenerateInput["run"]> {
  return async (input) => {
    prompts.push({ system: input.system ?? "", prompt: input.prompt });
    return {
      text: JSON.stringify(reply),
      structured: reply,
      provider: "claude",
      model: "reader-model",
      inputTokens: 1,
    };
  };
}

async function settled(db: ReturnType<typeof openDatabase>, jobId: string) {
  for (let i = 0; i < 400; i++) {
    const job = db.prepare("SELECT state, error FROM jobs WHERE id = ?").get(jobId) as {
      state: string;
      error: string | null;
    };
    if (["succeeded", "failed", "cancelled"].includes(job.state)) return job;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("job did not settle");
}

const exam: Reply = {
  title: "Analisi 1, appello di giugno",
  minutes: 120,
  totalPoints: 30,
  questions: [
    question("open", "easy"),
    question("choice", "easy", "Quanto vale il limite?\nA) 0\nB) 1\nC) 2\nD) 3"),
    question("numeric", "medium"),
    question("numeric", "hard"),
    question("proof", "hard"),
    question("open", "medium"),
  ],
};

describe("past papers", () => {
  it("reads one paper into questions, types, points and a duration, and keeps it apart from the study material", async () => {
    const db = fixture();
    addSource(db, "ap1", "Esercizio 1. Calcola il limite. Esercizio 2. Dimostra il teorema.");
    const runner = createRunner(db, () => {});
    registerPastPaperJobs(db, runner, reader(exam));
    const { jobId, sourceId } = addPastPaper(db, runner, "plan", ["ap1"]);
    expect(sourceId).toBe("ap1");
    expect(pastPaperViews(db, "plan")).toMatchObject([{ status: "reading", questions: 0 }]);
    expect((await settled(db, jobId)).state).toBe("succeeded");

    const [paper] = pastPaperViews(db, "plan");
    expect(paper).toMatchObject({
      sourceId: "ap1",
      title: "Analisi 1, appello di giugno",
      files: 1,
      status: "ready",
      questions: 6,
      minutes: 120,
      points: 30,
      types: { open: 2, choice: 1, numeric: 2, proof: 1 },
      provider: "claude",
      model: "reader-model",
    });
    // The model got the paper text and the plan's language, and its reading is recorded with the prompt version.
    expect(prompts.at(-1)!.system).toContain("Write all output in Italian");
    expect(prompts.at(-1)!.prompt).toContain("Esercizio 1. Calcola il limite.");
    const stored = JSON.parse(
      (db.prepare("SELECT paper_json FROM plan_sources WHERE source_id = 'ap1'").get() as { paper_json: string }).paper_json,
    );
    expect(stored.read).toMatchObject({ template: "paper.read", version: loadTemplate("paper.read").version });
    expect(new Set(stored.questions.map((q: { id: string }) => q.id)).size).toBe(6);

    // The paper is a past paper, not a source of the plan.
    expect(readPlan(db, "plan")!.sources.map((s) => s.id).sort()).toEqual(["notes0", "notes1"]);
    expect((exportPlan(db, "plan", { embed: false }).sources ?? []).map((s) => s.id)).not.toContain("ap1");
    db.close();
  });

  it("reads several files as one paper, in order, and removes them together", async () => {
    const db = fixture();
    addSource(db, "pg1", "Pagina uno: esercizio 1.");
    addSource(db, "pg2", "Pagina due: esercizio 2.");
    const runner = createRunner(db, () => {});
    registerPastPaperJobs(db, runner, reader(exam));
    const { jobId } = addPastPaper(db, runner, "plan", ["pg1", "pg2"]);
    await settled(db, jobId);
    expect(pastPaperViews(db, "plan")).toMatchObject([{ sourceId: "pg1", files: 2, status: "ready" }]);
    const prompt = prompts.at(-1)!.prompt;
    expect(prompt.indexOf("Pagina uno")).toBeLessThan(prompt.indexOf("Pagina due"));
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM plan_sources WHERE plan_id = 'plan' AND role = 'past_paper'").get(),
    ).toEqual({ n: 2 });
    removePastPaper(db, runner, "plan", "pg1");
    expect(pastPaperViews(db, "plan")).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM plan_sources WHERE plan_id = 'plan'").get()).toEqual({ n: 2 });
    db.close();
  });

  it("fails with a clear code when the file holds no exam, and can be read again", async () => {
    const db = fixture();
    addSource(db, "menu", "Menu del giorno");
    const runner = createRunner(db, () => {});
    let reply: Reply = { title: "", minutes: null, totalPoints: null, questions: [] };
    registerPastPaperJobs(db, runner, async (input) => reader(reply)(input));
    const { jobId } = addPastPaper(db, runner, "plan", ["menu"]);
    expect(await settled(db, jobId)).toEqual({ state: "failed", error: "paper-empty" });
    expect(pastPaperViews(db, "plan")).toMatchObject([{ status: "failed", error: "paper-empty", jobId }]);
    expect(pastStyle(db, "plan")).toBeNull();
    reply = exam;
    runner.retry(jobId);
    for (let i = 0; i < 400 && pastPaperViews(db, "plan")[0]!.status !== "ready"; i++)
      await new Promise((r) => setTimeout(r, 5));
    expect(pastPaperViews(db, "plan")[0]!.status).toBe("ready");
    db.close();
  });

  it("refuses a missing file, one already in the plan, too many files and a missing engine, before writing anything", () => {
    const db = fixture();
    addSource(db, "gone", "Testo", "removed");
    const runner = createRunner(db, () => {});
    registerPastPaperJobs(db, runner, reader(exam));
    expect(() => addPastPaper(db, runner, "plan", ["nope"])).toThrow("source-missing");
    expect(() => addPastPaper(db, runner, "plan", ["gone"])).toThrow("source-missing");
    expect(() => addPastPaper(db, runner, "plan", ["notes0"])).toThrow("source-in-plan");
    expect(() => addPastPaper(db, runner, "plan", [])).toThrow("paper-files");
    db.prepare("DELETE FROM feature_engines").run();
    addSource(db, "later", "Testo");
    expect(() => addPastPaper(db, runner, "plan", ["later"])).toThrow("engine-missing");
    expect(db.prepare("SELECT COUNT(*) AS n FROM plan_sources WHERE role = 'past_paper'").get()).toEqual({ n: 0 });
    db.close();
  });

  it("waits for a file that is still being imported, and stops on a scan that has no text yet", async () => {
    const db = fixture();
    addSource(db, "slow", "", "extracting");
    addSource(db, "scan", "", "needs-ocr");
    addSource(db, "blank", "");
    const runner = createRunner(db, () => {});
    registerPastPaperJobs(db, runner, reader(exam));
    const slow = addPastPaper(db, runner, "plan", ["slow"]);
    await new Promise((r) => setTimeout(r, 50));
    expect(pastPaperViews(db, "plan")[0]).toMatchObject({ status: "reading" });
    expect(prompts.filter((p) => p.prompt.includes("Testo del file lento"))).toHaveLength(0);
    db.prepare("INSERT INTO passages (id, source_id, text, created_at) VALUES ('slow-p', 'slow', 'Testo del file lento', 1)").run();
    db.prepare("UPDATE sources SET status = 'ready' WHERE id = 'slow'").run();
    expect((await settled(db, slow.jobId)).state).toBe("succeeded");
    expect(pastPaperViews(db, "plan")[0]).toMatchObject({ status: "ready" });
    // A scan without text asks the student to read it first; a ready file with no text says so.
    const scan = addPastPaper(db, runner, "plan", ["scan"]);
    expect(await settled(db, scan.jobId)).toEqual({ state: "failed", error: "paper-needs-ocr" });
    const blank = addPastPaper(db, runner, "plan", ["blank"]);
    expect(await settled(db, blank.jobId)).toEqual({ state: "failed", error: "paper-no-text" });
    db.close();
  });

  it("is not something a rebuild reads: a plan with only a past paper has no sources to rebuild from", async () => {
    const db = fixture();
    db.prepare("DELETE FROM plan_sources WHERE role = 'material'").run();
    addSource(db, "ap1", "Testo dell'appello");
    const runner = createRunner(db, () => {});
    registerPastPaperJobs(db, runner, reader(exam));
    await settled(db, addPastPaper(db, runner, "plan", ["ap1"]).jobId);
    expect(() => startRebuild(db, runner, "plan")).toThrow("no-sources");
    db.close();
  });

  it("drops a paper when its source is removed from the library, with its other files", async () => {
    const db = fixture();
    addSource(db, "pg1", "Uno");
    addSource(db, "pg2", "Due");
    const runner = createRunner(db, () => {});
    registerPastPaperJobs(db, runner, reader(exam));
    await settled(db, addPastPaper(db, runner, "plan", ["pg1", "pg2"]).jobId);
    removeSource(db, "pg1", true);
    expect(db.prepare("SELECT source_id FROM plan_sources WHERE role = 'past_paper'").all()).toEqual([]);
    db.close();
  });
});

describe("past style", () => {
  const paper = (id: string, reply: Reply) => {
    const stored = {
      v: 1,
      title: id,
      minutes: reply.minutes,
      totalPoints: reply.totalPoints,
      questions: reply.questions.map((q, i) => ({ id: `${id}-${i}`, ...q })),
      read: { provider: "claude", model: "m", template: "paper.read", version: "1", at: 1 },
    };
    return stored;
  };
  function withPapers(...replies: Reply[]) {
    const db = fixture();
    replies.forEach((reply, i) => {
      addSource(db, `ap${i}`, "x", "ready", 10 + i);
      db.prepare(
        "INSERT INTO plan_sources (plan_id, source_id, role, paper_json) VALUES ('plan', ?, 'past_paper', ?)",
      ).run(`ap${i}`, JSON.stringify(paper(`ap${i}`, reply)));
    });
    return db;
  }

  it("summarises count, duration, type mix, difficulty and a few example questions", () => {
    const db = withPapers(exam, { ...exam, minutes: 90, questions: exam.questions.slice(0, 4) });
    const style = pastStyle(db, "plan")!;
    expect(style).toMatchObject({
      papers: 2,
      questions: 5,
      minutes: 105,
      totalPoints: 30,
      types: { open: 3, choice: 2, numeric: 4, proof: 1 },
      difficulty: { easy: 4, medium: 3, hard: 3 },
    });
    expect(style.examples).toHaveLength(2);
    db.close();
  });

  it("keeps the question count within what a simulation builds and falls back to question times for the duration", () => {
    const tiny = withPapers({ ...exam, minutes: null, questions: [{ ...question("open"), minutes: 20 }, { ...question("open"), minutes: 25 }] });
    expect(pastStyle(tiny, "plan")).toMatchObject({ questions: 3, minutes: 45 });
    const big = withPapers({ ...exam, questions: Array.from({ length: 40 }, () => question("open")) });
    expect(pastStyle(big, "plan")!.questions).toBe(20);
    expect(pastStyle(fixture(), "plan")).toBeNull();
  });

  it("spreads the types and levels over the slots in the papers' proportions, the same way every time", () => {
    const style: PastStyle = {
      papers: 1,
      questions: 8,
      minutes: null,
      totalPoints: null,
      types: { open: 4, choice: 2, numeric: 2, proof: 0 },
      difficulty: { easy: 2, medium: 4, hard: 2 },
      examples: [],
    };
    const slots = styleSlots(style, 8);
    expect(slots).toHaveLength(8);
    const count = (key: "type" | "difficulty", value: string) => slots.filter((s) => s[key] === value).length;
    expect([count("type", "open"), count("type", "choice"), count("type", "numeric"), count("type", "proof")]).toEqual([4, 2, 2, 0]);
    expect([count("difficulty", "easy"), count("difficulty", "medium"), count("difficulty", "hard")]).toEqual([2, 4, 2]);
    // Evenly spread: no run of three open questions in a row.
    expect(slots.map((s) => s.type).join(" ")).not.toMatch(/open open open/);
    expect(styleSlots(style, 8)).toEqual(slots);
  });

  it("puts each lettered option of a multiple choice question on its own line", () => {
    expect(spaceOptions("Quanto?\nA) 0\nB) 1")).toBe("Quanto?\n\nA) 0\n\nB) 1");
    expect(spaceOptions("Una riga\ncontinua")).toBe("Una riga\ncontinua");
  });
});

describe("practising past questions", () => {
  async function readyPlan(...replies: Reply[]) {
    const db = fixture();
    const runner = createRunner(db, () => {});
    let at = 0;
    registerPastPaperJobs(db, runner, async (input) => reader(replies[at++ % replies.length]!)(input));
    for (const [i, _] of replies.entries()) {
      addSource(db, `ap${i}`, `Testo ${i}`, "ready", 10 + i);
      await settled(db, addPastPaper(db, runner, "plan", [`ap${i}`]).jobId);
    }
    return db;
  }

  it("opens one paper's questions as open answers a quiz page can read, and marks the quiz as exam text", async () => {
    const db = await readyPlan(exam);
    const started = startPastPractice(db, "plan", "ap0");
    expect(started.questions).toHaveLength(6);
    expect(started.questions.every((q) => q.grade.kind === "open")).toBe(true);
    expect(started.questions[1]!.stem).toBe("Quanto vale il limite?\n\nA) 0\n\nB) 1\n\nC) 2\n\nD) 3");
    const quiz = readQuiz(db, started.attemptId, "plan");
    expect(quiz).toMatchObject({ state: "succeeded", requestedCount: 6 });
    expect(quiz.questions).toHaveLength(6);
    const item = db.prepare("SELECT kind, body_json, prompt_template FROM items WHERE kind = 'quiz'").get() as {
      kind: string;
      body_json: string;
      prompt_template: string;
    };
    const body = JSON.parse(item.body_json);
    expect(body.pastPaper).toBe(1);
    expect(body.questions[0].answer).toMatchObject({ kind: "open", reference: "Risposta open" });
    expect(item.prompt_template).toBe("paper.read");
    // Exam text never goes into a shared plan file, even with progress.
    for (const progress of [false, true])
      expect((exportPlan(db, "plan", { progress }).items ?? []).some((i) => i.kind === "quiz")).toBe(false);
    db.close();
  });

  it("mixes the papers into at most ten questions when no paper is chosen, and skips questions marked wrong", async () => {
    const db = await readyPlan(exam, exam);
    const all = startPastPractice(db, "plan");
    expect(all.questions).toHaveLength(10);
    const ids = JSON.parse(
      (db.prepare("SELECT paper_json FROM plan_sources WHERE source_id = 'ap0'").get() as { paper_json: string }).paper_json,
    ).questions.map((q: { id: string }) => q.id) as string[];
    flagTarget(db, "exercise", ids[0]!, "");
    expect(startPastPractice(db, "plan", "ap0").questions).toHaveLength(5);
    expect(() => startPastPractice(db, "plan", "nope")).toThrow("past-empty");
    db.close();
  });

  it("has nothing to practise until a paper has been read", () => {
    const db = fixture();
    expect(() => startPastPractice(db, "plan")).toThrow("past-empty");
    db.close();
  });
});

describe("simulations that follow past papers", () => {
  const seen: Array<{ system: string; asked: Record<string, unknown> }> = [];
  /** Writes what the slots ask for, with the type echoed back. */
  const writer: GenerateInput["run"] = async (input) => {
    const asked = JSON.parse(input.prompt) as {
      count: number;
      passages: Array<{ id: string }>;
      slots?: Array<{ type: string }>;
    };
    seen.push({ system: input.system ?? "", asked });
    const structured = {
      questions: Array.from({ length: asked.count }, (_, i) => ({
        stem: `Domanda ${seen.length}.${i}${asked.slots?.[i]?.type === "choice" ? "\nA) uno\nB) due" : ""}`,
        reference: "Riferimento",
        passageIds: [asked.passages[0]!.id],
        ...(asked.slots ? { type: asked.slots[i]!.type } : {}),
      })),
    };
    return { text: JSON.stringify(structured), structured, provider: "claude", model: "writer-model", inputTokens: 1 };
  };

  async function planWithPapers() {
    const db = fixture();
    const runner = createRunner(db, () => {});
    registerPastPaperJobs(db, runner, reader(exam));
    registerSimulationJobs(db, runner, writer);
    addSource(db, "ap0", "Testo");
    await settled(db, addPastPaper(db, runner, "plan", ["ap0"]).jobId);
    return db;
  }
  async function ready(db: ReturnType<typeof openDatabase>) {
    for (let i = 0; i < 400; i++) {
      if (readSimulationBuild(db, "plan")?.state === "succeeded") return;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("build did not finish");
  }

  it("bumps the question prompt and tells it about slots and examples", () => {
    expect(loadTemplate("simulation.questions").version).toBe("2");
    expect(loadTemplate("simulation.questions").body).toContain("`slots`");
    expect(loadTemplate("paper.read").version).toBe("1");
  });

  it("copies the number of questions, the types and the difficulty of the past papers", async () => {
    seen.length = 0;
    const db = await planWithPapers();
    enqueueSimulation(db, "plan", 120);
    await ready(db);
    expect(readSimulationBuild(db, "plan")).toMatchObject({ styled: true, minutes: 120 });
    // Six questions, split over the two topics; each batch asked for its slots and the example questions.
    expect(seen.map((call) => call.asked.count)).toEqual([3, 3]);
    const slots = seen.flatMap((call) => call.asked.slots as Array<{ type: string; difficulty: string }>);
    expect(slots.map((s) => s.type).sort()).toEqual(["choice", "numeric", "numeric", "open", "open", "proof"]);
    expect(slots.filter((s) => s.difficulty === "hard")).toHaveLength(2);
    expect(seen[0]!.asked.examples).toHaveLength(1);
    expect(seen[0]!.asked.examTotalPoints).toBe(30);
    expect(seen[0]!.system).toContain("past exams");
    startSimulation(db, "plan");
    const run = openSimulation(db, "plan")!;
    expect(run.questions).toHaveLength(6);
    expect(run.questions.some((q) => q.stem.includes("\n\nA) uno\n\nB) due"))).toBe(true);
    const item = db.prepare("SELECT body_json, prompt_version FROM items WHERE kind = 'simulation'").get() as {
      body_json: string;
      prompt_version: string;
    };
    expect(JSON.parse(item.body_json)).toMatchObject({ styledOn: 1 });
    expect(item.prompt_version).toBe("2");
    db.close();
  });

  it("writes the generic 20-question format when asked, or when no paper was read", async () => {
    seen.length = 0;
    const db = await planWithPapers();
    enqueueSimulation(db, "plan", 60, Date.now(), "exam", false);
    await ready(db);
    expect(readSimulationBuild(db, "plan")).toMatchObject({ styled: false });
    expect(seen.reduce((n, call) => n + (call.asked.count as number), 0)).toBe(20);
    expect(seen.every((call) => call.asked.slots === undefined)).toBe(true);
    db.close();
  });

  it("replaces a prepared exam of the other format with a new build", async () => {
    seen.length = 0;
    const db = await planWithPapers();
    const first = enqueueSimulation(db, "plan", 60, Date.now(), "exam", false) as { jobId: string };
    await ready(db);
    expect(enqueueSimulation(db, "plan", 60, Date.now(), "exam", false)).toEqual(first);
    const second = enqueueSimulation(db, "plan", 60, Date.now(), "exam", true) as { jobId: string };
    expect(second.jobId).not.toBe(first.jobId);
    await ready(db);
    expect(readSimulationBuild(db, "plan")).toMatchObject({ jobId: second.jobId, styled: true });
    db.close();
  });

  it("retries a batch whose type does not match its slot", async () => {
    seen.length = 0;
    const db = fixture();
    const runner = createRunner(db, () => {});
    registerPastPaperJobs(db, runner, reader(exam));
    let calls = 0;
    registerSimulationJobs(db, runner, async (input) => {
      const result = await writer({
        ...input,
        prompt: input.prompt.split("\n\nThe previous answer failed validation.")[0]!,
      });
      if (++calls === 1) {
        const data = result.structured as { questions: Array<{ type: string }> };
        data.questions[0]!.type = data.questions[0]!.type === "open" ? "proof" : "open";
        result.text = JSON.stringify(data);
        result.structured = data;
      }
      return result;
    });
    addSource(db, "ap0", "Testo");
    await settled(db, addPastPaper(db, runner, "plan", ["ap0"]).jobId);
    enqueueSimulation(db, "plan", 60);
    await ready(db);
    expect(calls).toBe(3);
    db.close();
  });
});
