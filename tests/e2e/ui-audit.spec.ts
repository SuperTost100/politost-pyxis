import { axeViolations } from "./axe";
import {
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
import { launchPyxis } from "./app-under-test";
import { seedPlan, seedSource, seedSubjects } from "./seed";
import { saveShot } from "./shots";

// Native Electron is required: these routes consume the utility-process IPC port.
const routes = [
  ["root", "/"],
  ["onboarding", "/onboarding"],
  ["onboarding-again", "/onboarding?again=1"],
  ["ask-new", "/ask"],
  ["ask-thread", "/ask/audit-chat"],
  ["exams", "/exams"],
  ["exams-empty", "/exams"],
  ["exams-import-menu", "/exams"],
  ["library", "/exams/library"],
  // The Library with no sources: the empty state and its two ways in, no search or filters.
  ["library-empty", "/exams/library"],
  // Passage search: the same field with the Content scope, its results and the local model offer.
  ["library-search", "/exams/library"],
  // The flashcard browser: cards grouped by subject, no cards at all, a search with no match, and its two dialogs.
  ["cards-browser", "/exams/cards"],
  ["cards-browser-empty", "/exams/cards"],
  ["cards-browser-none", "/exams/cards"],
  ["cards-browser-edit", "/exams/cards"],
  ["cards-browser-delete", "/exams/cards"],
  // The mistakes notebook, which lives only under Exams.
  ["mistakes", "/exams/mistakes"],
  // Oggi's flashcards from every plan, and the session planner (the fixture's one plan has no exam date).
  ["cards-due", "/cards/due"],
  ["planner", "/exams/planner"],
  ["library-vision", "/exams/library"],
  ["shared", "/exams/get"],
  ["import-review", "/exams/get"],
  ["settings", "/settings"],
  ...[
    "profile",
    "engines",
    "tutor",
    "reading",
    "flashcards",
    "reminders",
    "appearance",
    "language",
    "data",
    "privacy",
    "updates",
    "about",
    "diagnostics",
  ].map((section) => [`settings-${section}`, `/settings/${section}`] as const),
  ["gallery", "/dev/gallery"],
  ...[1, 2].map((step) => [`wizard-${step}`, "/plans/new"] as const),
  ["plan", "/plans/audit-plan"],
  ["plan-dated", "/plans/audit-ready-plan"],
  // The same exam with hours set in the planner: its topic and simulation rows carry expected days.
  ["plan-dated-planner", "/plans/audit-ready-plan"],
  // The exam page with its finished steps listed, and with the Now card's other activities open.
  ["plan-done", "/plans/audit-plan"],
  ["plan-chooser", "/plans/audit-plan"],
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
  // The source details panel on a PDF whose scanned pages OCR read, and on a scan being read now.
  ["library-panel-pdf", "/exams/library"],
  ["library-panel-scan", "/exams/library"],
  // A source removed after the list was read: the panel says it is gone instead of staying blank.
  ["library-panel-removed", "/exams/library"],
  // The same from an exam's Sources tab: the row leaves the tab, and closing the panel puts focus on the page heading.
  ["plan-sources-removed", "/plans/audit-plan/sources"],
  // A source saved from a link says where and when it was saved.
  ["library-panel-link", "/exams/library"],
  // An exam's Sources tab opens the same panel; Escape closes it and focus goes back to the row.
  ["plan-sources-panel", "/plans/audit-plan/sources"],
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
  ["practice-rated", "/plans/audit-plan/practice/audit-topic"],
  ["practice-review", "/plans/audit-plan/practice/audit-topic?review=1"],
  ["lesson", "/plans/audit-plan/lesson/audit-topic"],
  ["lesson-rewrite", "/plans/audit-plan/lesson/audit-topic"],
  ["lesson-menu", "/plans/audit-plan/lesson/audit-topic"],
  ["intro", "/plans/audit-plan/intro"],
  ["quiz-setup", "/plans/audit-plan/quiz/audit-topic"],
  ["quiz-page", "/plans/audit-plan/quiz/audit-topic"],
  ["quiz-timed", "/plans/audit-plan/quiz/audit-topic"],
  ["diagnostic", "/plans/audit-plan/diagnostic"],
  ["quiz", "/plans/audit-plan/quiz/audit-topic?attempt=audit-quiz-attempt"],
  // A quiz handed in earlier, reopened from its step on the path: read-only, with Redo.
  [
    "quiz-review",
    "/plans/audit-plan/quiz/audit-topic?attempt=audit-quiz-done-attempt",
  ],
  ["cards", "/plans/audit-plan/cards/audit-topic"],
  ["simulation-setup", "/plans/audit-plan/simulation"],
  ["simulation-ready", "/plans/audit-ready-plan/simulation"],
  ["simulation-result", "/plans/audit-plan/exam/audit-exam-attempt"],
  ["map", "/plans/audit-plan/map/audit-topic"],
  // The Maps section: maps by subject, no map at all, a search with no match, the new-map dialog, and a map opened from it with its export menu.
  ["maps", "/maps"],
  ["maps-empty", "/maps"],
  ["maps-none", "/maps"],
  ["maps-new", "/maps"],
  ["map-export", "/plans/audit-plan/map/audit-topic?from=maps&map=audit-map-entry"],
  ["whiteboard", "/tools/whiteboard"],
  ["graph", "/tools/graph"],
  ["python", "/tools/python"],
  ["jobs-popover", "/exams"],
  [
    "quiz-grading-failed",
    "/plans/audit-plan/quiz/audit-topic?attempt=audit-grading-attempt",
  ],
  ["simulation-grading-failed", "/plans/audit-plan/exam/audit-frozen-attempt"],
  // The results screen with what the exam changed in the path, and while grading runs.
  ["simulation-result-changes", "/plans/audit-ready-plan/exam/audit-results-attempt"],
  ["simulation-grading", "/plans/audit-plan/exam/audit-live-attempt"],
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
  // Automatic backups in Settings > Data: on after a backup, off, and a failed backup with its fix.
  ["backup-settings-on", "/settings/data"],
  ["backup-settings-off", "/settings/data"],
  ["backup-settings-failed", "/settings/data"],
  // A scan with no stored file offers Replace instead of a read that cannot run. A timed exam in progress adds Resume to every Shell page.
  ["library-scan-no-file", "/exams/library"],
  // A free book with a newer version in the catalog: the Library row and the books list offer the update.
  ["library-book-update", "/exams/library"],
  ["library-books-update", "/exams/library"],
  ["shell-exam-active", "/exams"],
  ["library-ocr-refused", "/exams/library"],
  ["library-ocr-ready", "/exams/library"],
  ["ask-ocr-refused", "/ask"],
  ["ask-ocr-ready", "/ask"],
  // The chat panel, the composer's subject menu and its sources popover.
  ["ask-panel", "/ask/audit-chat"],
  ["ask-search", "/ask/audit-chat"],
  ["ask-search-empty", "/ask/audit-chat"],
  ["ask-subject-menu", "/ask/audit-chat"],
  ["ask-sources-menu", "/ask/audit-chat"],
  // The formula keyboard docked in the composer, with a formula already typed.
  ["ask-formula", "/ask/audit-chat"],
  // Help > Keyboard shortcuts, opened through the application menu.
  ["shortcuts-dialog", "/exams"],
  // Download and install from Settings: offered, in progress, checked and replaced, and a checksum that does not match.
  ["updates-available", "/settings/updates"],
  ["updates-downloading", "/settings/updates"],
  ["updates-verified", "/settings/updates"],
  ["updates-failed", "/settings/updates"],
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
  seedSubjects(db, [{ id: "audit-subject", name: "Fisica" }]);
  seedSource(db, {
    id: "audit-source",
    title: "Appunti di fisica",
    document: { id: "audit-document" },
    passages: [
      {
        id: "audit-passage",
        text: "La forza è il prodotto di massa e accelerazione.",
        locator: { chapter: 1, paragraph: "p1" },
        section: "1. Dinamica",
      },
    ],
  });
  db.exec(`INSERT INTO smartbooks(id,source_id,meta_json,created_at) VALUES('audit-book','audit-source','{"title":"Fisica","chapters":[]}',1);
    INSERT INTO exercises(id,smartbook_id,passage_id,prompt,answer,locator_json,grounding,created_at) VALUES('audit-exercise','audit-book','audit-passage','Calcola la forza per $m=2$ kg e $a=3$ m/s².','$F=ma=6$ N','{"chapter":1,"kind":"esame"}','sources',1);`);
  seedPlan(db, {
    id: "audit-plan",
    subjectId: "audit-subject",
    title: "Fisica 1",
    language: "it",
    target: 0.75,
    sourceIds: ["audit-source"],
    topics: [{ id: "audit-topic", title: "Dinamica" }],
  });
  db.exec(`INSERT INTO topic_passages(topic_id,passage_id) VALUES('audit-topic','audit-passage');
    INSERT INTO cards(id,plan_id,topic_id,front,back,passage_id,grounding,created_at) VALUES('audit-card','audit-plan','audit-topic','Qual è la seconda legge di Newton?','$F=ma$. La forza è proporzionale alla massa.','audit-passage','sources',1);
    INSERT INTO chats(id,title,subject,created_at,updated_at) VALUES('audit-chat','Seconda legge di Newton','Fisica',1,2);
    INSERT INTO messages(id,chat_id,role,body,created_at) VALUES('audit-user','audit-chat','user','Come calcolo la forza?',1);
    INSERT INTO items(id,plan_id,kind,body_json,created_at) VALUES('audit-intro','audit-plan','intro','{"markdown":"Benvenuto in **Fisica 1**: studierai le forze e il moto.\\n\\n\`\`\`pyxis-check\\n{\\"question\\": \\"Che cosa cambia una forza?\\", \\"options\\": [\\"Il moto\\", \\"Il colore\\"], \\"answer\\": 0}\\n\`\`\`","passageIds":[]}',1);
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
    "INSERT INTO attempts(id,plan_id,item_id,started_at,submitted_at) VALUES(?,'audit-plan',?,?,?)",
  ).run("audit-quiz-done-attempt", "audit-quiz", now - 900000, now - 600000);
  db.prepare(
    "INSERT INTO attempt_answers(id,attempt_id,payload_json,created_at) VALUES('audit-quiz-done','audit-quiz-done-attempt',?,?)",
  ).run(
    JSON.stringify({
      score: 0.7,
      picks: Object.fromEntries(
        questions.map((q, i) => [q.id, i < 7 ? "0" : "1"]),
      ),
      results: questions.map((q, i) => ({
        id: q.id,
        score: i < 7 ? 1 : 0,
        expected: "$F=ma$",
        explanation: question.explanation,
      })),
    }),
    now - 600000,
  );
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
  seedPlan(db, {
    id: "audit-ready-plan",
    title: "Prepared exam",
    language: "it",
    topics: [{ id: "audit-ready-topic", title: "Force" }],
  });
  // One plan with an exam date, so its card shows the days left and its header audits Add to calendar.
  const examDay = new Date(now);
  examDay.setDate(examDay.getDate() + 40);
  examDay.setHours(12, 0, 0, 0);
  db.prepare("UPDATE plans SET exam_at = ? WHERE id = 'audit-ready-plan'").run(
    examDay.getTime(),
  );
  db.prepare(
    "INSERT INTO plan_sessions(id,plan_id,date,created_at) VALUES('audit-ready-plan','audit-ready-plan',?,1)",
  ).run(examDay.getTime());
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
  // Cursor refused the model, Claude Code answered: the finished job in the jobs list says so.
  db.prepare(
    "UPDATE jobs SET fallback_json = ? WHERE id = 'audit-ready-build'",
  ).run(JSON.stringify({ from: "Cursor Agent", to: "Claude Code", reason: "model" }));
  seedPlan(db, {
    id: "audit-review-plan",
    title: "Review plan",
    language: "it",
    topics: [{ id: "audit-review-topic", title: "Cinematica" }],
  });
  db.exec(`
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
  seedResults(db, now);
}

/**
 * A simulation handed in an hour ago on the prepared exam, with what it changed in the path: it moved both topics,
 * its wrong answer counts for a serious gap with the model's reading of the mistake, and Codex graded it because
 * Claude Code hit its limit. The evidence is written before any page reads the plan, so core's cache holds it.
 */
function seedResults(db: DatabaseSync, now: number) {
  const at = now - 3_600_000;
  db.prepare(
    "INSERT INTO topics(id,plan_id,title,position,created_at) VALUES('audit-ready-energy','audit-ready-plan','Energy',1,1)",
  ).run();
  const questions = [
    { id: "result-force", topicId: "audit-ready-topic", stem: "Calculate the force on a $2$ kg mass accelerating at $3$ m/s²." },
    { id: "result-energy", topicId: "audit-ready-energy", stem: "Find the kinetic energy of a $2$ kg mass moving at $3$ m/s." },
    { id: "result-weight", topicId: "audit-ready-topic", stem: "A $2$ kg lift accelerates upwards at $1$ m/s². Find the cable tension." },
  ].map((question) => ({ ...question, answer: { kind: "completion", accepted: [["x"]] } }));
  const results = [
    { id: "result-force", score: 1, expected: "$F=ma=6$ N", feedback: "Right, with the unit.", missed: [], provider: "Codex", model: "gpt-audit" },
    { id: "result-energy", score: 1, expected: "$E=\\tfrac12 mv^2=9$ J", feedback: "Right.", missed: [], provider: "Codex", model: "gpt-audit" },
    {
      id: "result-weight",
      score: 0,
      expected: "$T=m(g+a)\\approx 21.6$ N",
      feedback: "The tension also has to carry the weight.",
      missed: ["The weight $mg$ in the balance of forces", "The direction of the acceleration"],
      provider: "Codex",
      model: "gpt-audit",
    },
  ];
  const picks = { "result-force": "$F=6$ N", "result-energy": "$9$ J", "result-weight": "$T=ma=2$ N" };
  db.prepare(
    "INSERT INTO items(id,plan_id,topic_id,kind,body_json,engine_provider,grounding,created_at) VALUES('audit-results-exam','audit-ready-plan','audit-ready-topic','simulation',?,'fixture','sources',?)",
  ).run(
    JSON.stringify({
      minutes: 60,
      questions,
      picks,
      gradingStartedAt: at,
      gradingJobId: "audit-results-grade",
      result: { score: 2 / 3, results },
    }),
    at,
  );
  db.prepare(
    "INSERT INTO attempts(id,plan_id,item_id,started_at,submitted_at) VALUES('audit-results-attempt','audit-ready-plan','audit-results-exam',?,?)",
  ).run(at - 3_600_000, at);
  db.prepare(
    "INSERT INTO attempt_answers(id,attempt_id,payload_json,created_at) VALUES('audit-results-answers','audit-results-attempt',?,?)",
  ).run(JSON.stringify({ picks, score: 2 / 3, results }), at);
  const event = db.prepare(
    "INSERT INTO learning_events(id,kind,plan_id,topic_id,payload_json,created_at) VALUES(?,'answer_given','audit-ready-plan',?,?,?)",
  );
  event.run("audit-results-before-force", "audit-ready-topic", '{"score":1,"scores":[1]}', at - 86_400_000);
  event.run("audit-results-before-energy", "audit-ready-energy", '{"score":0.5,"scores":[0.5]}', at - 86_400_000);
  event.run(
    "audit-results-force",
    "audit-ready-topic",
    JSON.stringify({ attemptId: "audit-results-attempt", score: 0.5, scores: [1, 0], evidenceKind: "simulation" }),
    at,
  );
  event.run(
    "audit-results-energy",
    "audit-ready-energy",
    JSON.stringify({ attemptId: "audit-results-attempt", score: 1, scores: [1], evidenceKind: "simulation" }),
    at + 1,
  );
  db.prepare(
    "INSERT INTO gaps(id,plan_id,topic_id,opened_at,origin,misconception,severity) VALUES('audit-results-gap','audit-ready-plan','audit-ready-topic',?,'misconception',?,'severe')",
  ).run(at, "You leave the weight out when the body accelerates vertically.");
  db.prepare(
    "INSERT INTO gap_answers(gap_id,attempt_id,question_id) VALUES('audit-results-gap','audit-results-attempt','result-weight')",
  ).run();
  db.prepare(
    "INSERT INTO jobs(id,kind,params_json,state,progress,created_at,updated_at,fallback_json) VALUES('audit-results-grade','simulation-grade',?,'succeeded',1,?,?,?)",
  ).run(
    JSON.stringify({ attemptId: "audit-results-attempt", planId: "audit-ready-plan", questions: [], results: [], next: 3 }),
    at,
    at,
    JSON.stringify({ from: "Claude Code", to: "Codex", reason: "limit" }),
  );
}

/**
 * A simulation being graded: the first exercise has its grade, the second is being graded and the third waits. Only
 * this state has it, so no other page sees an exam in grading or a running job.
 */
function prepareGradingLive(name: string) {
  withDb((db) => {
    db.exec(`DELETE FROM jobs WHERE id = 'audit-live-grade';
      DELETE FROM attempts WHERE id = 'audit-live-attempt';
      DELETE FROM items WHERE id = 'audit-live-exam';`);
    if (name !== "simulation-grading") return;
    const now = Date.now();
    const questions = [
      { id: "live-1", topicId: "audit-topic", stem: "Calcola la forza con $m=2$ e $a=3$." },
      { id: "live-2", topicId: "audit-topic", stem: "Una massa di $4$ kg accelera a $2$ m/s². Quanto vale la forza?" },
      { id: "live-3", topicId: "audit-topic", stem: "Spiega la seconda legge di Newton con un esempio." },
    ].map((question) => ({ ...question, answer: { kind: "completion", accepted: [["x"]] } }));
    const picks = { "live-1": "6", "live-2": "$F=8$ N", "live-3": "La forza è massa per accelerazione." };
    db.prepare(
      "INSERT INTO items(id,plan_id,topic_id,kind,body_json,engine_provider,grounding,created_at) VALUES('audit-live-exam','audit-plan','audit-topic','simulation',?,'fixture','sources',?)",
    ).run(
      JSON.stringify({ minutes: 30, questions, picks, gradingStartedAt: now - 5000, gradingJobId: "audit-live-grade" }),
      now,
    );
    db.prepare(
      "INSERT INTO attempts(id,plan_id,item_id,started_at) VALUES('audit-live-attempt','audit-plan','audit-live-exam',?)",
    ).run(now - 1_800_000);
    db.prepare(
      "INSERT INTO jobs(id,kind,params_json,state,progress,step_label,created_at,updated_at,fallback_json) VALUES('audit-live-grade','simulation-grade',?,'running',?,'jobs.simulationGrading',?,?,?)",
    ).run(
      JSON.stringify({
        attemptId: "audit-live-attempt",
        planId: "audit-plan",
        picks,
        questions,
        next: 1,
        frozenAt: now - 5000,
        results: [
          {
            id: "live-1",
            score: 0.8,
            expected: "$F=6$ N",
            feedback: "Il valore è giusto; manca l’unità di misura.",
            missed: ["Unità di misura"],
            provider: "Codex",
            model: "gpt-audit",
          },
        ],
      }),
      1 / 3,
      now,
      now,
      JSON.stringify({ from: "Claude Code", to: "Codex", reason: "limit" }),
    );
  });
}

/** A raw locale key on screen: any top-level section of en.json followed by a dotted path, so no section is skipped. */
const untranslatedKey = new RegExp(
  `\\b(?:${Object.keys(JSON.parse(readFileSync(join(process.cwd(), "src/renderer/src/locales/en.json"), "utf8"))).join("|")})\\.[A-Za-z][\\w.-]+`,
  "g",
);
/** Copy that looks like a key: the books site's host name starts with the `books` section. */
const notKeys = new Set(["books.politost.it"]);
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

/** A newer fake release served from disk by the e2e seam, installed into a stand-in AppImage. */
const packageVersion = JSON.parse(
  readFileSync(join(process.cwd(), "package.json"), "utf8"),
).version as string;
const [major = 0, minor = 0] = packageVersion.split(".").map(Number);
const updateTag = `v${major}.${minor + 1}.0`;
const updateAsset = `PoliTost.Pyxis-${updateTag.slice(1)}.AppImage`;
const updateBytes = Buffer.alloc(300 * 1024, 7);
let updateFolder = "";
function updateEnv() {
  updateFolder = mkdtempSync(join(tmpdir(), "pyxis-ui-audit-update-"));
  mkdirSync(join(updateFolder, "release"));
  mkdirSync(join(updateFolder, "apps"));
  writeFileSync(join(updateFolder, "release", updateAsset), updateBytes);
  writeFileSync(join(updateFolder, "apps", "Pyxis.AppImage"), "installed");
  const download = (name: string) =>
    `https://github.com/PoliTost/pyxis-test/releases/download/${updateTag}/${name}`;
  return {
    PYXIS_E2E_RELEASE: JSON.stringify({
      tag_name: updateTag,
      body: "Nuovi strumenti di studio.",
      draft: false,
      prerelease: false,
      assets: [
        {
          name: updateAsset,
          size: updateBytes.length,
          browser_download_url: download(updateAsset),
        },
        {
          name: "SHA256SUMS",
          size: 120,
          browser_download_url: download("SHA256SUMS"),
        },
      ],
    }),
    PYXIS_E2E_UPDATE_ASSETS: join(updateFolder, "release"),
    PYXIS_E2E_UPDATE_HOLD: join(updateFolder, "hold"),
    PYXIS_E2E_APPIMAGE: join(updateFolder, "apps", "Pyxis.AppImage"),
  };
}
/** The SHA256SUMS line for the fake installer, wrong for the failed state. A held download pauses before its end. */
function prepareUpdate(name: string) {
  if (!updateFolder) return;
  const hash =
    name === "updates-failed"
      ? "f".repeat(64)
      : createHash("sha256").update(updateBytes).digest("hex");
  writeFileSync(
    join(updateFolder, "release", "SHA256SUMS"),
    `${hash}  ${updateAsset}\n`,
  );
  const hold = join(updateFolder, "hold");
  if (name === "updates-downloading") writeFileSync(hold, "");
  else rmSync(hold, { force: true });
}
async function startUpdate(page: Page) {
  const start = page
    .locator(".px-updates")
    .getByRole("button", {
      name: both("Scarica e installa", "Download and install"),
    });
  await expect(start).toBeVisible();
  await start.click();
}
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

/** Whether the "practice-rated" state left its self-rating in the audit workspace. */
let auditRating = false;
let auditPlanner = false;
let auditDone = false;

/** Cards of a second subject and of an exam with no subject, for the flashcard browser only. Every other state removes them. */
function prepareCardBrowser(name: string) {
  withDb((db) => {
    db.exec(`DELETE FROM plans WHERE id IN ('audit-chem-plan','audit-loose-plan');
      DELETE FROM subjects WHERE id = 'audit-chem';
      UPDATE topics SET archived_at = NULL WHERE archived_at = 7;`);
    if (!name.startsWith("cards-browser")) return;
    // An archived topic hides its cards, so no topic holds a card: the browser has nothing to show.
    if (name === "cards-browser-empty") {
      db.exec("UPDATE topics SET archived_at = 7 WHERE archived_at IS NULL");
      return;
    }
    const later = Date.now() + 9 * 86_400_000;
    seedSubjects(db, [{ id: "audit-chem", name: "Chimica", position: 1 }]);
    seedPlan(db, {
      id: "audit-chem-plan",
      subjectId: "audit-chem",
      title: "Chimica generale",
      language: "it",
      target: 0.75,
      createdAt: 2,
      topics: [{ id: "audit-atoms", title: "Struttura dell’atomo" }],
    });
    seedPlan(db, {
      id: "audit-loose-plan",
      title: "Appunti sparsi",
      language: "it",
      target: 0.75,
      createdAt: 3,
      topics: [{ id: "audit-loose-topic", title: "Varie" }],
    });
    db.exec(`INSERT INTO cards(id,plan_id,topic_id,front,back,seed_key,suspended,grounding,created_at) VALUES
        ('audit-card-z','audit-chem-plan','audit-atoms','Che cos’è il numero atomico?','Il numero di protoni nel nucleo, $Z$.','z1',0,'sources',1),
        ('audit-card-bohr','audit-chem-plan','audit-atoms','Perché l’atomo di Bohr non spiega gli spettri di tutti gli elementi, compresi quelli con molti elettroni e interazioni tra loro?','Perché trascura la repulsione tra elettroni.','z2',1,'sources',2),
        ('audit-card-loose','audit-loose-plan','audit-loose-topic','Una flashcard senza materia','Resta nel gruppo finale.','z3',0,'sources',1);
      INSERT INTO cards(id,plan_id,topic_id,front,back,grounding,created_at) VALUES
        ('audit-card-cloze','audit-chem-plan','audit-atoms','Gli {{c1::elettroni}} occupano i {{c2::livelli}} di energia.','Modello a gusci.','sources',3);`);
    db.prepare(
      "INSERT INTO card_reviews(id,card_id,rating,state_json,reviewed_at) VALUES('audit-review-z','audit-card-z','good',?,1)",
    ).run(JSON.stringify({ intervalDays: 9, ease: 2, dueAt: later }));
  });
}

/** Saves the automatic-backup state as main leaves it. Main reads the file again for every status request. */
function prepareBackupState(name: string) {
  const file = join(auditUserData, "backups.json");
  const at = new Date(2026, 9, 12, 21, 5).getTime();
  const saved = {
    enabled: true,
    folder: null,
    lastSuccessAt: at,
    lastAttemptAt: at,
    last: { at, ok: true, size: 48_213_504, verified: true },
    toldTooLarge: false,
  };
  const states: Record<string, unknown> = {
    "backup-settings-on": saved,
    "backup-settings-off": { ...saved, enabled: false },
    "backup-settings-failed": {
      ...saved,
      folder: "/Volumes/CHIAVETTA/Pyxis",
      lastSuccessAt: at - 3 * 24 * 60 * 60 * 1000,
      last: { at, ok: false, reason: "folder-missing" },
    },
  };
  if (name in states) writeFileSync(file, JSON.stringify(states[name]));
  else rmSync(file, { force: true });
}

/** The empty Exams page: the plans move to a side table and come back for every other state. Foreign keys are off on this connection only, so nothing that belongs to a plan is deleted with it. */
function prepareExamsEmpty(name: string) {
  withDb((db) => {
    db.exec("PRAGMA foreign_keys = OFF");
    const hidden = db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'audit_hidden_plans'",
      )
      .get();
    if (name === "exams-empty") {
      if (hidden) return;
      db.exec(`CREATE TABLE audit_hidden_plans AS SELECT * FROM plans;
        DELETE FROM plans;`);
    } else if (hidden)
      db.exec(`INSERT INTO plans SELECT * FROM audit_hidden_plans;
        DROP TABLE audit_hidden_plans;`);
  });
}

/** The empty Library: its sources leave the library for this state only and come back for every other. */
function prepareLibraryEmpty(name: string) {
  withDb((db) => {
    const hidden = db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'audit_hidden_library'",
      )
      .get();
    if (name === "library-empty") {
      if (hidden) return;
      db.exec(`CREATE TABLE audit_hidden_library AS SELECT id FROM sources WHERE library = 1;
        UPDATE sources SET library = 0 WHERE id IN (SELECT id FROM audit_hidden_library);`);
    } else if (hidden)
      db.exec(`UPDATE sources SET library = 1 WHERE id IN (SELECT id FROM audit_hidden_library);
        DROP TABLE audit_hidden_library;`);
  });
}

/** The empty Maps section: the maps move to a side table and come back for every other state. */
function prepareMapsEmpty(name: string) {
  withDb((db) => {
    const hidden = db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'audit_hidden_maps'",
      )
      .get();
    if (name === "maps-empty") {
      if (hidden) return;
      db.exec(`CREATE TABLE audit_hidden_maps AS SELECT * FROM maps;
        DELETE FROM maps;`);
    } else if (hidden)
      db.exec(`INSERT INTO maps SELECT * FROM audit_hidden_maps;
        DROP TABLE audit_hidden_maps;`);
  });
}

/**
 * Two sources for the details panel states, attached to the audit exam: a 12-page PDF whose first 4 pages had a text
 * layer, the others read by OCR five minutes after the import except page 11, which is blank, cited by a lesson and two quizzes;
 * and a scan whose OCR job is reading it, 2 pages in. Every other state starts without them.
 */
function preparePanelSources(name: string) {
  const ids = "('audit-panel-pdf', 'audit-panel-scan', 'audit-panel-link')";
  withDb((db) => {
    db.exec(`DELETE FROM jobs WHERE id = 'audit-panel-ocr';
      DELETE FROM item_passages WHERE passage_id IN (SELECT id FROM passages WHERE source_id IN ${ids});
      DELETE FROM topic_passages WHERE passage_id IN (SELECT id FROM passages WHERE source_id IN ${ids});
      DELETE FROM passages WHERE source_id IN ${ids};
      DELETE FROM source_documents WHERE source_id IN ${ids};
      DELETE FROM plan_sources WHERE source_id IN ${ids};
      DELETE FROM sources WHERE id IN ${ids};`);
  });
  if (
    !["library-panel-pdf", "library-panel-scan", "library-panel-removed", "plan-sources-removed", "library-panel-link"].includes(
      name,
    )
  )
    return;
  const sha = auditScanBlob();
  const day = 24 * 60 * 60 * 1000;
  const added = Date.now() - 10 * day;
  const scanned = Date.now() - day;
  withDb((db) => {
    const source = db.prepare(
      "INSERT INTO sources(id,kind,title,status,library,blob_sha,mime,created_at,updated_at) VALUES(?,'pdf',?,?,1,?,'application/pdf',?,?)",
    );
    const document = db.prepare(
      "INSERT INTO source_documents(id,source_id,version,tree_json,created_at) VALUES(?,?,1,'{}',?)",
    );
    const passage = db.prepare(
      "INSERT INTO passages(id,source_id,document_id,version,text,locator_json,section_path,created_at) VALUES(?,?,?,1,?,?,?,?)",
    );
    const page = (sourceId: string, n: number, at: number) =>
      passage.run(
        `${sourceId}-p${n}`,
        sourceId,
        `${sourceId}-document`,
        `Esercizio ${n}: calcola il limite della successione proposta e giustifica ogni passaggio.`,
        JSON.stringify({ page: n }),
        `p. ${n}`,
        at,
      );
    source.run("audit-panel-pdf", "Esercitazioni Analisi 1 2025", "ready", sha, added, added);
    document.run("audit-panel-pdf-document", "audit-panel-pdf", added);
    for (let n = 1; n <= 12; n += 1)
      if (n !== 11) page("audit-panel-pdf", n, n <= 4 ? added : added + 5 * 60 * 1000);
    source.run("audit-panel-scan", "Appello 10 febbraio 2025", "ocr-queued", sha, scanned, scanned);
    db.prepare(
      "INSERT INTO sources(id,kind,title,status,library,origin_url,fetched_at,created_at,updated_at) VALUES('audit-panel-link','link','Serie di Fourier','ready',1,'https://appunti.example.org/fourier',?,?,?)",
    ).run(scanned, added, added);
    document.run("audit-panel-link-document", "audit-panel-link", added);
    passage.run(
      "audit-panel-link-p1",
      "audit-panel-link",
      "audit-panel-link-document",
      "Una funzione periodica si scrive come somma di seni e coseni.",
      JSON.stringify({ heading: "Coefficienti" }),
      "Coefficienti",
      added,
    );
    document.run("audit-panel-scan-document", "audit-panel-scan", scanned);
    for (const n of [1, 2]) page("audit-panel-scan", n, scanned + n * 60 * 1000);
    db.exec(`INSERT INTO plan_sources(plan_id,source_id) VALUES('audit-plan','audit-panel-pdf'), ('audit-plan','audit-panel-scan');
      INSERT INTO topic_passages(topic_id,passage_id) VALUES('audit-topic','audit-panel-pdf-p5');
      INSERT INTO item_passages(item_id,passage_id) VALUES('audit-lesson','audit-panel-pdf-p3'), ('audit-lesson','audit-panel-pdf-p5'),
        ('audit-quiz','audit-panel-pdf-p5'), ('audit-diagnostic','audit-panel-pdf-p6');`);
    const now = Date.now();
    db.prepare(
      "INSERT INTO jobs(id,kind,params_json,state,progress,step_label,created_at,updated_at) VALUES('audit-panel-ocr','source-ocr',?,'running',0.5,'sources.jobs.ocr',?,?)",
    ).run(JSON.stringify({ sourceId: "audit-panel-scan" }), now, now);
  });
}

function prepareState(name: string) {
  prepareExamsEmpty(name);
  preparePanelSources(name);
  prepareLibraryEmpty(name);
  prepareMapsEmpty(name);
  prepareCardBrowser(name);
  prepareBackupState(name);
  prepareUpdate(name);
  prepareGradingLive(name);
  // A rating from this visit shows as chosen on the practice page; every other state starts without one.
  if (name === "practice-rated" || auditRating)
    withDb((db) => {
      db.exec(
        "DELETE FROM learning_events WHERE json_extract(payload_json, '$.evidenceKind') = 'self'",
      );
      if (name === "practice-rated")
        db.prepare(
          "INSERT INTO learning_events(id,kind,plan_id,topic_id,payload_json,created_at) VALUES('audit-self-rating','answer_given','audit-plan','audit-topic',?,?)",
        ).run(
          JSON.stringify({
            exerciseId: "audit-exercise",
            rating: "got",
            score: 1,
            evidenceKind: "self",
            questionScores: [{ id: "audit-exercise", score: 1 }],
          }),
          Date.now(),
        );
    });
  auditRating = name === "practice-rated";
  // Hours in the session planner give the dated exam's topics and simulation their expected days; other states have none.
  if (name === "plan-dated-planner" || auditPlanner)
    withDb((db) => {
      if (name === "plan-dated-planner")
        db.prepare(
          "INSERT INTO settings(key,value_json,updated_at) VALUES('planner',?,1) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json",
        ).run(JSON.stringify({ weeklyHours: 1, weeks: {} }));
      else db.prepare("DELETE FROM settings WHERE key = 'planner'").run();
    });
  auditPlanner = name === "plan-dated-planner";
  // Two finished steps on the audit exam, so its path folds them into the first row; other states start without.
  if (name === "plan-done" || auditDone)
    withDb((db) => {
      db.exec("DELETE FROM learning_events WHERE id IN ('audit-done-lesson', 'audit-done-practice')");
      if (name !== "plan-done") return;
      const step = db.prepare(
        "INSERT INTO learning_events(id,kind,plan_id,topic_id,payload_json,created_at) VALUES(?,'lesson_completed','audit-plan','audit-topic',?,?)",
      );
      step.run("audit-done-lesson", JSON.stringify({ activity: "lesson" }), Date.now() - 60_000);
      step.run("audit-done-practice", JSON.stringify({ activity: "practice" }), Date.now());
    });
  auditDone = name === "plan-done";
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
  // A free book the fixture catalog lists at a newer version. Only the book-update states put it in the Library.
  withDb((db) => {
    db.prepare(
      "INSERT OR IGNORE INTO sources(id,kind,title,blob_sha,mime,status,library,catalog_id,catalog_version,created_at,updated_at) VALUES('audit-free-book','smartbook','Fisica di prova',?,'application/vnd.politost.ptsb','ready',0,'fisica-demo','1.0.0',2,2)",
    ).run("a".repeat(64));
    db.prepare(
      "UPDATE sources SET library = ? WHERE id = 'audit-free-book'",
    ).run(
      name.includes("book-update") || name.includes("books-update") ? 1 : 0,
    );
  });
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
  // The jobs list's running group: two jobs under way, one of them named after the photo it reads. Only the jobs list
  // shows them, so the other routes keep their top bar.
  withDb((db) => {
    db.exec("DELETE FROM jobs WHERE id LIKE 'audit-running-%'");
    if (name !== "jobs-popover") return;
    const now = Date.now();
    const running = db.prepare(
      "INSERT INTO jobs(id,kind,params_json,state,progress,step_label,created_at,updated_at) VALUES(?,?,?,'running',?,?,?,?)",
    );
    running.run("audit-running-cards", "cards-build", "{}", 0.4, "jobs.cards", now, now);
    running.run(
      "audit-running-photo",
      "source-import",
      JSON.stringify({ sourceId: "audit-photo" }),
      0.75,
      "sources.jobs.extract",
      now,
      now,
    );
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
        // The stored file is what core reads page by page, so the OCR states keep a real one-page image-only PDF.
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

// The exam step, then the material step. On the material step the seeded source is picked, so it shows the
// exam's material and the Create button rather than the guided flow's way in.
async function openWizard(page: Page, step: number) {
  await page
    .getByRole("textbox", { name: both("Nome dell'esame", "Exam name"), exact: true })
    .fill("Fisica audit");
  if (step === 1) return;
  // Nothing is chosen for the student on the exam step.
  await page
    .getByRole("button", {
      name: both("Non ho ancora la data", "I don't have the date yet"),
    })
    .click();
  await page
    .getByRole("button", { name: /Continua|Continue/, exact: true })
    .click();
  await expect(page.locator(".px-stepper-item").nth(1)).toHaveAttribute("aria-current", "step");
  // The seeded source is in the library, so it comes in through the library picker.
  await page
    .getByRole("button", {
      name: both("Dalla tua libreria", "From your library"),
    })
    .click();
  const picker = page.getByRole("dialog");
  await picker.getByRole("checkbox", { name: /Appunti di fisica/ }).check();
  await picker
    .getByRole("button", { name: /^(Aggiungi 1 fonte|Add 1 source)$/ })
    .click();
  await expect(picker).toBeHidden();
}

/** A step's Back and Continue/Create buttons share one line, and no stepper label is cut with an ellipsis. */
async function expectStepFrame(page: Page) {
  const edges = page.locator(".focus-actions-bar").getByRole("button");
  const first = (await edges.first().boundingBox())!;
  const last = (await edges.last().boundingBox())!;
  expect(Math.abs(first.y + first.height / 2 - (last.y + last.height / 2))).toBeLessThan(1);
  const cut = await page
    .locator(".px-stepper-label")
    .evaluateAll((labels) => labels.filter((label) => label.scrollWidth > label.clientWidth).length);
  expect(cut).toBe(0);
}

async function openGuided(
  page: Page,
  upTo: "period" | "modules" | "style" | "tree",
) {
  await page
    .getByRole("textbox", { name: both("Nome dell'esame", "Exam name"), exact: true })
    .fill("Fisica audit");
  const next = () =>
    page
      .getByRole("button", { name: /Continua|Continue/, exact: true })
      .click();
  await page
    .getByRole("button", {
      name: both("Non ho ancora la data", "I don't have the date yet"),
    })
    .click();
  // No material chosen: Continue on the material step leads to the guided flow.
  for (let i = 0; i < 2; i++) await next();
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
    // The download state lives in main and outlasts a reload, so the plain route starts from no download.
    case "settings-updates":
      await page.evaluate(() => window.pyxis.cancelUpdate());
      break;
    case "updates-available":
      await page.evaluate(() => window.pyxis.cancelUpdate());
      await expect(
        page
          .locator(".px-updates")
          .getByText(
            both(
              `Pyxis ${updateTag} è disponibile.`,
              `Pyxis ${updateTag} is available.`,
            ),
          ),
      ).toBeVisible();
      await expect(
        page.locator(".px-updates").getByRole("button", {
          name: both("Scarica e installa", "Download and install"),
        }),
      ).toBeVisible();
      break;
    case "updates-downloading":
      await page.evaluate(() => window.pyxis.cancelUpdate());
      await startUpdate(page);
      await expect(
        page.locator(".px-updates").getByRole("progressbar", {
          name: both(
            `Scarico Pyxis ${updateTag}`,
            `Downloading Pyxis ${updateTag}`,
          ),
        }),
      ).toBeVisible();
      await expect(page.locator(".px-updates").getByText(/85%/)).toBeVisible();
      await expect(
        page.getByRole("button", {
          name: both("Annulla il download", "Cancel download"),
        }),
      ).toBeVisible();
      break;
    case "updates-verified": {
      // The held download from the previous state finishes now; a filtered run starts its own.
      const state = await page.evaluate(() => window.pyxis.updateState());
      if (state.state !== "downloading" && state.state !== "verified")
        await startUpdate(page);
      await expect(
        page.getByText(
          both(
            `Pyxis ${updateTag} è installato. Riavvia Pyxis per usarlo.`,
            `Pyxis ${updateTag} is installed. Restart Pyxis to use it.`,
          ),
        ),
      ).toBeVisible();
      await expect(
        page.getByRole("button", {
          name: both("Riavvia Pyxis", "Restart Pyxis"),
        }),
      ).toBeVisible();
      break;
    }
    case "updates-failed":
      await page.evaluate(() => window.pyxis.cancelUpdate());
      await startUpdate(page);
      await expect(
        page.getByText(
          /non corrisponde al suo checksum|did not match its checksum/,
        ),
      ).toBeVisible();
      await expect(
        page.locator(".px-updates").getByRole("button", {
          name: both("Apri la pagina della versione", "Open release page"),
        }),
      ).toBeVisible();
      break;
    case "wizard-1":
    case "wizard-2": {
      const step = Number(name.split("-")[1]);
      await expect(page.locator(".px-stepper-item").nth(step - 1)).toHaveAttribute(
        "aria-current",
        "step",
      );
      if (step === 1)
        await expect(
          page.getByRole("slider", { name: /^(Obiettivo|Goal) .* (su|out of) (30|100)$/ }),
        ).toBeVisible();
      // With a source picked, the material step creates the exam and offers no guided flow.
      if (step === 2) {
        await expect(
          page.getByRole("button", { name: both("Non ho materiale", "I have no material") }),
        ).toHaveCount(0);
        await expect(
          page.getByRole("button", {
            name: both("Crea l'esame", "Create the exam"),
          }),
        ).toBeVisible();
      }
      await expect(page).toHaveURL(/#\/plans\/new$/);
      await expectStepFrame(page);
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
          name: both("Impostazioni dell'esame", "Exam settings"),
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
      await expectStepFrame(page);
      break;
    case "shortcuts-dialog":
      await auditApp!.evaluate(({ Menu }) => {
        Menu.getApplicationMenu()?.getMenuItemById("shortcuts")?.click();
      });
      await expect(
        page.getByRole("dialog", {
          name: both("Scorciatoie da tastiera", "Keyboard shortcuts"),
        }),
      ).toBeVisible();
      break;
    case "ask-panel":
      await page
        .getByRole("button", { name: both("Apri le chat", "Open chats") })
        .click();
      await expect(
        page.getByRole("list", { name: both("Chat", "Chats") }),
      ).toBeVisible();
      break;
    case "ask-search":
    case "ask-search-empty": {
      await page
        .getByRole("button", { name: both("Apri le chat", "Open chats") })
        .click();
      const empty = name === "ask-search-empty";
      await page
        .getByRole("textbox", {
          name: both("Cerca nelle chat", "Search chats"),
        })
        .fill(empty ? "zzzz" : "forza");
      await expect(
        empty
          ? page.getByText(/Nessuna chat contiene|No chat matches/)
          : page.getByRole("list", {
              name: both("Risultati della ricerca", "Search results"),
            }),
      ).toBeVisible();
      break;
    }
    case "ask-subject-menu":
      await page.getByRole("button", { name: /^(Materia|Subject):/ }).click();
      await expect(
        page.getByRole("button", {
          name: both("Gestisci materie", "Manage subjects"),
        }),
      ).toBeVisible();
      break;
    case "ask-sources-menu":
      await page
        .getByRole("button", { name: both("Fonti", "Sources") })
        .click();
      await expect(
        page.getByRole("button", {
          name: both("Aggiungi fonti", "Add sources"),
        }),
      ).toBeVisible();
      break;
    case "ask-formula": {
      await page
        .getByRole("button", {
          name: both("Inserisci formula", "Insert formula"),
        })
        .click();
      const keys = page.getByRole("group", {
        name: both("Tastiera per formule", "Formula keyboard"),
      });
      // The keyboard loads on first open, which took over 5 s on the hosted Windows runner.
      await expect(keys).toBeVisible({ timeout: 20000 });
      await keys
        .getByRole("button", { name: both("Frazione", "Fraction") })
        .click();
      await keys.getByRole("button", { name: "1", exact: true }).click();
      break;
    }
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
        .getByRole("button", { name: both("Altre azioni", "More actions") })
        .click();
      await page
        .getByRole("menuitem", {
          name: both("Riscrivi", "Rewrite"),
          exact: true,
        })
        .click();
      await expect(
        page
          .getByRole("dialog")
          .getByText(/Riscrivere questa lezione|Rewrite this lesson/)
          .last(),
      ).toBeVisible();
      break;
    case "practice-rated": {
      const got = page.getByRole("button", {
        name: both("Ce l'ho fatta", "Got it"),
      });
      const missed = page.getByRole("button", {
        name: both("Non ce l'ho fatta", "Missed it"),
      });
      await expect(got).toHaveAttribute("aria-pressed", "true");
      await expect(missed).toHaveAttribute("aria-pressed", "false");
      break;
    }
    case "lesson-menu":
      await page
        .getByRole("button", { name: both("Altre azioni", "More actions") })
        .click();
      await expect(
        page.getByRole("menuitem", { name: both("Mappa", "Map") }),
      ).toBeVisible();
      break;
    case "quiz-setup":
      await page
        .getByRole("button", { name: /^(Personalizza|Customize)$/ })
        .click();
      await expect(
        page.getByRole("group", { name: /Tipi di domanda|Question types/ }),
      ).toBeVisible();
      break;
    case "quiz-page":
      await page
        .getByRole("button", { name: /^(Personalizza|Customize)$/ })
        .click();
      await page
        .getByRole("button", { name: /^(Una pagina|One page)$/ })
        .click();
      await expect(page.getByRole("spinbutton")).toBeVisible();
      break;
    case "quiz-timed":
      await page
        .getByRole("button", { name: /^(Personalizza|Customize)$/ })
        .click();
      await page
        .getByRole("checkbox", { name: /Imposta un limite|Set a time limit/ })
        .check();
      await expect(page.getByRole("spinbutton")).toBeVisible();
      break;
    case "jobs-popover":
      await page
        .getByRole("button", { name: /^(Attività|Background tasks):/ })
        .click();
      {
        const list = page.getByRole("region", {
          name: /^(Attività|Background tasks)$/,
        });
        await expect(list).toBeVisible();
        // The keyboard lands in the list, not on the page behind it.
        await expect(list).toBeFocused();
        await expect(
          list.getByRole("heading", { name: /^(Attività|Background tasks)$/ }),
        ).toBeVisible();
        await expect(
          list.getByRole("heading", { name: /^(Da sistemare|To fix) · / }),
        ).toBeVisible();
        await expect(
          list.getByText(
            /Pyxis non riesce a leggere questa immagine|Pyxis cannot read this image/,
          ),
        ).toBeVisible();
        await expect(list.getByText(/troppi pixel|too many pixels/)).toBeVisible();
        await expect(
          list.getByRole("heading", { name: /^(In corso|Running) · 2$/ }),
        ).toBeVisible();
        await expect(
          list.getByRole("progressbar", {
            name: /Scrivo le flashcard|Writing flashcards/,
          }),
        ).toBeVisible();
        await expect(
          list.getByRole("button", {
            name: /^(Annulla|Cancel): (Scrivo le flashcard|Writing flashcards)$/,
          }),
        ).toBeVisible();
        // Jobs that stopped for one reason are one problem with the count in its title. How many share the reason
        // depends on which states ran before this one (a full run seeds one more), so only the merge is checked.
        await expect(
          list.getByText(/^([2-9]|\d\d+) (attività ferme|tasks stopped)$/),
        ).toBeVisible();
        await expect(
          list.getByRole("button", {
            name: /^(Mostra le \d+ attività|Show the \d+ tasks)$/,
          }),
        ).toBeVisible();
        // Finished today, with the engine that answered after another one refused.
        await expect(
          list.getByRole("heading", { name: /^(Finite oggi|Finished today) · / }),
        ).toBeVisible();
        await expect(
          list.getByText(
            /Il tuo abbonamento a Cursor Agent non include questo modello, quindi ha risposto Claude Code\.|Your Cursor Agent subscription doesn't include this model, so Claude Code answered\./,
          ),
        ).toBeVisible();
        await expect(
          list.getByRole("button", { name: /^(Chiudi le finite|Clear finished)$/ }),
        ).toBeVisible();
      }
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
    case "backup-settings-on":
    case "backup-settings-off": {
      const on = name === "backup-settings-on";
      const toggle = page.getByRole("switch", {
        name: both("Copia di sicurezza automatica", "Back up automatically"),
      });
      if (on) await expect(toggle).toBeChecked();
      else await expect(toggle).not.toBeChecked();
      await expect(
        page.getByText(on ? /^(Una volta al giorno|Once a day)/ : /^(Spenta|Off)\./),
      ).toBeVisible();
      await expect(
        page.getByText(/^(Ultima copia|Last backup): .+\.$/),
      ).toBeVisible();
      break;
    }
    case "backup-settings-failed":
      await expect(
        page.getByText(/^(La copia del|The backup of) .+ (non è riuscita|did not finish)\.$/),
      ).toBeVisible();
      await expect(
        page.getByText(
          /^(La cartella delle copie non è disponibile|The backup folder is not available)\./,
        ),
      ).toBeVisible();
      await expect(
        page.getByText(/^(Cartella|Folder): \/Volumes\/CHIAVETTA\/Pyxis$/),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: both("Cambia cartella", "Change folder") }),
      ).toBeVisible();
      break;
    case "ocr-download-cancelled":
      await expect(
        page.getByText(/download è stato annullato|download was cancelled/),
      ).toBeVisible();
      break;
    case "ocr-jobs-popover":
      await page
        .getByRole("button", { name: /^(Attività|Background tasks):/ })
        .click();
      await expect(
        page.getByRole("region", { name: /^(Attività|Background tasks)$/ }),
      ).toBeVisible();
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
      // A refused read is not left looking as if it were reading.
      await expect(
        page.getByText(/Lettura delle pagine scansionate|Reading the scanned pages/),
      ).toHaveCount(0);
      if (name === "library-ocr-ready") {
        // The files appear on disk (as if another window had finished the download); Download then finds them ready.
        stageOcrData();
        await page
          .getByRole("button", { name: /^(Scarica|Download) [\d.,]+ MB$/ })
          .click();
        // The scan's notice turned into the download card, so its one Read button is the card's.
        await expect(
          page.getByRole("button", {
            name: both("Leggi la scansione", "Read the scan"),
          }),
        ).toHaveCount(1);
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
      ).toHaveText("Che cosa c'è scritto qui?");
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
    case "quiz-grading-failed":
      await expect(
        page.getByRole("button", {
          name: /Riprova la correzione|Retry grading/,
        }),
      ).toBeVisible();
      // Grading is not a question: the header shows no position, the count says graded rather than correct, and the
      // way to the engines names the page it opens.
      await expect(page.getByText(/^(Domanda|Question) \d+ (di|of) \d+$/)).toHaveCount(0);
      await expect(page.getByText(/\d+ su \d+ risposte? apert[ae] valutat[ae]|\d+ of \d+ open answers? graded/)).toBeVisible();
      await expect(
        page.getByRole("button", { name: /^(Apri Motori AI|Open AI engines)$/ }),
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
    case "simulation-result-changes": {
      // What the exam changed comes from mastery before and after it and the gap its wrong answer counts for.
      const changes = page.locator(".px-res-changes");
      await expect(changes).toContainText(/Lacuna seria su Force|Serious gap in Force/);
      await expect(changes).toContainText("You leave the weight out");
      await expect(changes).toContainText(/Energy (migliora|went up)/);
      await expect(page.locator(".px-res-fallback")).toContainText("Codex");
      // One primary button, the next step; the list opens on the one exercise to review.
      await expect(page.locator(".px-res .ant-btn-primary")).toHaveCount(1);
      await expect(page.locator(".px-res-q")).toHaveCount(1);
      await expect(page.locator(".px-res-q")).toContainText(/Sbagliato|Wrong/);
      break;
    }
    case "simulation-grading":
      await expect(
        page.getByRole("progressbar", { name: /Risposte valutate finora|Answers graded so far/ }),
      ).toBeVisible();
      // The graded exercise reads in full; the others say in words where they are.
      await expect(page.locator(".px-res-q.is-partial")).toContainText(/Cosa manca|What was missed/);
      await expect(page.locator(".px-res-q.is-grading")).toContainText(/In correzione|Grading/);
      await expect(page.locator(".px-res-q.is-queued")).toContainText(/In coda|Queued/);
      await expect(page.locator(".px-res-changes-later")).toBeVisible();
      await expect(page.locator(".px-res-fallback")).toContainText("Codex");
      await expect(page.locator(".px-res .ant-btn-primary")).toHaveCount(1);
      break;
    case "simulation-grading-failed":
      // The results screen while grading is stopped: retry is the one primary action, the way back sits under it,
      // and the exercise not graded yet says so in words.
      await expect(
        page.getByRole("button", { name: /Chiudi|Close/, exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", {
          name: /^(Riprendi la correzione|Retry grading)$/,
        }),
      ).toHaveClass(/ant-btn-primary/);
      await expect(
        page.getByRole("button", {
          name: /^(Torna al percorso|Back to the path)$/,
        }),
      ).toBeVisible();
      await expect(
        page.locator(".px-res-q.is-ungraded").getByText(/^(Da correggere|Not graded yet)$/),
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
    case "library-empty":
      await expect(
        page.getByRole("heading", {
          name: both("Nessuna fonte ancora", "No sources yet"),
        }),
      ).toBeVisible();
      break;
    case "library-search":
      await page
        .getByRole("combobox", { name: both("Cerca in", "Search in") })
        .click();
      await page
        .locator(
          '.ant-select-dropdown:visible .ant-select-item-option:is([title="Contenuto"],[title="Content"])',
        )
        .click();
      await page
        .getByRole("textbox", { name: both("Cerca nei brani", "Search passages") })
        .fill("forza");
      await page.keyboard.press("Enter");
      await expect(
        page.getByRole("button", { name: /1\. Dinamica/ }),
      ).toBeVisible();
      break;
    case "library-book-update":
      await expect(
        page.getByText(
          both(
            "Nuova versione disponibile: 1.1.0",
            "New version available: 1.1.0",
          ),
        ),
      ).toBeVisible();
      break;
    case "library-books-update":
      await page.getByRole("button", { name: both("Altro", "More") }).click();
      await page
        .getByRole("menuitem", {
          name: both("Libri PoliTost gratuiti", "Free PoliTost books"),
        })
        .click();
      await expect(
        dialog.getByRole("button", {
          name: both("Aggiorna Fisica di prova", "Update Fisica di prova"),
        }),
      ).toBeVisible();
      await expect(
        dialog.getByText(
          both("Nuova versione disponibile", "New version available"),
        ),
      ).toBeVisible();
      break;
    case "maps":
      await expect(
        page.getByRole("heading", { level: 3, name: "Dinamica" }),
      ).toBeVisible();
      break;
    case "maps-empty":
      await expect(
        page.getByRole("heading", {
          name: both("Ancora nessuna mappa", "No maps yet"),
        }),
      ).toBeVisible();
      break;
    case "maps-none":
      await page
        .getByRole("textbox", { name: both("Cerca nelle mappe", "Search maps") })
        .fill("zzzz");
      await expect(
        page.getByText(
          both("Nessuna mappa corrisponde.", "No map matches."),
        ),
      ).toBeVisible();
      break;
    case "maps-new":
      await page
        .getByRole("button", { name: both("Nuova mappa", "New map") })
        .click();
      await expect(dialog).toBeVisible();
      break;
    case "map-export":
      await expect(page.locator(".react-flow__node")).toHaveCount(3);
      await page
        .getByRole("button", { name: both("Esporta", "Export") })
        .click();
      await expect(page.getByRole("menuitem").first()).toBeVisible();
      break;
    case "exams-import-menu":
      await page.getByRole("button", { name: both("Altro", "More") }).click();
      await expect(page.getByRole("menuitem").first()).toBeVisible();
      break;
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
      // Replace, read again and remove live in the row menu only.
      await expect(
        dialog.getByRole("button", { name: both("Rimuovi", "Remove") }),
      ).toHaveCount(0);
      break;
    case "library-panel-pdf":
      await page
        .getByRole("button", { name: "Esercitazioni Analisi 1 2025", exact: true })
        .click();
      await expect(dialog).toBeVisible();
      await expect(
        dialog.getByRole("button", { name: both("Apri la fonte", "Open source") }),
      ).toBeVisible();
      await expect(dialog.locator(".px-source-strip i")).toHaveCount(12);
      await expect(
        dialog.getByText(
          both("7 pagine scansionate, lette con l'OCR", "7 scanned pages, read with OCR"),
        ),
      ).toBeVisible();
      await expect(
        dialog.getByRole("button", {
          name: /^(Pagina 5\s*2 citazioni|Page 5\s*2 citations)$/,
        }),
      ).toBeVisible();
      break;
    case "library-panel-link":
      await page.getByRole("button", { name: "Serie di Fourier", exact: true }).click();
      await expect(dialog).toBeVisible();
      await expect(
        dialog.getByText(/^(Salvata da appunti\.example\.org il|Saved from appunti\.example\.org on) /),
      ).toBeVisible();
      break;
    case "plan-sources-removed": {
      const row = page.getByRole("button", { name: "Esercitazioni Analisi 1 2025", exact: true });
      await expect(row).toBeVisible();
      // Removed elsewhere after the exam was read, as a confirmed removal does: the source and its link to the exam.
      withDb((db) =>
        db.exec(`UPDATE sources SET status = 'removed' WHERE id = 'audit-panel-pdf';
          DELETE FROM plan_sources WHERE source_id = 'audit-panel-pdf';`),
      );
      await row.click();
      await expect(
        dialog.getByText(
          both("Questa fonte non è più nella libreria.", "This source is no longer in the library."),
        ),
      ).toBeVisible();
      await expect(row).toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      // The row it came from is gone, so focus goes to the page heading rather than nowhere.
      await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
      break;
    }
    case "library-panel-removed": {
      const row = page.getByRole("button", { name: "Esercitazioni Analisi 1 2025", exact: true });
      await expect(row).toBeVisible();
      // Removed behind the list's back, as another window or a cleanup would: the row is still on screen.
      withDb((db) =>
        db.prepare("UPDATE sources SET status = 'removed' WHERE id = 'audit-panel-pdf'").run(),
      );
      await row.click();
      await expect(
        dialog.getByText(
          both("Questa fonte non è più nella libreria.", "This source is no longer in the library."),
        ),
      ).toBeVisible();
      await expect(
        dialog.getByRole("button", { name: both("Apri la fonte", "Open source") }),
      ).toBeDisabled();
      break;
    }
    case "plan-sources-panel": {
      const row = page.getByRole("button", { name: source });
      await row.click();
      await expect(dialog).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(row).toBeFocused();
      await row.click();
      await expect(
        dialog.getByRole("heading", { name: both("Negli esami", "In exams") }),
      ).toBeVisible();
      await expect(dialog.getByText("Fisica 1", { exact: true })).toBeVisible();
      break;
    }
    case "library-panel-scan":
      await page
        .getByRole("button", { name: "Appello 10 febbraio 2025", exact: true })
        .click();
      await expect(dialog).toBeVisible();
      await expect(
        dialog.getByRole("heading", { name: both("Come la sto leggendo", "How I'm reading it") }),
      ).toBeVisible();
      await expect(
        dialog.getByRole("button", { name: both("Interrompi la lettura", "Stop reading") }),
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
        .locator(".px-engine-open")
        .first()
        .click();
      await expect(dialog).toBeVisible();
      break;
    case "engine-details-disabled":
      await openAdvancedEngines(page);
      await page
        .getByRole("button", { name: /^Antigravity/ })
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
      await expect(
        page.getByRole("heading", {
          name: both("Simulazioni", "Simulations"),
          level: 2,
        }),
      ).toBeVisible();
      await page.locator(".px-progress-simulations").scrollIntoViewIfNeeded();
      await expect(page.locator(".px-progress-simulations")).toBeVisible();
      await expect(
        page.getByRole("button", {
          name: /^(Apri la prova del|Open exam from) /,
        }),
      ).toBeVisible();
      break;
    case "progress-pace":
      await page
        .getByRole("heading", { name: both("Ritmo", "Pace"), level: 2 })
        .scrollIntoViewIfNeeded();
      await expect(
        page.getByRole("heading", { name: both("Ritmo", "Pace"), level: 2 }),
      ).toBeVisible();
      break;
    case "export-lesson":
      await page
        .getByRole("button", { name: both("Altre azioni", "More actions") })
        .click();
      await page
        .getByRole("menuitem", { name: both("Esporta", "Export") })
        .click();
      await expect(
        page
          .getByRole("dialog")
          .last()
          .getByRole("button", { name: both("Salva file", "Save file") }),
      ).toBeVisible();
      break;
    case "export-cards":
    case "export-simulation":
      await openExport(page);
      break;
    case "cards-browser":
      await expect(
        page.getByRole("heading", { level: 2, name: "Chimica" }),
      ).toBeVisible();
      await expect(
        page.getByRole("heading", {
          level: 2,
          name: both("Nessuna materia", "No subject"),
        }),
      ).toBeVisible();
      await expect(
        page.locator(".px-cardbrowser-row .katex").first(),
      ).toBeVisible();
      break;
    case "cards-browser-empty":
      await expect(
        page.getByRole("heading", {
          name: both("Ancora nessuna flashcard", "No flashcards yet"),
        }),
      ).toBeVisible();
      break;
    case "cards-browser-none":
      await page
        .getByRole("textbox", {
          name: both("Cerca nelle flashcard", "Search flashcards"),
        })
        .fill("zzzz");
      await expect(
        page.getByText(both("Nessuna flashcard corrisponde.", "No flashcard matches.")),
      ).toBeVisible();
      break;
    case "cards-browser-edit":
      await page
        .getByRole("button", {
          name: /^(Modifica|Edit): Che cos’è il numero atomico/,
        })
        .click();
      await expect(dialog).toBeVisible();
      break;
    case "cards-browser-delete":
      await page
        .getByRole("button", {
          name: /^(Altre azioni|More actions): Che cos’è il numero atomico/,
        })
        .click();
      await page
        .getByRole("menuitem", { name: both("Elimina", "Delete") })
        .click();
      await expect(dialog).toBeVisible();
      break;
    case "export-plan":
    case "export-plan-embed":
      await page
        .getByRole("button", {
          name: both("Impostazioni dell'esame", "Exam settings"),
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

/**
 * The 2px focus ring on antd's Select and DatePicker (the theme turns off their glow) and on the Ask composer
 * shows when focus arrived by keyboard and stays off for a click. A key press before a programmatic focus()
 * stands in for Tab: the ring follows the input that led to the focus, not the call that moved it.
 */
async function focusRingChecks(page: Page, name: string) {
  const cases: { field: string; frame: string }[] = [];
  if (name === "exams")
    cases.push({ field: "#plan-subject-filter", frame: ".ant-select-focused" });
  if (name === "ask-new")
    cases.push({ field: ".px-composer-field", frame: ".px-composer" });
  if (name.startsWith("wizard-") && (await page.locator("#plan-date").isVisible()))
    cases.push({ field: "#plan-date", frame: ".ant-picker-focused" });
  const outline = (frame: string) =>
    page
      .locator(frame)
      .first()
      .evaluate((el) => {
        const style = getComputedStyle(el);
        return `${style.outlineStyle} ${style.outlineWidth}`;
      });
  const release = async () => {
    await page.keyboard.press("Escape");
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  };
  for (const { field, frame } of cases) {
    await release();
    await page.keyboard.press("Shift");
    await page.locator(field).focus();
    expect(await outline(frame), `${name}: keyboard focus on ${field} shows the ring`).toBe(
      "solid 2px",
    );
    await release();
    await page.locator(field).click({ force: true });
    expect(
      await outline(frame),
      `${name}: a click on ${field} leaves the ring off`,
    ).toMatch(/^none/);
    await release();
  }
}

async function keyboardCheck(page: Page, name: string) {
  const dialogOpen = (await page.getByRole("dialog").count()) > 0;
  const surface = dialogOpen ? page.getByRole("dialog").last() : page;
  const controls = surface.locator(
    'button:visible:not([disabled]),input:visible:not([disabled]),textarea:visible:not([disabled]),select:visible:not([disabled]),[tabindex="0"]:visible',
  );
  const first = controls.first();
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
  // Opening a dialog from a menu can move focus once more after it shows; on a slow runner
  // that lands between these steps, so start over until focus and Tab both hold.
  let next = { tag: "BODY" as string | undefined, hidden: true };
  const single = dialogOpen && (await controls.count()) === 1;
  await expect(async () => {
    await first.focus();
    await expect(first).toBeFocused({ timeout: 1000 });
    await page.keyboard.press("Tab");
    next = await readNext();
    if (!single) expect(next.tag).not.toBe("BODY");
  }).toPass({ timeout: 10000 });
  // A dialog whose only control is its close button has no later stop. Tab
  // leaves the page for the window boundary (BODY) and the focus lock pulls
  // the next Tab back, so that return is what proves the dialog traps focus.
  if (single && next.tag === "BODY") {
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
  if (name === "exams" || name === "ask-new" || name.startsWith("wizard-"))
    await focusRingChecks(page, name);
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
  if (name === "practice-rated") {
    // Changing the rating moves the pressed state and keeps focus on the button that was used.
    const missed = page.getByRole("button", {
      name: both("Non ce l'ho fatta", "Missed it"),
    });
    await missed.focus();
    await page.keyboard.press("Space");
    await expect(missed).toHaveAttribute("aria-pressed", "true");
    await expect(missed).toBeFocused();
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
    const choice = page.locator(".px-opt").first();
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
  // books.politost.it as a folder: the catalog lists the seeded free book at a newer version. Nothing is downloaded.
  const booksSite = mkdtempSync(join(tmpdir(), "pyxis-ui-audit-books-"));
  writeFileSync(
    join(booksSite, "catalog.json"),
    JSON.stringify({
      catalogVersion: 1,
      books: [
        {
          id: "fisica-demo",
          title: "Fisica di prova",
          subject: "Fisica",
          authors: ["PoliTost"],
          version: "1.1.0",
          chapters: 3,
          package: "books/fisica-demo@1.1.0.ptsb",
          bytes: 1024,
          sha256: "b".repeat(64),
        },
      ],
    }),
  );
  const env = {
    PYXIS_E2E_BOOKS: booksSite,
    PYXIS_E2E_FILE: importFolder,
    ...updateEnv(),
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
  const app = await launchPyxis({ userData, env });
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
  mkdirSync(".tmp", { recursive: true });
  mkdirSync(dirname(recordFile), { recursive: true });
  try {
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    // The first render waits for core to start, which takes far longer than 7 s on a cold hosted Windows runner.
    await page
      .getByRole("button", { name: "Salta" })
      .click({ timeout: 90_000 });
    page.setDefaultTimeout(7000);
    await page.evaluate(() => window.pyxis.invoke("plans.list", {}));
    // The fake release keeps its banner closed, so it covers no other state; Settings > Updates still shows it.
    await page.evaluate(
      (tag) => localStorage.setItem("pyxis-dismissed-release", tag),
      updateTag,
    );
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
            process.env.PYXIS_UI_LARGE ? ("lg" as const) : ("md" as const),
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
              if (name === "library-import") {
                await page
                  .getByRole("button", {
                    name: /Aggiungi fonti|Add sources/,
                    exact: true,
                  })
                  .click();
                // The dialog mounts a frame after the click; the keyboard check needs it there.
                await expect(page.getByRole("dialog")).toBeVisible();
              }
              if (name === "plan-settings")
                await page
                  .getByRole("button", {
                    name: /Impostazioni dell'esame|Exam settings/,
                    exact: true,
                  })
                  .click();
              if (name === "plan-create") {
                // Creating an activity by hand sits in the header's More menu.
                await page.locator(".px-plan-header-actions").getByRole("button", { name: /^(Altro|More)$/ }).click();
                await page.getByRole("menuitem", { name: /Crea lezione|Create lesson/ }).click();
                await expect(page.getByRole("dialog")).toBeVisible();
              }
              if (name === "plan-done") {
                await page.locator(".px-path-summary").click();
                await expect(page.getByRole("list", { name: /Passi fatti|Steps done/ })).toBeVisible();
              }
              if (name === "plan-chooser") {
                await page
                  .locator(".px-path-next")
                  .getByRole("button", { name: /^(Scegli un'altra attività|Choose another activity)$/ })
                  .click();
                await expect(page.locator(".px-path-chooser")).toBeVisible();
              }
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
                (name === "library-row-menu" ||
                  name === "exams-import-menu" ||
                  name === "map-export") &&
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
              const violations = await axeViolations(page);
              await saveShot(page, `m14/${key}.png`, { fullPage: true, animations: "disabled" });
              // Fixed headers and modal backdrops are viewport-bound; keep a real viewport capture alongside the full-page image.
              await saveShot(page, `m14/${key}.viewport.png`, { fullPage: false, animations: "disabled" });
              const errors = pageErrors.slice(before);
              const untranslated = (await page.locator("body").innerText())
                .match(untranslatedKey)
                ?.filter((match) => !notKeys.has(match.replace(/\.+$/, "")));
              if (untranslated?.length)
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
    rmSync(booksSite, { recursive: true, force: true });
    rmSync(updateFolder, { recursive: true, force: true });
  }
  expect(failures, failures.join("\n")).toEqual([]);
});
