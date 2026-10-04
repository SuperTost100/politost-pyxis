import AxeBuilder from "@axe-core/playwright";
import {
  _electron as electron,
  expect,
  test,
  type Page,
} from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

// Native Electron is required: these routes consume the utility-process IPC port.
const routes = [
  ["root", "/"],
  ["onboarding", "/onboarding"],
  ["ask-new", "/ask"],
  ["ask-thread", "/ask/audit-chat"],
  ["exams", "/exams"],
  ["library", "/exams/library"],
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
  ["reading-large-lesson", "/plans/audit-plan/lesson/audit-topic"],
  ["reading-large-progress", "/plans/audit-plan/progress"],
] as const;

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

const both = (it: string, en: string) => new RegExp(`^(${it}|${en})$`);

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

async function openState(page: Page, name: string) {
  const dialog = page.getByRole("dialog");
  const source = /^Appunti di fisica$/;
  switch (name) {
    case "import-review": {
      const before = await page.evaluate(() => window.pyxis.invoke("plans.list", {}));
      const file = await page.evaluate(() => window.pyxis.invoke("plans.export", { planId: "audit-plan" }));
      await page.locator('input[type="file"]').first().setInputFiles({ name: "review.pyxis", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(file)) });
      await expect(page.locator(".px-import-review")).toBeVisible();
      const after = await page.evaluate(() => window.pyxis.invoke("plans.list", {}));
      expect(after).toHaveLength(before.length);
      break;
    }
    case "lesson-rewrite":
      await page.getByRole("button", { name: both("Riscrivi", "Rewrite"), exact: true }).click();
      await expect(page.getByText(/Riscrivere questa lezione|Rewrite this lesson/)).toBeVisible();
      break;
    case "lesson-flag":
      await page.getByRole("button", { name: both("Segnala", "Report"), exact: true }).click();
      await expect(page.getByRole("textbox", { name: /Cosa non va|What is wrong/ })).toBeVisible();
      break;
    case "quiz-setup":
      await expect(page.getByRole("slider", { name: /Numero di domande|Number of questions/ })).toBeVisible();
      break;
    case "quiz-page":
      await page.getByRole("button", { name: /^(Una pagina|One page)$/ }).click();
      await expect(page.getByRole("spinbutton")).toBeVisible();
      break;
    case "quiz-timed":
      await page.getByRole("checkbox", { name: /Imposta un limite|Set a time limit/ }).check();
      await expect(page.getByRole("spinbutton")).toBeVisible();
      break;
    case "jobs-popover":
      await page
        .getByRole("button", { name: /attività|background tasks|jobs running/ })
        .click();
      await expect(page.locator(".job-list")).toBeVisible();
      break;
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
      await page
        .getByRole("button", { name: /^(Dettagli di|Details for) / })
        .first()
        .click();
      await expect(dialog).toBeVisible();
      break;
    case "engine-details-disabled":
      await page
        .getByRole("button", {
          name: /^(Dettagli di|Details for) .*(Antigravity)/i,
        })
        .click();
      await expect(dialog).toBeVisible();
      break;
    case "engine-add-cli":
      await page
        .getByRole("button", { name: both("Aggiungi motore", "Add engine") })
        .click();
      await expect(dialog.getByRole("tab", { selected: true })).toBeVisible();
      break;
    case "engine-add-key":
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
  const surface = (await page.getByRole("dialog").count())
    ? page.getByRole("dialog").last()
    : page;
  const first = surface
    .locator(
      'button:visible:not([disabled]),input:visible:not([disabled]),textarea:visible:not([disabled]),select:visible:not([disabled]),[tabindex="0"]:visible',
    )
    .first();
  await first.focus();
  await expect(first).toBeFocused();
  await page.keyboard.press("Tab");
  const next = await page.evaluate(() => {
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
  // The e2e seam answers every native picker with this path: a folder of two importable files for the Folder tab.
  const importFolder = mkdtempSync(join(tmpdir(), "pyxis-ui-audit-folder-"));
  writeFileSync(
    join(importFolder, "appunti.txt"),
    "La forza è massa per accelerazione.",
  );
  writeFileSync(join(importFolder, "formule.md"), "# Formule\n\n$F=ma$");
  const env = {
    ...process.env,
    PYXIS_USER_DATA: userData,
    PYXIS_E2E: "1",
    PYXIS_E2E_FILE: importFolder,
    PYXIS_E2E_REPLY: "La forza è $F=ma$ [P1].",
    PYXIS_E2E_PLAN_REPLIES: JSON.stringify({
      markdown: {
        markdown: "# La dinamica\n\nLa seconda legge di Newton è $F=ma$ [P1].",
      },
    }),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    args: [join(process.cwd(), "out/main/index.js")],
    env,
  });
  const records: unknown[] = [];
  const failures: string[] = [];
  const selectedStates = process.env.PYXIS_UI_STATES?.split(",");
  const auditRoutes = selectedStates
    ? routes.filter(([name]) => selectedStates.includes(name))
    : routes;
  expect(auditRoutes.length).toBeGreaterThan(0);
  mkdirSync(".shots/m14", { recursive: true });
  mkdirSync(".tmp", { recursive: true });
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
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"));
    seed(db);
    db.close();
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    for (const language of ["it", "en"] as const)
      for (const theme of ["dark", "light"] as const)
        for (const width of [1280, 960]) {
          await page.evaluate(
            async ({ language, theme }) => {
              localStorage.setItem("pyxis.lang", language);
              await window.pyxis.setAppearance(theme);
            },
            { language, theme },
          );
          await page.setViewportSize({ width, height: 800 });
          await page.evaluate((textSize: "md" | "lg") =>
            window.pyxis.invoke("profile.save", { dyslexia: false, textSize }),
            process.env.PYXIS_UI_LARGE ? "lg" : "md",
          );
          for (const [name, route] of auditRoutes) {
            const key = `${name}-${language}-${theme}-${width}${process.env.PYXIS_UI_LARGE ? "-large" : ""}`;
            const before = pageErrors.length;
            try {
              await page.evaluate((route) => {
                location.hash = route;
              }, route);
              await page.reload();
              await expect(page.locator("h1:visible").first()).toBeVisible();
              if (name.startsWith("wizard-")) {
                const step = Number(name.split("-")[1]);
                await page
                  .getByRole("textbox", { name: /Titolo|Title/, exact: true })
                  .fill("Fisica audit");
                for (let next = 1; next < step; next++)
                  await page
                    .getByRole("button", {
                      name: /Continua|Continue/,
                      exact: true,
                    })
                    .click();
              }
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
              ).match(
                /\b(?:plans|quiz|simulation|jobs|lesson|engines|sources|wizard)\.[A-Za-z][\w.-]+/g,
              );
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
              selectedStates
                ? ".tmp/m14-ui-audit-filter.json"
                : process.env.PYXIS_UI_LARGE ? ".tmp/m14-ui-audit-large.json" : ".tmp/m14-ui-audit.json",
              JSON.stringify({ routes, records, failures }, null, 2),
            );
            console.log(
              `M14 ${key}: ${failures.at(-1)?.startsWith(key) ? failures.at(-1) : "passed"}`,
            );
          }
        }
  } finally {
    writeFileSync(
      selectedStates
        ? ".tmp/m14-ui-audit-filter.json"
        : process.env.PYXIS_UI_LARGE ? ".tmp/m14-ui-audit-large.json" : ".tmp/m14-ui-audit.json",
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
