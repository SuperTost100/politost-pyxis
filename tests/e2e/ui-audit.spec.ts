import AxeBuilder from "@axe-core/playwright";
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PNG } from "pngjs";
import { putBlob } from "../../src/core/blobs";
import { OCR_DATA_FILES, ocrDataDir } from "../../src/core/sources/ocr-data";
import { imageOnlyPdf } from "./scanned-pdf-fixture";

// Native Electron is required: these routes consume the utility-process IPC port.
const routes = [
  ["root", "/"],
  ["onboarding", "/onboarding"],
  ["ask-new", "/ask"],
  ["ask-thread", "/ask/audit-chat"],
  ["exams", "/exams"],
  ["library", "/exams/library"],
  ["library-vision", "/exams/library"],
  ["shared", "/exams/get"],
  ["import-review", "/exams/get"],
  ["settings", "/settings"],
  ...[
    "profile",
    "subjects",
    "engines",
    "tutor",
    "reading",
    "appearance",
    "language",
    "data",
    "privacy",
    "updates",
    "about",
    "diagnostics",
  ].map((section) => [`settings-${section}`, `/settings/${section}`] as const),
  ["gallery", "/dev/gallery"],
  ...[1, 2, 3, 4, 5, 6].map(
    (step) => [`wizard-${step}`, "/plans/new"] as const,
  ),
  ["plan", "/plans/audit-plan"],
  ["plan-topics", "/plans/audit-plan/topics"],
  ["plan-sources", "/plans/audit-plan/sources"],
  ["plan-progress", "/plans/audit-plan/progress"],
  ["progress-gap-misconception", "/plans/audit-plan/progress"],
  ["progress-gaps-distinct", "/plans/audit-plan/progress"],
  ["plan-settings", "/plans/audit-plan"],
  ["plan-create", "/plans/audit-plan"],
  ["library-import", "/exams/library"],
  // Overlay states below are reached by role-based interaction (Ant Design 6 drawers and modals are role="dialog").
  ["library-row-menu", "/exams/library"],
  ["library-details", "/exams/library"],
  ["library-folder", "/exams/library"],
  ["library-link", "/exams/library"],
  ["library-text", "/exams/library"],
  ["library-text-ready", "/exams/library"],
  ["source-viewer", "/exams/library"],
  ["engine-details", "/settings/engines"],
  ["engine-details-disabled", "/settings/engines"],
  ["engine-add-cli", "/settings/engines"],
  ["engine-add-key", "/settings/engines"],
  ["progress-simulations", "/plans/audit-plan/progress"],
  ["progress-pace", "/plans/audit-plan/progress"],
  ["export-lesson", "/plans/audit-plan/lesson/audit-topic"],
  ["export-cards", "/plans/audit-plan/cards/audit-topic"],
  ["export-simulation", "/plans/audit-plan/exam/audit-exam-attempt"],
  ["export-plan", "/plans/audit-plan"],
  ["export-plan-embed", "/plans/audit-plan"],
  ["practice", "/plans/audit-plan/practice/audit-topic"],
  ["lesson", "/plans/audit-plan/lesson/audit-topic"],
  ["lesson-rewrite", "/plans/audit-plan/lesson/audit-topic"],
  ["lesson-flag", "/plans/audit-plan/lesson/audit-topic"],
  ["quiz-setup", "/plans/audit-plan/quiz/audit-topic"],
  ["quiz-page", "/plans/audit-plan/quiz/audit-topic"],
  ["quiz-timed", "/plans/audit-plan/quiz/audit-topic"],
  ["diagnostic", "/plans/audit-plan/diagnostic"],
  ["quiz", "/plans/audit-plan/quiz/audit-topic?attempt=audit-quiz-attempt"],
  ["cards", "/plans/audit-plan/cards/audit-topic"],
  ["simulation-setup", "/plans/audit-plan/simulation"],
  ["simulation-ready", "/plans/audit-ready-plan/simulation"],
  ["simulation-result", "/plans/audit-plan/exam/audit-exam-attempt"],
  ["map", "/plans/audit-plan/map/audit-topic"],
  ["whiteboard", "/tools/whiteboard"],
  ["graph", "/tools/graph"],
  ["python", "/tools/python"],
  ["jobs-popover", "/exams"],
  ["provider-disclosure", "/settings/engines"],
  [
    "quiz-grading-failed",
    "/plans/audit-plan/quiz/audit-topic?attempt=audit-grading-attempt",
  ],
  ["simulation-grading-failed", "/plans/audit-plan/exam/audit-frozen-attempt"],
  ["review-start", "/plans/audit-plan/review"],
  ["review-building", "/plans/audit-review-plan/review"],
  ["review-failed", "/plans/audit-review-plan/review"],
  ["review-skipped", "/plans/audit-review-plan/review"],
  ["review-interrupted", "/plans/audit-review-plan/review"],
  ["review-cancelled", "/plans/audit-review-plan/review"],
  ["review-cards-waiting", "/plans/audit-review-plan/review/cards"],
  [
    "review-quiz-pending",
    "/plans/audit-review-plan/diagnostic?attempt=audit-review-attempt",
  ],
  ["rebuild-intro", "/plans/audit-plan/sources"],
  ["rebuild-running", "/plans/audit-plan/sources"],
  ["rebuild-failed", "/plans/audit-plan/sources"],
  ["rebuild-interrupted", "/plans/audit-plan/sources"],
  ["rebuild-review", "/plans/audit-plan/sources"],
  ["guided-period", "/plans/new"],
  ["guided-modules", "/plans/new"],
  ["guided-style", "/plans/new"],
  ["guided-tree", "/plans/new"],
  ["ask-python", "/ask/audit-python-chat"],
  ["library-folder-capped", "/exams/library"],
  ["library-flagged", "/exams/library"],
  ["library-flagged-details", "/exams/library"],
  ["selection-source", "/exams/library"],
  ["selection-lesson", "/plans/audit-plan/lesson/audit-topic"],
  ["reading-large-lesson", "/plans/audit-plan/lesson/audit-topic"],
  ["reading-large-progress", "/plans/audit-plan/progress"],
  // Local OCR data: consent, progress and recovery in Settings, in the jobs list and where a read was refused.
  ["ocr-settings-missing", "/settings/data"],
  ["ocr-settings-integrity", "/settings/data"],
  ["ocr-settings-ready", "/settings/data"],
  ["ocr-download-running", "/settings/data"],
  ["ocr-download-offline", "/settings/data"],
  ["ocr-download-cancelled", "/settings/data"],
  ["ocr-jobs-popover", "/exams"],
  // A scan with no stored file offers Replace instead of a read that cannot run. A timed exam in progress adds Resume to every Shell page.
  ["library-scan-no-file", "/exams/library"],
  ["shell-exam-active", "/exams"],
  ["library-ocr-refused", "/exams/library"],
  ["library-ocr-ready", "/exams/library"],
  ["ask-ocr-refused", "/ask"],
  ["ask-ocr-ready", "/ask"],
] as const;

/** The pinned OCR files the runtime task downloaded once. The audit stages these bytes, it never fetches them. */
const tessdataSource = () =>
  process.env.PYXIS_TESSDATA_DIR ??
  join(process.cwd(), ".tmp", "tessdata-fast");
const tessdataHome = () =>
  ocrDataDir(join(auditUserData, "workspace", "runtimes", "tesseract"));
/** A 1x1 PNG, the photo a refused chat keeps attached. */
const tinyPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/** Puts the language files on disk the way a finished download leaves them, after checking them against the pins. */
function stageOcrData(truncateEnglish = false) {
  const dir = tessdataHome();
  mkdirSync(dir, { recursive: true });
  for (const [lang, pinned] of Object.entries(OCR_DATA_FILES)) {
    const from = join(tessdataSource(), `${lang}.traineddata`);
    const bytes = readFileSync(from);
    if (
      bytes.length !== pinned.size ||
      createHash("sha256").update(bytes).digest("hex") !== pinned.sha256
    )
      throw new Error(
        `${from} is not the pinned ${lang} file. Set PYXIS_TESSDATA_DIR to the downloaded tessdata_fast files.`,
      );
    if (truncateEnglish && lang === "eng")
      writeFileSync(join(dir, `${lang}.traineddata`), bytes.subarray(0, 4096));
    else copyFileSync(from, join(dir, `${lang}.traineddata`));
  }
}

function seed(db: DatabaseSync) {
  const now = Date.now();
  db.exec(`INSERT INTO subjects(id,name,position,created_at) VALUES('audit-subject','Fisica',0,1);
    INSERT INTO sources(id,kind,title,status,library,created_at,updated_at) VALUES('audit-source','excerpt','Appunti di fisica','ready',1,1,1);
    INSERT INTO source_documents(id,source_id,version,tree_json,created_at) VALUES('audit-document','audit-source',1,'{"kind":"excerpt"}',1);
    INSERT INTO passages(id,source_id,document_id,text,locator_json,section_path,created_at) VALUES('audit-passage','audit-source','audit-document','La forza è il prodotto di massa e accelerazione.','{"chapter":1,"paragraph":"p1"}','1. Dinamica',1);
    INSERT INTO smartbooks(id,source_id,meta_json,created_at) VALUES('audit-book','audit-source','{"title":"Fisica","chapters":[]}',1);
    INSERT INTO exercises(id,smartbook_id,passage_id,prompt,answer,locator_json,grounding,created_at) VALUES('audit-exercise','audit-book','audit-passage','Calcola la forza per $m=2$ kg e $a=3$ m/s².','$F=ma=6$ N','{"chapter":1,"kind":"esame"}','sources',1);
    INSERT INTO plans(id,subject_id,title,status,content_language,target,created_at,updated_at) VALUES('audit-plan','audit-subject','Fisica 1','ready','it',0.75,1,1);
    INSERT INTO plan_sources(plan_id,source_id) VALUES('audit-plan','audit-source');
    INSERT INTO topics(id,plan_id,title,position,created_at) VALUES('audit-topic','audit-plan','Dinamica',0,1);
    INSERT INTO topic_passages(topic_id,passage_id) VALUES('audit-topic','audit-passage');
    INSERT INTO cards(id,plan_id,topic_id,front,back,passage_id,grounding,created_at) VALUES('audit-card','audit-plan','audit-topic','Qual è la seconda legge di Newton?','$F=ma$. La forza è proporzionale alla massa.','audit-passage','sources',1);
    INSERT INTO chats(id,title,subject,created_at,updated_at) VALUES('audit-chat','Seconda legge di Newton','Fisica',1,2);
    INSERT INTO messages(id,chat_id,role,body,created_at) VALUES('audit-user','audit-chat','user','Come calcolo la forza?',1);
    INSERT INTO messages(id,chat_id,role,body,grounding,created_at) VALUES('audit-assistant','audit-chat','assistant','Usa $F=ma$. Con $m=2$ e $a=3$, ottieni $6$ N [P1].','sources',2);
    INSERT INTO message_passages(message_id,passage_id,label) VALUES('audit-assistant','audit-passage','P1');`);
  db.prepare(
    "INSERT INTO settings(key,value_json,updated_at) VALUES('plan-import:audit-plan',?,?)",
  ).run(JSON.stringify({ author: "Example author", exportedAt: now }), now);
  db.exec(`
    INSERT INTO sources(id,kind,title,status,library,created_at,updated_at) VALUES('audit-photo','image','Photo notes','ready',1,1,1);
    INSERT INTO source_documents(id,source_id,version,tree_json,created_at) VALUES('audit-photo-document','audit-photo',1,'{"extractor":{"path":"vision","provider":"fixture","model":"vision-fixture-model"}}',1);
  `);
  // One unbroken JSON line wider than the message column, so the code block scrolls and axe checks it is keyboard reachable.
  db.prepare(
    "INSERT INTO messages(id,chat_id,role,body,created_at) VALUES('audit-code','audit-chat','assistant',?,3)",
  ).run(
    `\`\`\`json\n${JSON.stringify({ forces: Array.from({ length: 40 }, (_, i) => ({ id: i, m: 2, a: 3, F: 6 })) })}\n\`\`\``,
  );
  const item = db.prepare(
    "INSERT INTO items(id,plan_id,topic_id,kind,body_json,engine_provider,grounding,created_at) VALUES(?,'audit-plan','audit-topic',? ,?,'fixture','sources',?)",
  );
  const question = {
    id: "audit-question",
    topicId: "audit-topic",
    sourceIds: ["audit-passage"],
    stem: "Quale formula descrive la forza?",
    options: ["$F=ma$", "$F=m/a$", "$F=a/m$", "$F=0$"],
    explanation:
      "La seconda legge di Newton lega forza, massa e accelerazione.",
    answer: { kind: "mcq", correct: 0, picked: -1 },
  };
  const questions = Array.from({ length: 10 }, (_, i) => ({
    ...question,
    id: `audit-question-${i}`,
  }));
  item.run(
    "audit-lesson",
    "lesson",
    JSON.stringify({
      cacheKey: JSON.stringify({
        kind: "lesson",
        scopeId: "audit-topic",
        promptVersion: "model-1",
        passageIds: ["audit-passage"],
      }),
      markdown:
        "# La dinamica\n\nLa seconda legge di Newton è $F=ma$ [P1].\n\n## Un esempio\n\nCon una massa di $2\\,kg$ e un’accelerazione di $3\\,m/s^2$,\n\n$$F=2\\cdot3=6\\,N.$$",
    }),
    1,
  );
  item.run("audit-diagnostic", "diagnostic", JSON.stringify({ questions }), 2);
  item.run(
    "audit-quiz",
    "quiz",
    JSON.stringify({
      questions,
      config: { count: 10, feedback: true, types: ["mcq"] },
      complete: true,
    }),
    3,
  );
  const results = [
    {
      id: "exam-question",
      score: 0.8,
      expected: "$F=6$ N",
      feedback: "Il procedimento è corretto; indica anche l’unità di misura.",
      missed: ["Unità di misura"],
      provider: "fixture",
      model: "audit-grading-model",
    },
  ];
  item.run(
    "audit-exam",
    "simulation",
    JSON.stringify({
      minutes: 30,
      questions: [
        {
          id: "exam-question",
          sourceId: "audit-exercise",
          topicId: "audit-topic",
          stem: "Calcola la forza con $m=2$ e $a=3$.",
          answer: { kind: "completion", accepted: [["6 N"]] },
        },
      ],
      picks: { "exam-question": "6" },
      gradingStartedAt: now - 2000,
      result: { score: 0.8, results },
    }),
    4,
  );
  db.prepare(
    "INSERT INTO item_passages(item_id,passage_id) VALUES(?,'audit-passage')",
  ).run("audit-lesson");
  db.prepare(
    "INSERT INTO attempts(id,plan_id,item_id,started_at,submitted_at) VALUES(?,'audit-plan',?,?,?)",
  ).run("audit-quiz-attempt", "audit-quiz", now, null);
  db.prepare(
    "INSERT INTO attempts(id,plan_id,item_id,started_at,submitted_at) VALUES(?,'audit-plan',?,?,?)",
  ).run("audit-exam-attempt", "audit-exam", now - 1800000, now - 1000);
  db.prepare(
    "INSERT INTO attempt_answers(id,attempt_id,payload_json,created_at) VALUES('audit-grade','audit-exam-attempt',?,?)",
  ).run(JSON.stringify({ score: 0.8, results }), now - 1000);

  item.run(
    "audit-grading-quiz",
    "quiz",
    JSON.stringify({
      questions: questions.map((q) => ({
        ...q,
        answer: { kind: "open", reference: "F=ma" },
      })),
      config: { count: 10, feedback: false },
      complete: true,
    }),
    5,
  );
  const attempt = db.prepare(
    "INSERT INTO attempts(id,plan_id,item_id,started_at) VALUES(?,'audit-plan',?,?)",
  );
  attempt.run("audit-grading-attempt", "audit-grading-quiz", now);
  item.run(
    "audit-frozen-exam",
    "simulation",
    JSON.stringify({
      minutes: 30,
      questions: [
        {
          id: "frozen-question",
          topicId: "audit-topic",
          stem: "Calcola la forza.",
          answer: { kind: "completion", accepted: [["6 N"]] },
        },
      ],
      picks: { "frozen-question": "6 N" },
      gradingStartedAt: now - 1000,
      gradingJobId: "audit-sim-grade",
    }),
    6,
  );
  attempt.run("audit-frozen-attempt", "audit-frozen-exam", now - 1800000);
  const job = db.prepare(
    "INSERT INTO jobs(id,kind,params_json,state,progress,step_label,error,created_at,updated_at) VALUES(?,?,?,'failed',0,?,?,?,?)",
  );
  job.run(
    "audit-quiz-grade",
    "quiz-grade",
    JSON.stringify({
      attemptId: "audit-grading-attempt",
      picks: {},
      pending: questions.map((q) => q.id),
      next: 0,
    }),
    "jobs.quizGrading",
    "engine-missing",
    now,
    now,
  );
  // Photo reading that stopped for a reason the student can act on: each has its own plain message in the jobs popover.
  for (const [id, error] of [
    ["audit-image-unsupported", "vision-image-unsupported"],
    ["audit-image-large", "vision-image-too-large"],
  ] as const)
    job.run(
      id,
      "source-import",
      JSON.stringify({ sourceId: "audit-photo" }),
      "sources.jobs.extract",
      error,
      now,
      now,
    );
  job.run(
    "audit-sim-grade",
    "simulation-grade",
    JSON.stringify({
      attemptId: "audit-frozen-attempt",
      planId: "audit-plan",
      questions: [{ id: "frozen-question" }],
      results: [],
      next: 0,
    }),
    "jobs.simulationGrading",
    "invalid-output",
    now,
    now,
  );
  job.run(
    "audit-quiz-build",
    "audit-display",
    "{}",
    "quiz.generating",
    "invalid-output",
    now,
    now,
  );
  job.run(
    "audit-sim-build",
    "audit-display",
    "{}",
    "simulation.building",
    "invalid-output",
    now,
    now,
  );
  db.exec(`
    INSERT INTO plans(id,title,status,content_language,created_at,updated_at) VALUES('audit-ready-plan','Prepared exam','ready','it',1,1);
    INSERT INTO topics(id,plan_id,title,position,created_at) VALUES('audit-ready-topic','audit-ready-plan','Force',0,1);
  `);
  db.prepare(
    "INSERT INTO jobs(id,kind,params_json,state,progress,created_at,updated_at) VALUES('audit-ready-build','simulation-build',?,'succeeded',1,?,?)",
  ).run(
    JSON.stringify({
      planId: "audit-ready-plan",
      minutes: 30,
      selection: { provider: "claude", model: "recorded-fixture" },
      language: "it",
      batches: [],
      next: 1,
      questions: [
        {
          id: "prepared-question",
          topicId: "audit-ready-topic",
          stem: "Calculate force.",
          answer: { kind: "completion", accepted: [["6 N"]] },
        },
      ],
      provider: "fixture",
      model: "recorded-fixture",
    }),
    now,
    now,
  );
  db.exec(`
    INSERT INTO plans(id,title,status,content_language,created_at,updated_at) VALUES('audit-review-plan','Review plan','ready','it',1,1);
    INSERT INTO topics(id,plan_id,title,position,created_at) VALUES('audit-review-topic','audit-review-plan','Cinematica',0,1);
    INSERT INTO chats(id,title,subject,created_at,updated_at) VALUES('audit-python-chat','Calcolo con Python','Fisica',1,2);
    INSERT INTO messages(id,chat_id,role,body,created_at) VALUES('audit-python-user','audit-python-chat','user','Calcola 6 per 7',1);
  `);
  db.prepare(
    "INSERT INTO messages(id,chat_id,role,body,created_at) VALUES('audit-python-reply','audit-python-chat','assistant',?,2)",
  ).run("Prova così:\n\n```python\nprint(6 * 7)\n```\n");
  const graph = {
    layout: "tree",
    nodes: [
      {
        id: "map-root",
        label: "Dinamica",
        parent: null,
        x: 0,
        y: 0,
        pinned: false,
        sources: ["audit-passage"],
      },
      {
        id: "map-mass",
        label: "Massa $m$",
        parent: "map-root",
        x: -120,
        y: 160,
        pinned: false,
        sources: ["audit-passage"],
      },
      {
        id: "map-force",
        label: "Forza $F=ma$",
        parent: "map-root",
        x: 120,
        y: 160,
        pinned: false,
        sources: ["audit-passage"],
      },
    ],
    edges: [
      { from: "map-root", to: "map-mass" },
      { from: "map-root", to: "map-force" },
    ],
    undo: null,
  };
  db.prepare(
    "INSERT INTO maps(id,plan_id,topic_id,graph_json,grounding,created_at) VALUES('audit-map','audit-plan','audit-topic',?,'sources',1)",
  ).run(
    JSON.stringify({
      version: 1,
      maps: [
        {
          id: "audit-map-entry",
          title: "Dinamica",
          passageIds: ["audit-passage"],
          graph,
        },
      ],
    }),
  );
  const nodes = [
    "intro",
    "diagnostic",
    "learn",
    "practice",
    "gaps",
    "cards",
    "quiz",
    "map",
    "simulation",
    "final",
  ];
  const step = db.prepare(
    "INSERT INTO path_nodes(id,plan_id,topic_id,kind,position,title,created_at) VALUES(?,'audit-plan','audit-topic',?,?,?,1)",
  );
  nodes.forEach((kind, i) => step.run(`audit-step-${i}`, kind, i, kind));
  const event = db.prepare(
    "INSERT INTO learning_events(id,kind,plan_id,topic_id,payload_json,created_at) VALUES(? ,?,'audit-plan','audit-topic',?,?)",
  );
  for (let day = 0; day < 14; day++) {
    event.run(
      `audit-answer-${day}`,
      "answer_given",
      '{"score":0.8,"scores":[0.8]}',
      now - day * 86400000,
    );
    event.run(
      `audit-time-${day}`,
      "active_time",
      '{"seconds":900}',
      now - day * 86400000 + 1,
    );
  }
}

/** A raw locale key on screen: any top-level section of en.json followed by a dotted path, so no section is skipped. */
const untranslatedKey = new RegExp(
  `\\b(?:${Object.keys(JSON.parse(readFileSync(join(process.cwd(), "src/renderer/src/locales/en.json"), "utf8"))).join("|")})\\.[A-Za-z][\\w.-]+`,
  "g",
);
const both = (it: string, en: string) => new RegExp(`^(${it}|${en})$`);

async function openAdvancedEngines(page: Page) {
  const toggle = page.getByRole("switch", {
    name: /^(Opzioni avanzate|Advanced options)$/,
  });
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute("aria-checked")) !== "true")
    await toggle.click();
}

async function openAddSources(page: Page, tab?: RegExp) {
  await page
    .getByRole("button", { name: both("Aggiungi fonti", "Add sources") })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  // Segmented renders radios; the hidden native input is the accessible control.
  if (tab) await dialog.getByRole("radio", { name: tab }).locator("..").click();
  return dialog;
}

async function openExport(page: Page) {
  await page
    .getByRole("button", { name: both("Esporta", "Export") })
    .first()
    .click();
  await expect(
    page
      .getByRole("dialog")
      .last()
      .getByRole("button", { name: both("Salva file", "Save file") }),
  ).toBeVisible();
}

let auditUserData = "";
let auditApp: ElectronApplication | undefined;
let auditPicked = "";
function withDb(work: (db: DatabaseSync) => void) {
  const db = new DatabaseSync(join(auditUserData, "workspace", "pyxis.db"), {
    timeout: 10000,
  });
  try {
    work(db);
  } finally {
    db.close();
  }
}

/** States that need stored data of their own are written before the page loads; the page then reads them like any user would. */
/** A white one-page image-only PDF in the audit workspace's blob store, like the file an import keeps. */
function auditScanBlob(): string {
  const png = new PNG({ width: 306, height: 396 });
  png.data.fill(255);
  return putBlob(
    join(auditUserData, "workspace"),
    imageOnlyPdf([PNG.sync.write(png)]),
    "application/pdf",
    "pdf",
  );
}

function prepareState(name: string) {
  if (name.startsWith("library")) {
    // A stored syllabus comparison, keyed the way the core keys it: the source version and each plan's compared texts.
    withDb((db) => {
      if (!name.startsWith("library-flagged")) {
        db.prepare(
          "DELETE FROM settings WHERE key = 'syllabus.audit-source'",
        ).run();
        return;
      }
      const texts = [
        (
          db
            .prepare("SELECT title FROM plans WHERE id = 'audit-plan'")
            .get() as { title: string }
        ).title,
        (
          db
            .prepare("SELECT name FROM subjects WHERE id = 'audit-subject'")
            .get() as { name: string }
        ).name,
        ...(
          db
            .prepare(
              "SELECT title FROM topics WHERE plan_id = 'audit-plan' AND archived_at IS NULL ORDER BY position",
            )
            .all() as Array<{ title: string }>
        ).map((row) => row.title),
      ];
      const key = createHash("sha256")
        .update(JSON.stringify([1, [["audit-plan", texts]]]))
        .digest("hex");
      const checks = [
        {
          planId: "audit-plan",
          planTitle: "Fisica 1",
          state: "checked",
          sections: 3,
          off: 2,
          worst: [
            { section: "Ricette", similarity: 0.74 },
            { section: "Sport", similarity: 0.75 },
          ],
        },
      ];
      db.prepare(
        "INSERT INTO settings(key,value_json,updated_at) VALUES('syllabus.audit-source',?,1) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json",
      ).run(JSON.stringify({ key, checks }));
    });
  }
  const drills: Record<string, string> = {
    "review-building": "running",
    "review-failed": "failed",
    "review-skipped": "failed",
    "review-interrupted": "interrupted",
    "review-cancelled": "cancelled",
    "review-cards-waiting": "running",
    "review-quiz-pending": "running",
  };
  if (name in drills) {
    withDb((db) => {
      const now = Date.now();
      db.exec(`DELETE FROM attempts WHERE plan_id = 'audit-review-plan';
        DELETE FROM items WHERE plan_id = 'audit-review-plan';
        DELETE FROM jobs WHERE id = 'audit-review-drill';`);
      // A cancelled drill only shows while other questions keep the review open; a waiting one needs none.
      const withQuestion =
        name === "review-cancelled" ||
        name === "review-quiz-pending" ||
        name === "review-skipped";
      const questions = withQuestion
        ? [
            {
              id: "audit-review-q",
              topicId: "audit-review-topic",
              stem: "Quale formula descrive la velocità?",
              options: ["$v=s/t$", "$v=st$", "$v=s+t$", "$v=t/s$"],
              explanation: "Spazio diviso tempo.",
              answer: { kind: "mcq", correct: 0, picked: -1 },
            },
          ]
        : [];
      db.prepare(
        "INSERT INTO items(id,plan_id,kind,body_json,engine_provider,grounding,created_at) VALUES('audit-review-item','audit-review-plan','review',?,'fixture','sources',?)",
      ).run(
        JSON.stringify({
          questions,
          config: { count: 5, feedback: false },
          complete: true,
        }),
        now,
      );
      db.prepare(
        "INSERT INTO attempts(id,plan_id,item_id,started_at) VALUES('audit-review-attempt','audit-review-plan','audit-review-item',?)",
      ).run(now + 1);
      db.prepare(
        "INSERT INTO items(id,plan_id,kind,body_json,grounding,created_at) VALUES('audit-review-session','audit-review-plan','review_session',?,'sources',?)",
      ).run(
        JSON.stringify({
          cardIds: [],
          attemptId: "audit-review-attempt",
          drills: [
            {
              topicId: "audit-review-topic",
              jobId: "audit-review-drill",
              want: 3,
              ...(name === "review-skipped" ? { skipped: true } : {}),
            },
          ],
        }),
        now,
      );
      db.prepare(
        "INSERT INTO jobs(id,kind,params_json,state,progress,created_at,updated_at) VALUES('audit-review-drill','gap-drill',?,?,0,?,?)",
      ).run(
        JSON.stringify({
          planId: "audit-review-plan",
          topicId: "audit-review-topic",
        }),
        drills[name]!,
        now,
        now,
      );
    });
  }
  // PRO-02: gaps with the model's reading of the mistakes; a topic can hold several, one per distinct misconception.
  withDb((db) => {
    db.prepare("DELETE FROM gaps WHERE plan_id = 'audit-plan'").run();
    if (!name.startsWith("progress-gap")) return;
    const insert = db.prepare(
      "INSERT INTO gaps(id,plan_id,topic_id,opened_at,misconception,severity,comparison) VALUES(?,'audit-plan','audit-topic',?,?,?,?)",
    );
    const now = Date.now();
    insert.run(
      "audit-gap-1",
      now - 3 * 86400000,
      "Confonde la massa con il peso: pensa che cambi se cambia il pianeta.",
      "severe",
      null,
    );
    if (name === "progress-gaps-distinct") {
      insert.run(
        "audit-gap-2",
        now - 2 * 86400000,
        "Applica la seconda legge a una sola forza, senza sommare le forze che agiscono sul corpo.",
        "minor",
        "unchecked",
      );
      insert.run("audit-gap-3", now - 86400000, null, "minor", null);
    }
  });
  withDb((db) => {
    db.exec(
      `DELETE FROM attempts WHERE id = 'audit-active-attempt'; DELETE FROM items WHERE id = 'audit-active-exam'`,
    );
    if (name !== "shell-exam-active") return;
    // An unsubmitted simulation that has not started grading is what the Shell reads as the exam in progress.
    const now = Date.now();
    db.prepare(
      "INSERT INTO items(id,plan_id,topic_id,kind,body_json,engine_provider,grounding,created_at) VALUES('audit-active-exam','audit-plan','audit-topic','simulation',?,'fixture','sources',?)",
    ).run(JSON.stringify({ minutes: 60, questions: [], picks: {} }), now);
    db.prepare(
      "INSERT INTO attempts(id,plan_id,item_id,started_at) VALUES('audit-active-attempt','audit-plan','audit-active-exam',?)",
    ).run(now);
  });
  const noFile = name === "library-scan-no-file";
  const ocrState =
    noFile || name.startsWith("ocr-") || /-ocr-(refused|ready)$/.test(name);
  if (!ocrState) {
    rmSync(tessdataHome(), { recursive: true, force: true });
    withDb((db) => {
      db.exec(
        `DELETE FROM jobs WHERE kind = 'ocr-data-download'; DELETE FROM sources WHERE id = 'audit-scan';`,
      );
      db.prepare("DELETE FROM settings WHERE key = 'ocr.consent'").run();
    });
  }
  if (ocrState) {
    const stored = ["ocr-settings-integrity", "ocr-settings-ready"].includes(
      name,
    );
    rmSync(tessdataHome(), { recursive: true, force: true });
    if (name === "ocr-settings-integrity") stageOcrData(true);
    if (name === "ocr-settings-ready") stageOcrData();
    const now = Date.now();
    withDb((db) => {
      db.exec(`DELETE FROM jobs WHERE kind = 'ocr-data-download'`);
      db.prepare("DELETE FROM settings WHERE key = 'ocr.consent'").run();
      if (stored)
        db.prepare(
          "INSERT INTO settings(key,value_json,updated_at) VALUES('ocr.consent','true',?)",
        ).run(now);
      db.exec(`DELETE FROM sources WHERE id = 'audit-scan'`);
      if (name.startsWith("library-ocr") || noFile) {
        // The stored file is what the renderer reads page by page, so the OCR states keep a real one-page image-only PDF.
        const sha = noFile ? null : auditScanBlob();
        db.prepare(
          "INSERT INTO sources(id,kind,title,status,library,blob_sha,created_at,updated_at) VALUES('audit-scan','pdf','Dispensa scansionata','needs-ocr',1,?,1,1)",
        ).run(sha);
        db.exec(
          `INSERT INTO source_documents(id,source_id,version,tree_json,created_at) VALUES('audit-scan-document','audit-scan',1,'{}',1)`,
        );
      }
      const job = db.prepare(
        "INSERT INTO jobs(id,kind,params_json,state,progress,step_label,error,created_at,updated_at) VALUES(?,'ocr-data-download','{}',?,?,'sources.jobs.ocrData',?,?,?)",
      );
      if (name === "ocr-download-running")
        job.run("audit-ocr-job", "running", 0.5, null, now, now);
      if (name === "ocr-download-offline")
        job.run("audit-ocr-job", "failed", 0.5, "ocr-data-offline", now, now);
      if (name === "ocr-download-cancelled")
        job.run("audit-ocr-job", "cancelled", 0.5, null, now, now);
      if (name === "ocr-jobs-popover") {
        job.run("audit-ocr-job", "failed", 0.5, "ocr-data-offline", now, now);
        job.run(
          "audit-ocr-job-2",
          "failed",
          0.2,
          "ocr-data-too-big",
          now - 1,
          now - 1,
        );
        job.run(
          "audit-ocr-job-3",
          "failed",
          0.2,
          "ocr-data-integrity",
          now - 2,
          now - 2,
        );
      }
    });
  }
  if (name.startsWith("rebuild-")) {
    const states: Record<string, string> = {
      "rebuild-running": "running",
      "rebuild-failed": "failed",
      "rebuild-interrupted": "interrupted",
      "rebuild-review": "succeeded",
    };
    withDb((db) => {
      db.exec("DELETE FROM jobs WHERE kind = 'plan-rebuild'");
      const state = states[name];
      if (!state) return;
      const now = Date.now();
      // A reviewed result whose sources changed since: the dialog says so and offers to compare again.
      const rebuild = {
        tree: [
          {
            title: "Dinamica del punto materiale",
            summary: "Forze",
            subtopics: [],
            passageIds: ["audit-passage"],
            segmentIds: [],
          },
          {
            title: "Energia e lavoro",
            summary: "Lavoro",
            subtopics: [],
            passageIds: ["audit-passage"],
            segmentIds: [],
          },
        ],
        matches: [
          {
            oldId: "audit-topic",
            newIndex: 0,
            reason: "passages",
            score: 0.82,
          },
        ],
        archived: [],
        fingerprint: "changed-since-review",
      };
      db.prepare(
        "INSERT INTO jobs(id,kind,params_json,state,progress,error,created_at,updated_at) VALUES('audit-rebuild','plan-rebuild',?,?,?,?,?,?)",
      ).run(
        JSON.stringify({
          planId: "audit-plan",
          input: { title: "Fisica 1", sourceIds: ["audit-source"] },
          selection: { provider: "claude", model: "recorded-fixture" },
          ...(state === "succeeded" ? { rebuild } : {}),
        }),
        state,
        state === "succeeded" ? 1 : 0.4,
        state === "failed" ? "invalid-output" : null,
        now,
        now,
      );
    });
  }
}

// Steps 5 and 6 sit behind the material step. Continuing there with nothing picked leaves for the guided flow,
// so those states pick the seeded source first and show the classic wizard, not the guided page.
async function openWizard(page: Page, step: number) {
  await page
    .getByRole("textbox", { name: /Titolo|Title/, exact: true })
    .fill("Fisica audit");
  const current = (index: number) => page.locator(".ant-steps-item").nth(index);
  for (let at = 1; at < step; at++) {
    if (at === 4 && step > 4)
      await page.getByRole("button", { name: /^Appunti di fisica$/ }).click();
    await page
      .getByRole("button", { name: /Continua|Continue/, exact: true })
      .click();
    // One click per transition: wait for the next step before the next click.
    await expect(current(at)).toHaveClass(/ant-steps-item-process/);
  }
}

async function openGuided(
  page: Page,
  upTo: "period" | "modules" | "style" | "tree",
) {
  await page
    .getByRole("textbox", { name: /Titolo|Title/, exact: true })
    .fill("Fisica audit");
  const next = () =>
    page
      .getByRole("button", { name: /Continua|Continue/, exact: true })
      .click();
  // No material chosen: the last Continue of the wizard leads to the guided flow.
  for (let i = 0; i < 4; i++) await next();
  const periods = page.getByRole("group", { name: both("Periodo", "Period") });
  await expect(periods).toBeVisible();
  if (upTo === "period") return;
  await periods.getByRole("button").first().click();
  await next();
  await expect(page.getByRole("checkbox").first()).toBeVisible();
  if (upTo === "modules") return;
  await page.getByRole("checkbox").first().check();
  await next();
  await expect(
    page.getByRole("button", { name: /Continua|Continue/, exact: true }),
  ).toBeVisible();
  if (upTo === "style") return;
  await next();
  await expect(
    page
      .getByRole("textbox", { name: /Nome dell'argomento|Topic name/ })
      .first(),
  ).toBeVisible();
}

async function selectText(page: Page, selector: string) {
  const node = page.locator(selector).first();
  await expect(node).toBeVisible();
  await node.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await expect(
    page.getByRole("group", { name: both("Chiedi al tutor", "Ask the tutor") }),
  ).toBeVisible();
}

async function openState(page: Page, name: string) {
  const dialog = page.getByRole("dialog");
  const source = /^Appunti di fisica$/;
  switch (name) {
    case "wizard-1":
    case "wizard-2":
    case "wizard-3":
    case "wizard-4":
    case "wizard-5":
    case "wizard-6": {
      const step = Number(name.split("-")[1]);
      await expect(page.locator(".ant-steps-item").nth(step - 1)).toHaveClass(
        /ant-steps-item-process/,
      );
      const guide = page.getByRole("button", {
        name: both("Non ho materiale", "I have no material"),
      });
      // Material step with nothing picked offers the guided flow; later steps run only with a source, so they offer none.
      await expect(guide).toHaveCount(step === 4 ? 1 : 0);
      if (step === 5)
        await expect(
          page.getByRole("button", { name: both("Italiano", "English") }),
        ).toHaveCount(2);
      if (step === 6)
        await expect(
          page.getByRole("button", {
            name: both("Crea il piano", "Create the plan"),
          }),
        ).toBeVisible();
      await expect(page).toHaveURL(/#\/plans\/new$/);
      break;
    }
    case "import-review": {
      const before = await page.evaluate(() =>
        window.pyxis.invoke("plans.list", {}),
      );
      const file = await page.evaluate(() =>
        window.pyxis.invoke("plans.export", { planId: "audit-plan" }),
      );
      file.author = "Example author";
      await page
        .locator('input[type="file"]')
        .first()
        .setInputFiles({
          name: "review.pyxis",
          mimeType: "application/json",
          buffer: Buffer.from(JSON.stringify(file)),
        });
      await expect(page.locator(".px-import-review")).toBeVisible();
      const after = await page.evaluate(() =>
        window.pyxis.invoke("plans.list", {}),
      );
      expect(after).toHaveLength(before.length);
      break;
    }
    case "review-start":
      await expect(
        page.getByRole("button", {
          name: both("Inizia il ripasso", "Start review"),
        }),
      ).toBeVisible();
      break;
    case "review-building":
    case "review-failed":
    case "review-skipped":
    case "review-interrupted":
    case "review-cancelled":
      await expect(
        page.getByRole("button", {
          name: both("Scarta questo ripasso", "Discard this review"),
        }),
      ).toBeVisible();
      await expect(
        page.locator(".px-notice, [role='alert'], [role='status']").first(),
      ).toBeVisible();
      // A drill that can still block the finish offers going on without it; a skipped or cancelled one does not.
      await expect(
        page.getByRole("button", { name: both("Salta", "Skip") }),
      ).toHaveCount(
        name === "review-failed" || name === "review-interrupted" ? 1 : 0,
      );
      break;
    case "review-cards-waiting":
      await expect(
        page.getByRole("button", { name: both("Vedi lo stato", "See status") }),
      ).toBeVisible();
      break;
    case "progress-gap-misconception":
      await expect(
        page.getByText(/Confonde la massa con il peso/),
      ).toBeVisible();
      await expect(
        page.getByRole("button", {
          name: /^(Colma la lacuna|Work on this gap) ·/,
        }),
      ).toHaveCount(1);
      break;
    case "progress-gaps-distinct": {
      // Three gaps on one topic: each is listed on its own, with its own misconception, and each fill button is named apart.
      await expect(
        page.getByText(/Confonde la massa con il peso/),
      ).toBeVisible();
      await expect(
        page.getByText(/Applica la seconda legge a una sola forza/),
      ).toBeVisible();
      const fills = page.getByRole("button", {
        name: /^(Colma la lacuna|Work on this gap) ·/,
      });
      await expect(fills).toHaveCount(3);
      const names = await fills.evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute("aria-label")),
      );
      expect(new Set(names).size).toBe(3);
      await expect(
        page.getByText(
          /Non confrontato con le altre lacune|Not compared with this topic/,
        ),
      ).toHaveCount(1);
      break;
    }
    case "review-quiz-pending":
      await expect(
        page
          .getByRole("button", { name: both("Vedi lo stato", "See status") })
          .or(page.getByText(/in preparazione|being prepared/))
          .first(),
      ).toBeVisible();
      break;
    case "rebuild-intro":
    case "rebuild-running":
    case "rebuild-failed":
    case "rebuild-interrupted":
    case "rebuild-review":
      await page
        .getByRole("button", {
          name: both("Impostazioni del piano", "Plan settings"),
        })
        .click();
      await dialog
        .getByRole("button", {
          name: both("Ricostruisci gli argomenti", "Rebuild topics"),
          exact: true,
        })
        .click();
      // The rebuild dialog opens above the settings dialog.
      await expect(dialog).toHaveCount(2);
      await expect(
        dialog
          .last()
          .getByRole("heading", {
            name: both("Ricostruisci gli argomenti", "Rebuild topics"),
          })
          .or(
            dialog
              .last()
              .getByText(both("Ricostruisci gli argomenti", "Rebuild topics")),
          ),
      ).toBeVisible();
      await expect(dialog.last().getByText(/Caricamento|Loading/)).toHaveCount(
        0,
      );
      if (name === "rebuild-review")
        await expect(
          dialog
            .last()
            .getByText(
              /Il nuovo materiale lo chiama|The new material calls it/,
            ),
        ).toBeVisible();
      break;
    case "guided-period":
    case "guided-modules":
    case "guided-style":
    case "guided-tree":
      await openGuided(page, name.slice("guided-".length) as "period");
      break;
    case "ask-python":
      await expect(
        page.getByRole("textbox", {
          name: both("Codice Python", "Python code"),
        }),
      ).toHaveValue("print(6 * 7)");
      break;
    case "library-folder-capped": {
      const add = await openAddSources(page, both("Cartella", "Folder"));
      await add
        .getByRole("button", {
          name: both("Aggiungi una cartella", "Add a folder"),
        })
        .click();
      await expect(add.getByRole("checkbox")).toHaveCount(2);
      await expect(add.getByText(/12/).first()).toBeVisible();
      break;
    }
    case "library-flagged":
      await expect(
        page.getByText(
          /may be off syllabus|potrebbero? essere fuori programma/,
        ),
      ).toBeVisible();
      break;
    case "library-flagged-details":
      await page.getByRole("button", { name: source }).click();
      await expect(
        dialog.getByText(/look unrelated to|sembrano? non c'entrare con/),
      ).toBeVisible();
      break;
    case "selection-source":
      await page.evaluate(() =>
        window.dispatchEvent(
          new CustomEvent("pyxis:source-viewer", {
            detail: { passageId: "audit-passage" },
          }),
        ),
      );
      await selectText(page, ".source-viewer-paragraph p");
      break;
    case "selection-lesson":
      await selectText(page, ".passage .px-markdown p");
      break;
    case "lesson-rewrite":
      await page
        .getByRole("button", { name: both("Riscrivi", "Rewrite"), exact: true })
        .click();
      await expect(
        page.getByText(/Riscrivere questa lezione|Rewrite this lesson/),
      ).toBeVisible();
      break;
    case "lesson-flag":
      await page
        .getByRole("button", { name: both("Segnala", "Report"), exact: true })
        .click();
      await expect(
        page.getByRole("textbox", { name: /Cosa non va|What is wrong/ }),
      ).toBeVisible();
      break;
    case "quiz-setup":
      await expect(
        page.getByRole("slider", {
          name: /Numero di domande|Number of questions/,
        }),
      ).toBeVisible();
      break;
    case "quiz-page":
      await page
        .getByRole("button", { name: /^(Una pagina|One page)$/ })
        .click();
      await expect(page.getByRole("spinbutton")).toBeVisible();
      break;
    case "quiz-timed":
      await page
        .getByRole("checkbox", { name: /Imposta un limite|Set a time limit/ })
        .check();
      await expect(page.getByRole("spinbutton")).toBeVisible();
      break;
    case "jobs-popover":
      await page
        .getByRole("button", { name: /attività|background tasks|jobs running/ })
        .click();
      await expect(page.locator(".job-list")).toBeVisible();
      await expect(
        page.getByText(
          /Pyxis non riesce a leggere questa immagine|Pyxis cannot read this image/,
        ),
      ).toBeVisible();
      await expect(
        page.getByText(/troppi pixel|too many pixels/),
      ).toBeVisible();
      break;
    case "ocr-settings-missing":
      await expect(
        page.getByText(/Leggere le scansioni richiede|Reading scans needs/),
      ).toBeVisible();
      await expect(page.getByText(/raw\.githubusercontent\.com/)).toBeVisible();
      await expect(
        page.getByRole("button", { name: /^(Scarica|Download) [\d.,]+ MB$/ }),
      ).toBeVisible();
      break;
    case "ocr-settings-integrity":
      await expect(
        page.getByText(/danneggiati o incompleti|damaged or incomplete/),
      ).toBeVisible();
      await expect(
        page.getByRole("button", {
          name: /^(Scarica di nuovo|Download again)/,
        }),
      ).toBeVisible();
      break;
    case "ocr-settings-ready":
      await expect(
        page.getByText(
          /La lettura delle scansioni è pronta|Scan reading is ready/,
        ),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: /Scarica|Download/ }),
      ).toHaveCount(0);
      break;
    case "ocr-download-running":
      await expect(
        page.getByRole("progressbar", {
          name: /Scarico i dati|Download scan-reading data/,
        }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", {
          name: /Annulla il download|Cancel download/,
        }),
      ).toBeVisible();
      break;
    case "ocr-download-offline":
      await expect(
        page.getByText(/non è riuscito a raggiungere raw|could not reach raw/),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: /^(Riprova|Try again)$/ }),
      ).toBeVisible();
      break;
    case "ocr-download-cancelled":
      await expect(
        page.getByText(/download è stato annullato|download was cancelled/),
      ).toBeVisible();
      break;
    case "ocr-jobs-popover":
      await page
        .getByRole("button", { name: /attività|background tasks|jobs running/ })
        .click();
      await expect(page.locator(".job-list")).toBeVisible();
      await expect(
        page.getByText(/non è riuscito a raggiungere raw|could not reach raw/),
      ).toBeVisible();
      await expect(
        page.getByText(/più grande del previsto|larger than expected/),
      ).toBeVisible();
      await expect(
        page.getByText(
          /non corrispondeva al suo checksum|did not match its checksum/,
        ),
      ).toBeVisible();
      break;
    case "library-scan-no-file": {
      await expect(
        page.getByText(/non ha più il file|no longer has the file to read/),
      ).toBeVisible();
      await expect(
        page.getByRole("button", {
          name: both("Leggi la scansione", "Read the scan"),
        }),
      ).toHaveCount(0);
      await expect(
        page
          .getByRole("button", { name: /^(Sostituisci il file|Replace file)$/ })
          .first(),
      ).toBeVisible();
      // Core refuses it too, with the plain message, and never queues it.
      const refusal = await page.evaluate(() =>
        window.pyxis.invoke("sources.ocr", { sourceId: "audit-scan" }).then(
          () => "queued",
          (error: { messageKey?: string; message?: string }) =>
            error.messageKey ?? error.message ?? "failed",
        ),
      );
      expect(refusal).toBe("sources.fileMissing");
      const row = await page.evaluate(() =>
        window.pyxis
          .invoke("sources.list", {})
          .then((rows) => rows.find((r) => r.id === "audit-scan")?.status),
      );
      expect(row).toBe("needs-ocr");
      break;
    }
    case "shell-exam-active":
      await expect(
        page.getByRole("button", {
          name: both("Riprendi l’esame", "Resume the exam"),
        }),
      ).toBeVisible();
      break;
    case "library-ocr-refused":
    case "library-ocr-ready":
      await page
        .getByRole("button", {
          name: both("Leggi la scansione", "Read the scan"),
        })
        .click();
      await expect(
        page.getByText(
          /Per leggere questo file Pyxis ha bisogno|Pyxis needs its scan-reading data/,
        ),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: /^(Scarica|Download) [\d.,]+ MB$/ }),
      ).toBeVisible();
      // A refused read is not left looking queued.
      await expect(page.getByText(/OCR in coda|OCR is queued/)).toHaveCount(0);
      if (name === "library-ocr-ready") {
        // The files appear on disk (as if another window had finished the download); Download then finds them ready.
        stageOcrData();
        await page
          .getByRole("button", { name: /^(Scarica|Download) [\d.,]+ MB$/ })
          .click();
        await expect(
          page.getByRole("button", {
            name: both("Leggi la scansione", "Read the scan"),
          }),
        ).toHaveCount(2);
      }
      break;
    case "ask-ocr-refused":
    case "ask-ocr-ready": {
      const photo = join(auditUserData, "foto.png");
      writeFileSync(photo, tinyPng);
      // The photo goes through the same native picker and grant as a real attachment; the seam answers with this one file.
      await auditApp!.evaluate((_, path) => {
        process.env.PYXIS_E2E_FILE = path;
      }, photo);
      await page
        .getByRole("button", {
          name: both("Allega file o immagine", "Attach file or image"),
        })
        .click();
      await auditApp!.evaluate((_, path) => {
        process.env.PYXIS_E2E_FILE = path;
      }, auditPicked);
      await expect(page.getByText("foto.png")).toBeVisible();
      await page
        .getByRole("textbox", { name: both("Messaggio", "Message") })
        .fill("Che cosa c'è scritto qui?");
      await page.getByRole("button", { name: both("Invia", "Send") }).click();
      await expect(
        page.getByText(
          /Per leggere questo file Pyxis ha bisogno|Pyxis needs its scan-reading data/,
        ),
      ).toBeVisible();
      // The message and the photo are still in the composer, and nothing was sent.
      await expect(
        page.getByRole("textbox", { name: both("Messaggio", "Message") }),
      ).toHaveValue("Che cosa c'è scritto qui?");
      await expect(page.getByText("foto.png")).toBeVisible();
      if (name === "ask-ocr-ready") {
        // The files appear on disk (as if another window had finished the download); Download then finds them ready.
        stageOcrData();
        await page
          .getByRole("button", { name: /^(Scarica|Download) [\d.,]+ MB$/ })
          .click();
        await expect(
          page.getByRole("button", {
            name: both("Invia di nuovo", "Send again"),
          }),
        ).toBeVisible();
      }
      break;
    }
    case "provider-disclosure":
      await page.evaluate(() => {
        void window.pyxis
          .invoke("engines.test", {
            provider: "claude",
            model: "claude-sonnet-5-5",
          })
          .catch(() => undefined);
      });
      await expect(
        page.getByRole("dialog", { name: "Anthropic", exact: true }),
      ).toBeVisible();
      break;
    case "quiz-grading-failed":
      await expect(
        page.getByRole("button", {
          name: /Riprova la correzione|Retry grading/,
        }),
      ).toBeVisible();
      break;
    case "simulation-ready":
      await expect(
        page.getByRole("button", {
          name: /Inizia la prova|Start exam/,
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        page.getByRole("heading", {
          name: /La prova è pronta|Your exam is ready/,
        }),
      ).toBeVisible();
      break;
    case "simulation-grading-failed":
      await expect(
        page.getByRole("button", { name: /Chiudi|Close/, exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: /Indietro|Back/, exact: true }),
      ).toBeVisible();
      break;
    case "reading-large-lesson":
    case "reading-large-progress": {
      await page.evaluate(() =>
        window.pyxis.invoke("profile.save", {
          dyslexia: false,
          textSize: "md",
        }),
      );
      await page.reload();
      await expect(page.locator("html")).toHaveAttribute("data-text", "md");
      const textSelectors =
        name === "reading-large-lesson"
          ? [".passage .px-markdown p"]
          : [".px-plan-progress .title-3", ".px-plan-progress .body-strong"];
      const mediumSizes: number[] = [];
      for (const selector of textSelectors) {
        const text = page.locator(selector).first();
        await expect(text).toBeVisible();
        mediumSizes.push(
          await text.evaluate((element) =>
            Number.parseFloat(getComputedStyle(element).fontSize),
          ),
        );
      }
      await page.evaluate(() =>
        window.pyxis.invoke("profile.save", { dyslexia: true, textSize: "lg" }),
      );
      await page.reload();
      await expect(page.locator("html")).toHaveAttribute("data-dyslexia", "on");
      await expect(page.locator("html")).toHaveAttribute("data-text", "lg");
      for (const [index, selector] of textSelectors.entries()) {
        const text = page.locator(selector).first();
        await expect(text).toBeVisible();
        const largeSize = await text.evaluate((element) =>
          Number.parseFloat(getComputedStyle(element).fontSize),
        );
        expect(
          largeSize,
          `${name}: ${selector} follows the text preference`,
        ).toBeCloseTo(mediumSizes[index]! * 1.12, 2);
      }
      break;
    }
    case "library-row-menu":
      await page
        .getByRole("button", {
          name: /^(Azioni per|Actions for) Appunti di fisica$/,
        })
        .click();
      await expect(page.getByRole("menuitem").first()).toBeVisible();
      break;
    case "library-vision":
      await page
        .getByRole("button", { name: "Photo notes", exact: true })
        .click();
      await expect(dialog).toContainText("vision-fixture-model");
      break;
    case "library-details":
      await page.getByRole("button", { name: source }).click();
      await expect(dialog).toBeVisible();
      await expect(
        dialog.getByRole("button", { name: both("Rinomina", "Rename") }),
      ).toBeVisible();
      break;
    case "library-folder": {
      const add = await openAddSources(page, both("Cartella", "Folder"));
      await add
        .getByRole("button", {
          name: both("Aggiungi una cartella", "Add a folder"),
        })
        .click();
      await expect(add.getByRole("checkbox")).toHaveCount(2);
      break;
    }
    case "library-link": {
      const add = await openAddSources(page, both("Link", "Link"));
      await add
        .getByRole("textbox", { name: both("Aggiungi un link", "Add a link") })
        .fill("https://example.org/fisica");
      await expect(
        add.getByRole("button", {
          name: both("Anteprima del link", "Preview link"),
        }),
      ).toBeEnabled();
      await expect(
        add.getByRole("button", { name: both("Salva link", "Save link") }),
      ).toBeDisabled();
      break;
    }
    case "library-text":
    case "library-text-ready": {
      const add = await openAddSources(page, both("Testo", "Text"));
      await add
        .getByRole("textbox", { name: both("Titolo", "Title") })
        .fill("Dinamica");
      const long = name === "library-text-ready";
      await add
        .getByRole("textbox", {
          name: both("Incolla gli appunti", "Paste notes"),
        })
        .fill(
          long
            ? "La forza è massa per accelerazione. ".repeat(45)
            : "La forza è massa per accelerazione.",
        );
      await expect(
        add.getByRole("button", {
          name: both("Incolla gli appunti", "Paste notes"),
        }),
      ).toBeEnabled({ enabled: long });
      break;
    }
    case "source-viewer":
      await page.evaluate(() =>
        window.dispatchEvent(
          new CustomEvent("pyxis:source-viewer", {
            detail: { passageId: "audit-passage" },
          }),
        ),
      );
      await expect(dialog.getByText(/La forza è il prodotto/)).toBeVisible();
      break;
    case "engine-details":
      await openAdvancedEngines(page);
      await page
        .getByRole("button", { name: /^(Dettagli di|Details for) / })
        .first()
        .click();
      await expect(dialog).toBeVisible();
      break;
    case "engine-details-disabled":
      await openAdvancedEngines(page);
      await page
        .getByRole("button", {
          name: /^(Dettagli di|Details for) .*(Antigravity)/i,
        })
        .click();
      await expect(dialog).toBeVisible();
      break;
    case "engine-add-cli":
      await openAdvancedEngines(page);
      await page
        .getByRole("button", { name: both("Aggiungi motore", "Add engine") })
        .click();
      await expect(dialog.getByRole("tab", { selected: true })).toBeVisible();
      break;
    case "engine-add-key":
      await openAdvancedEngines(page);
      await page
        .getByRole("button", { name: both("Aggiungi motore", "Add engine") })
        .click();
      await dialog
        .getByRole("tab", { name: both("Chiave API", "API key") })
        .click();
      await expect(
        dialog.getByRole("tab", {
          name: both("Chiave API", "API key"),
          selected: true,
        }),
      ).toBeVisible();
      break;
    case "progress-simulations":
      await page
        .getByRole("radio", { name: both("Simulazioni", "Simulations") })
        .locator("..")
        .click();
      await expect(page.getByRole("table")).toBeVisible();
      await expect(
        page.getByRole("button", {
          name: /^(Apri la prova del|Open exam from) /,
        }),
      ).toBeVisible();
      break;
    case "progress-pace":
      await page
        .getByRole("radio", { name: both("Ritmo", "Pace") })
        .locator("..")
        .click();
      await expect(
        page.getByRole("heading", { name: both("Ritmo", "Pace"), level: 2 }),
      ).toBeVisible();
      break;
    case "export-lesson":
    case "export-cards":
    case "export-simulation":
      await openExport(page);
      break;
    case "export-plan":
    case "export-plan-embed":
      await page
        .getByRole("button", {
          name: both("Impostazioni del piano", "Plan settings"),
        })
        .click();
      await openExport(page);
      if (name === "export-plan-embed") {
        await dialog
          .last()
          .getByRole("checkbox", {
            name: both(
              "Includi i file delle fonti",
              "Include the source files",
            ),
          })
          .check();
        await expect(dialog.last().getByText(/copyright/i)).toBeVisible();
      }
      break;
  }
}

async function keyboardCheck(page: Page, name: string) {
  const dialogOpen = (await page.getByRole("dialog").count()) > 0;
  const surface = dialogOpen ? page.getByRole("dialog").last() : page;
  const controls = surface.locator(
    'button:visible:not([disabled]),input:visible:not([disabled]),textarea:visible:not([disabled]),select:visible:not([disabled]),[tabindex="0"]:visible',
  );
  const first = controls.first();
  await first.focus();
  await expect(first).toBeFocused();
  await page.keyboard.press("Tab");
  const readNext = () =>
    page.evaluate(() => {
      const focused = document.activeElement;
      // Ant Design radios focus a native zero-width input inside a visible label.
      const visible =
        focused?.closest("label,button,a,[role='button'],[role='radio']") ??
        focused;
      return {
        tag: focused?.tagName,
        hidden:
          visible instanceof HTMLElement
            ? visible.getBoundingClientRect().width === 0
            : true,
      };
    });
  let next = await readNext();
  // A dialog whose only control is its close button has no later stop. Tab
  // leaves the page for the window boundary (BODY) and the focus lock pulls
  // the next Tab back, so that return is what proves the dialog traps focus.
  if (dialogOpen && next.tag === "BODY" && (await controls.count()) === 1) {
    await page.keyboard.press("Tab");
    await expect(
      first,
      `${name}: Tab past the only control returns to the dialog`,
    ).toBeFocused();
    next = await readNext();
  }
  expect(next.tag, `${name}: Tab should reach a control`).not.toBe("BODY");
  expect(next.hidden, `${name}: focus should remain visible`).toBe(false);
  const readFocus = () =>
    page.evaluate(() => {
      const element = document.activeElement;
      const visible =
        element?.closest(
          ".ant-select,.ant-radio-wrapper,.ant-checkbox-wrapper,.ant-input-affix-wrapper,label,button,a,[role='button'],[role='radio']",
        ) ?? element;
      const rect = visible?.getBoundingClientRect();
      return {
        id: Array.from(document.querySelectorAll("*")).indexOf(element!),
        tag: element?.tagName,
        html: element?.outerHTML.slice(0, 400),
        visible: Boolean(rect && rect.width > 0 && rect.height > 0),
        modal: Boolean(element?.closest("[role='dialog']")),
      };
    });
  const seen = new Set<number>();
  for (let tab = 0; tab < 100; tab++) {
    let focus = await readFocus();
    // The native window boundary ends the document's tab sequence.
    if (focus.tag === "BODY") {
      await first.focus();
      break;
    }
    expect(
      focus.visible,
      `${name}: every Tab stop is visible ${focus.html}`,
    ).toBe(true);
    if (await page.getByRole("dialog").count())
      expect(focus.modal, `${name}: dialog traps keyboard focus`).toBe(true);
    if (seen.has(focus.id)) break;
    seen.add(focus.id);
    expect(tab, `${name}: keyboard traversal must cycle`).toBeLessThan(99);
    await page.keyboard.press("Tab");
  }
  if (name === "ask-thread") {
    const code = page.locator("pre.px-code-pre");
    await code.focus();
    await expect(
      code,
      "ask-thread: scrollable code is focusable",
    ).toBeFocused();
    expect(
      await code.evaluate((el) => el.scrollWidth > el.clientWidth),
      "ask-thread: fixture code block must overflow",
    ).toBe(true);
    await expect(code).toHaveCSS("outline-style", "solid");
  }
  if (name === "quiz") {
    const first = page.locator("button[aria-keyshortcuts='1']");
    const second = page.locator("button[aria-keyshortcuts='2']");
    await first.focus();
    await page.keyboard.press("2");
    await expect(second).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("1");
    await expect(first).toHaveAttribute("aria-pressed", "true");
    await expect(second).toHaveAttribute("aria-pressed", "false");
  }
  if (name === "practice") {
    const reveal = page
      .getByRole("button", { name: /Mostra la soluzione|Show the solution/ })
      .first();
    await reveal.focus();
    await page.keyboard.press("Enter");
  }
  if (name === "cards") {
    const flip = page.getByRole("button", { name: /Gira|Flip/ }).first();
    if (await flip.count()) {
      await flip.focus();
      await page.keyboard.press("Enter");
    }
  }
  if (name === "quiz") {
    const choice = page.locator(".choice").first();
    await choice.focus();
    await page.keyboard.press("Space");
    await expect(choice).toHaveAttribute("aria-pressed", "true");
  }
  if (name === "graph") {
    const input = page.getByRole("textbox");
    await input.focus();
    await input.fill("x^2");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
  }
  if (name === "map") {
    const node = page.locator(".react-flow__node").first();
    await node.focus();
    await page.keyboard.press("Enter");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  }
}

test("M14 every application route in both languages, themes and supported widths", async () => {
  test.setTimeout(1500000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-ui-audit-"));
  auditUserData = userData;
  // The e2e seam answers every native picker with this path: a folder of two importable files for the Folder tab.
  const importFolder = mkdtempSync(join(tmpdir(), "pyxis-ui-audit-folder-"));
  writeFileSync(
    join(importFolder, "appunti.txt"),
    "La forza è massa per accelerazione.",
  );
  writeFileSync(join(importFolder, "formule.md"), "# Formule\n\n$F=ma$");
  // Deeper than the folder scan reads: a warning says some files were not looked at, the two above still list.
  const deep = join(
    importFolder,
    ...Array.from({ length: 14 }, (_, i) => `livello-${i}`),
  );
  mkdirSync(deep, { recursive: true });
  writeFileSync(join(deep, "profondo.txt"), "Troppo in fondo.");
  const env = {
    ...process.env,
    PYXIS_USER_DATA: userData,
    PYXIS_E2E: "1",
    PYXIS_E2E_FILE: importFolder,
    PYXIS_E2E_REPLY: "La forza è $F=ma$ [P1].",
    PYXIS_E2E_PLAN_REPLIES: JSON.stringify({
      modules: {
        modules: [
          { title: "Cinematica", summary: "Il moto dei corpi" },
          { title: "Dinamica", summary: "Le forze" },
        ],
      },
      topics: {
        topics: [
          {
            title: "Cinematica del punto",
            summary: "Moto",
            subtopics: ["Velocità"],
          },
          { title: "Dinamica", summary: "Forze", subtopics: [] },
        ],
      },
      markdown: {
        markdown: "# La dinamica\n\nLa seconda legge di Newton è $F=ma$ [P1].",
      },
    }),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    args: [
      join(process.cwd(), process.env.PYXIS_OUT ?? "out", "main/index.js"),
    ],
    env,
  });
  auditApp = app;
  auditPicked = importFolder;
  const records: unknown[] = [];
  const failures: string[] = [];
  const selectedStates = process.env.PYXIS_UI_STATES?.split(",");
  // PYXIS_UI_RECORD keeps a focused run from overwriting another run's record.
  const recordFile =
    process.env.PYXIS_UI_RECORD ??
    (selectedStates
      ? ".tmp/m14-ui-audit-filter.json"
      : process.env.PYXIS_UI_LARGE
        ? ".tmp/m14-ui-audit-large.json"
        : ".tmp/m14-ui-audit.json");
  const auditRoutes = selectedStates
    ? routes.filter(([name]) => selectedStates.includes(name))
    : routes;
  expect(auditRoutes.length).toBeGreaterThan(0);
  mkdirSync(".shots/m14", { recursive: true });
  mkdirSync(".tmp", { recursive: true });
  mkdirSync(dirname(recordFile), { recursive: true });
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(7000);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByRole("button", { name: "Salta" }).click();
    await page.evaluate(() => window.pyxis.invoke("plans.list", {}));
    await page.evaluate(() =>
      sessionStorage.setItem(
        "pyxis-board",
        JSON.stringify([
          {
            width: 4,
            points: [
              { x: 200, y: 450 },
              { x: 420, y: 160 },
              { x: 680, y: 450 },
            ],
          },
        ]),
      ),
    );
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), {
      timeout: 10000,
    });
    seed(db);
    db.close();
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    for (const language of ["it", "en"] as const)
      for (const theme of ["dark", "light"] as const)
        for (const width of [1280, 960]) {
          if (
            process.env.PYXIS_UI_COMBO &&
            process.env.PYXIS_UI_COMBO !== `${language}-${theme}-${width}`
          )
            continue;
          await page.evaluate(
            async ({ language, theme }) => {
              localStorage.setItem("pyxis.lang", language);
              await window.pyxis.setAppearance(theme);
            },
            { language, theme },
          );
          await page.setViewportSize({ width, height: 800 });
          await page.evaluate(
            (textSize: "md" | "lg") =>
              window.pyxis.invoke("profile.save", {
                dyslexia: false,
                textSize,
              }),
            process.env.PYXIS_UI_LARGE ? "lg" : "md",
          );
          for (const [name, route] of auditRoutes) {
            const key = `${name}-${language}-${theme}-${width}${process.env.PYXIS_UI_LARGE ? "-large" : ""}`;
            const before = pageErrors.length;
            try {
              prepareState(name);
              await page.evaluate((route) => {
                location.hash = route;
              }, route);
              await page.reload();
              await expect(page.locator("h1:visible").first()).toBeVisible();
              if (name.startsWith("wizard-"))
                await openWizard(page, Number(name.split("-")[1]));
              if (name === "library-import")
                await page
                  .getByRole("button", {
                    name: /Aggiungi fonti|Add sources/,
                    exact: true,
                  })
                  .click();
              if (name === "plan-settings")
                await page
                  .getByRole("button", {
                    name: /Impostazioni del piano|Plan settings/,
                    exact: true,
                  })
                  .click();
              if (name === "plan-create")
                await page
                  .getByRole("button", {
                    name: /Crea lezione|Create lesson/,
                    exact: true,
                  })
                  .click();
              await openState(page, name);
              if (name === "diagnostic") {
                await page
                  .getByRole("button", { name: /Inizia|Start/, exact: true })
                  .click();
                await expect(page.locator(".px-quiz-question")).toBeVisible();
              }
              if (name === "lesson")
                await expect(
                  page.getByText("La dinamica", { exact: true }),
                ).toBeVisible();
              if (name === "map")
                await expect(page.locator(".react-flow__node")).toHaveCount(3);
              if (name === "ask-thread")
                await expect(
                  page.getByText("Come calcolo la forza?", { exact: true }),
                ).toBeVisible();
              await page.evaluate(() => document.fonts.ready);
              await expect(page.locator(".ant-segmented-thumb")).toHaveCount(0);
              await keyboardCheck(page, name);
              // Tabbing beyond a dropdown closes it. Reopen it for visual/axe checks.
              if (
                name === "library-row-menu" &&
                !(await page.getByRole("menuitem").first().isVisible())
              )
                await openState(page, name);
              // Moving focus can clear a text selection, and the menu goes with it.
              if (name.startsWith("selection-")) await openState(page, name);
              await page.evaluate(
                () =>
                  new Promise<void>((resolve) =>
                    requestAnimationFrame(() =>
                      requestAnimationFrame(() => resolve()),
                    ),
                  ),
              );
              const violations = (
                await new AxeBuilder({ page }).setLegacyMode(true).analyze()
              ).violations;
              await page.screenshot({
                path: `.shots/m14/${key}.png`,
                fullPage: true,
                animations: "disabled",
              });
              // Fixed headers and modal backdrops are viewport-bound; keep a real viewport capture alongside the full-page image.
              await page.screenshot({
                path: `.shots/m14/${key}.viewport.png`,
                fullPage: false,
                animations: "disabled",
              });
              if (name === "provider-disclosure")
                await page.evaluate(() =>
                  window.pyxis.invoke("engines.disclosureCancel", {
                    provider: "claude",
                  }),
                );
              if (name === "provider-disclosure")
                await expect(
                  page.getByRole("dialog", { name: "Anthropic", exact: true }),
                ).toHaveCount(0);
              const errors = pageErrors.slice(before);
              const untranslated = (
                await page.locator("body").innerText()
              ).match(untranslatedKey);
              if (untranslated)
                errors.push(
                  `Untranslated labels: ${[...new Set(untranslated)].join(", ")}`,
                );
              const overflow = await page.evaluate(
                () => document.documentElement.scrollWidth > innerWidth + 1,
              );
              records.push({
                name,
                route,
                language,
                theme,
                width,
                violations: violations.map((v) => ({
                  id: v.id,
                  impact: v.impact,
                  description: v.description,
                  nodes: v.nodes.map((n) => ({
                    target: n.target,
                    summary: n.failureSummary,
                    html: n.html,
                  })),
                })),
                errors,
                overflow,
              });
              if (violations.length || errors.length || overflow)
                failures.push(
                  `${key}: ${violations.map((v) => v.id).join(",")} ${errors.join(";")} ${overflow ? "horizontal overflow" : ""}`,
                );
            } catch (error) {
              if (name === "provider-disclosure")
                await page
                  .evaluate(() =>
                    window.pyxis.invoke("engines.disclosureCancel", {
                      provider: "claude",
                    }),
                  )
                  .catch(() => undefined);
              failures.push(`${key}: ${String(error).slice(0, 900)}`);
              records.push({
                name,
                route,
                language,
                theme,
                width,
                failed: String(error),
              });
            }
            writeFileSync(
              recordFile,
              JSON.stringify({ routes, records, failures }, null, 2),
            );
            console.log(
              `M14 ${key}: ${failures.at(-1)?.startsWith(key) ? failures.at(-1) : "passed"}`,
            );
          }
        }
  } finally {
    writeFileSync(
      recordFile,
      JSON.stringify(
        {
          routes,
          excluded: ["/print, covered by isolated native PDF export test"],
          records,
          failures,
        },
        null,
        2,
      ),
    );
    await app.close();
    rmSync(userData, { recursive: true, force: true });
    rmSync(importFolder, { recursive: true, force: true });
  }
  expect(failures, failures.join("\n")).toEqual([]);
});
