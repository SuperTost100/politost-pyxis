import { axeViolations } from "./axe";
import {
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { createHash } from "node:crypto";
import {
  chmodSync,
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
import { docx } from "./source-panel-fixture";
import { manyPagePdf } from "../../src/core/sources/test-pdf";
import { launchPyxis } from "./app-under-test";
import { seedPlan, seedSource, seedSubjects } from "./seed";
import { atRest } from "./settled";
import { SHOTS, saveShot } from "./shots";
import { removeTestFolder } from "./cleanup";
import { answerNextMenu } from "./native-menu";
import { radialFixtures, storedGraph } from "../fixtures/maps";
import type Database from "better-sqlite3";
import { partMarkdown, seedOutline, type SeedPart } from "../../src/core/study/test-parts";

// Native Electron is required: these routes consume the utility-process IPC port.
const routes = [
  ["root", "/"],
  ["onboarding", "/onboarding"],
  ["onboarding-again", "/onboarding?again=1"],
  // Setup step 2 with engines in every state: ready, signed out, sign-in expired, not installed. Automatic, then with
  // the student picking the engines.
  ["onboarding-engines", "/onboarding"],
  ["onboarding-engines-chosen", "/onboarding"],
  // Setup step 3: how the material is kept, where the folder is, and the subjects found in a linked study folder.
  ["onboarding-material", "/onboarding"],
  ["onboarding-material-folder", "/onboarding"],
  ["onboarding-material-subjects", "/onboarding"],
  ["ask-new", "/ask"],
  ["ask-thread", "/ask/audit-chat"],
  ["exams", "/exams"],
  ["exams-empty", "/exams"],
  ["exams-import-menu", "/exams"],
  // The page's menu, opened from the dots in the head of the exam page, the Library and the flashcard browser.
  ["plan-menu", "/plans/audit-plan"],
  ["library-menu", "/exams/library"],
  ["cards-browser-menu", "/flashcards/all"],
  // An archived exam under the open Archiviati toggle.
  ["exams-archived", "/exams"],
  ["library", "/exams/library"],
  // The Library with no sources: the empty state and its two ways in, no search or filters.
  ["library-empty", "/exams/library"],
  // Passage search: the same field with the Content scope, its results and the local model offer.
  ["library-search", "/exams/library"],
  // The flashcard browser: cards grouped by subject, no cards at all, a search with no match, and its two dialogs.
  ["cards-browser", "/flashcards/all"],
  ["cards-browser-empty", "/flashcards/all"],
  ["cards-browser-none", "/flashcards/all"],
  ["cards-browser-edit", "/flashcards/all"],
  ["cards-browser-delete", "/flashcards/all"],
  // The same list opened from the exam's page: Esami stays lit and the back control names the exam.
  ["cards-browser-from-exam", "/plans/audit-chem-plan"],
  ["flashcards", "/flashcards"],
  ["flashcards-empty", "/flashcards"],
  ["flashcards-none-due", "/flashcards"],
  // "Nuova flashcard": written by hand with a formula, Pyxis's side, Pyxis at work, and its flashcards to check.
  ["flashcards-new-hand", "/flashcards"],
  ["flashcards-new-pyxis", "/flashcards"],
  ["flashcards-new-working", "/flashcards"],
  ["flashcards-new-review", "/flashcards"],
  // Nuova flashcard closed with a card written: the same question as leaving a page, over the dialog.
  ["flashcards-new-leave", "/flashcards"],
  // The mistakes notebook, which lives only under Exams.
  ["mistakes", "/exams/mistakes"],
  // The same page opened from an exam, which its way back names.
  ["mistakes-from-exam", "/plans/audit-plan"],
  // The due flashcards from every plan, as the exam list's line opens them.
  ["cards-due", "/cards/due"],
  ["cards-due-delete", "/cards/due"],
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
  // AI tools with the advanced options open (which engines Pyxis may use), then in debug mode (the week's tokens).
  ["settings-engines-advanced", "/settings/engines"],
  ["settings-engines-debug", "/settings/engines"],
  ["gallery", "/dev/gallery"],
  // The one dialog in its three kinds, from the gallery: a confirmation that deletes, a form, one that only informs.
  ["gallery-dialog-confirm", "/dev/gallery"],
  ["gallery-dialog-form", "/dev/gallery"],
  ["gallery-dialog-info", "/dev/gallery"],
  ...[1, 2].map((step) => [`wizard-${step}`, "/plans/new"] as const),
  ["wizard-leave", "/plans/new"],
  // The wait while an exam builds: working, ready, and stopped by the student.
  ["build-running", "/plans/new?build=audit-plan"],
  ["build-done", "/plans/new?build=audit-plan"],
  ["build-cancelled", "/plans/new?build=audit-plan"],
  ["plan", "/plans/audit-plan"],
  ["plan-dated", "/plans/audit-ready-plan"],
  // The same exam with hours set in the planner: its topic and simulation rows carry expected days.
  ["plan-dated-planner", "/plans/audit-ready-plan"],
  // The exam page with finished steps on its open topic, and with an open gap that offers Ripasso mirato.
  ["plan-done", "/plans/audit-plan"],
  ["plan-gaps", "/plans/audit-plan"],
  ["plan-sources", "/plans/audit-plan/sources"],
  ["plan-settings", "/plans/audit-plan/settings"],
  // The same page with a goal and a name changed, so the save bar lists them.
  ["plan-settings-changes", "/plans/audit-plan/settings"],
  ["plan-settings-delete", "/plans/audit-plan/settings"],
  // The same changes, and the sidebar's Esami asks before they are lost.
  ["plan-settings-leave", "/plans/audit-plan/settings"],
  ["plan-create", "/plans/audit-plan"],
  // "Crea un'attività" on a simulation, with its length and material in place.
  ["plan-create-simulation", "/plans/audit-plan"],
  // "Da finire" with seven activities: one being written, one on a very long topic, a prepared simulation; and its menu.
  ["plan-unfinished", "/plans/audit-plan"],
  ["plan-unfinished-menu", "/plans/audit-plan"],
  // An exam whose lesson on one topic is in parts: Consigliato adesso names the next part and the path lists the parts,
  // Riprendi da on a later day, and Scegli altro open.
  ["plan-now-part", "/plans/audit-exam-parts-plan"],
  ["plan-resume", "/plans/audit-exam-parts-plan"],
  ["plan-now-other", "/plans/audit-exam-parts-plan"],
  ["library-import", "/exams/library"],
  // Overlay states below are reached by role-based interaction (Ant Design 6 drawers and modals are role="dialog").
  ["library-row-menu", "/exams/library"],
  // Files added from the Library: Pyxis choosing one's subject and a subject it made, the files the student places,
  // and a row's "Sposta in".
  ["library-sorting", "/exams/library"],
  ["library-unsorted", "/exams/library"],
  ["library-move-menu", "/exams/library"],
  // A shelf with a file of each of the seven kinds, one being read and one that failed, and a file's "Tipo" open.
  ["library-kinds", "/exams/library"],
  ["library-kind-menu", "/exams/library"],
  // The shelf by subject: a subject's menu by its dots, and an empty subject's menu by a right-click on its name, with
  // Elimina only there.
  ["library-subject-menu", "/exams/library"],
  ["library-empty-subject", "/exams/library"],
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
  // The linked folders in the Library's head: the control, its list open, a folder no longer on disk, and unlinking one.
  ["library-folders", "/exams/library"],
  ["library-folders-open", "/exams/library"],
  ["library-folders-missing", "/exams/library"],
  ["library-folders-unlink", "/exams/library"],
  ["library-link", "/exams/library"],
  ["library-text", "/exams/library"],
  ["library-text-ready", "/exams/library"],
  ["source-viewer", "/exams/library"],
  // The source panel at a PDF's cited page with the passage marked, on a Word file it shows as read text, and on a file
  // of a linked folder that was moved away.
  ["source-panel-pdf", "/exams/library"],
  ["source-panel-text", "/exams/library"],
  ["source-panel-missing", "/exams/library"],
  ["engine-details", "/settings/engines"],
  ["engine-details-disabled", "/settings/engines"],
  ["engine-add-cli", "/settings/engines"],
  ["engine-add-key", "/settings/engines"],
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
  // Old lessons in parts: a finished lesson written before parts with "Riscrivi in parti" in its menu and its
  // confirmation; an unfinished one being rewritten, its earlier version read-only, and the rewrite that found no AI tool.
  ["lesson-menu-parts", "/plans/audit-plan/lesson/audit-topic"],
  ["lesson-rewrite-parts", "/plans/audit-plan/lesson/audit-topic"],
  ["lesson-rewriting-old", "/plans/audit-plan/lesson/audit-topic?part=1"],
  ["lesson-earlier", "/plans/audit-plan/lesson/audit-topic?item=audit-lesson"],
  ["lesson-rewrite-failed", "/plans/audit-plan/lesson/audit-topic?part=1"],
  // A topic's lesson in parts: part 3 of 8 with the parts column, its question answered and the foot active, "Scegli
  // altro" open, part 4 being written and failed, the recap answered, a topic of one part, and the parts in the popover
  // the bar's title opens under 1,100 px.
  ["lesson-part", "/plans/audit-parts-plan/lesson/audit-parts-topic?part=3"],
  ["lesson-part-answered", "/plans/audit-parts-plan/lesson/audit-parts-topic?part=3"],
  ["lesson-part-other", "/plans/audit-parts-plan/lesson/audit-parts-topic?part=3"],
  ["lesson-part-writing", "/plans/audit-parts-plan/lesson/audit-parts-topic?part=4"],
  ["lesson-part-failed", "/plans/audit-parts-plan/lesson/audit-parts-topic?part=4"],
  ["lesson-part-failed-dismissed", "/plans/audit-parts-plan/lesson/audit-parts-topic?part=4"],
  ["lesson-part-recap", "/plans/audit-parts-plan/lesson/audit-parts-topic?part=9"],
  ["lesson-part-popover", "/plans/audit-parts-plan/lesson/audit-parts-topic?part=3"],
  ["lesson-one-part", "/plans/audit-parts-plan/lesson/audit-one-topic?part=1"],
  // A topic opened for the first time while its parts are planned, and a part read as book text without an AI tool.
  ["lesson-part-planning", "/plans/audit-parts-plan/lesson/audit-new-topic?part=1"],
  ["lesson-part-book", "/plans/audit-parts-plan/lesson/audit-parts-topic?part=5"],
  // Level and rewrites on a part.
  ["lesson-part-menu", "/plans/audit-parts-plan/lesson/audit-parts-topic?part=3"],
  ["lesson-part-level", "/plans/audit-parts-plan/lesson/audit-parts-topic?part=3"],
  ["lesson-part-rewrite", "/plans/audit-parts-plan/lesson/audit-parts-topic?part=3"],
  ["lesson-part-section", "/plans/audit-parts-plan/lesson/audit-parts-topic?part=3"],
  ["lesson-part-rewriting", "/plans/audit-parts-plan/lesson/audit-parts-topic?part=3"],
  ["lesson-part-rewrite-failed", "/plans/audit-parts-plan/lesson/audit-parts-topic?part=3"],
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
  // The study bar's New flashcard form, open over the card.
  ["cards-new", "/plans/audit-plan/cards/audit-topic"],
  // The answer sheet: an open answer with the formula keys, and Consegna's question with blank and marked answers.
  ["quiz-open", "/plans/audit-plan/quiz/audit-topic?attempt=audit-sheet-attempt"],
  ["quiz-handin", "/plans/audit-plan/quiz/audit-topic?attempt=audit-sheet-attempt"],
  ["simulation-setup", "/plans/audit-plan/simulation"],
  // A simulation being answered, on the same sheet, with one question marked for later.
  ["simulation-run", "/plans/audit-plan/exam/audit-run-attempt"],
  ["simulation-ready", "/plans/audit-ready-plan/simulation"],
  ["simulation-result", "/plans/audit-plan/exam/audit-exam-attempt"],
  ["map", "/plans/audit-plan/map/audit-topic"],
  // The Maps section: maps by subject, no map at all, a search with no match, the new-map dialog, and a map opened from it with its export menu.
  ["maps", "/maps"],
  ["maps-empty", "/maps"],
  ["maps-none", "/maps"],
  ["maps-new", "/maps"],
  // The new-map dialog for a subject whose exams have topics (the topic select shown) and for one without (no select).
  ["maps-new-topics", "/maps"],
  ["maps-new-no-topics", "/maps"],
  // The map's dots menu (Rinomina, Esporta and Elimina la mappa…), with Esporta's formats open, the map's name edited in
  // place, and the confirmation before it is deleted.
  ["map-menu", "/plans/audit-plan/map/audit-topic?from=maps&map=audit-map-entry"],
  // A map with the topic's last build failed, or cut off, still stored: the line under the head offers it again.
  ["map-build-failed", "/plans/audit-plan/map/audit-topic?from=maps&map=audit-map-entry"],
  ["map-build-stopped", "/plans/audit-plan/map/audit-topic?from=maps&map=audit-map-entry"],
  ["map-export", "/plans/audit-plan/map/audit-topic?from=maps&map=audit-map-entry"],
  ["map-rename", "/plans/audit-plan/map/audit-topic?from=maps&map=audit-map-entry"],
  ["map-delete", "/plans/audit-plan/map/audit-topic?from=maps&map=audit-map-entry"],
  // A subject with two maps: the switcher beside the title, open on both.
  ["map-switcher", "/maps/audit-chem?from=maps&map=audit-chem-map-entry"],
  // A tile's menu on Mappe, opened by a right-click, and its delete confirmation.
  ["maps-tile-menu", "/maps"],
  ["maps-delete", "/maps"],
  // A map of the whole subject, and a topic's map at its subject address with a concept's source open beside it.
  ["map-subject", "/maps/audit-subject?from=maps&map=audit-subject-map-entry"],
  // Two maps in the radial layout: one with long labels, uneven branches and links across them, open; one of sixty
  // concepts, opened folded, with one branch unfolded.
  ["map-radial-film", "/maps/audit-cinema?from=maps&map=audit-film-entry"],
  ["map-radial-physics", "/maps/audit-cinema?from=maps&map=audit-physics-entry"],
  ["map-source", "/maps/audit-subject/audit-topic?from=maps&map=audit-map-entry"],
  ["map-cards", "/maps/audit-subject/audit-topic?from=maps&map=audit-map-entry"],
  ["map-cards-no-exam", "/maps/audit-chem?from=maps&map=audit-chem-map-entry"],
  ["whiteboard", "/tools/whiteboard"],
  // A stroke not saved, and the board's Chiudi asks before it is lost.
  ["whiteboard-leave", "/tools/whiteboard"],
  ["graph", "/tools/graph"],
  ["python", "/tools/python"],
  ["jobs-popover", "/exams"],
  // A linked folder's readings as one row, opened on its files; and a map being built, with the working mark.
  ["jobs-group", "/exams"],
  ["map-building", "/plans/audit-ready-plan/map/audit-ready-topic"],
  // The same build asked for in the student's own words, which the working state shows in a line under its own.
  ["map-building-asked", "/plans/audit-ready-plan/map/audit-ready-topic"],
  // A request whose words matched nothing in the material: no map, the message and the words ready to change.
  ["map-nothing-matched", "/plans/audit-ready-plan/map/audit-ready-topic"],
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
    "/plans/audit-review-plan/review/questions?attempt=audit-review-attempt",
  ],
  ["rebuild-intro", "/plans/audit-plan/settings"],
  ["rebuild-running", "/plans/audit-plan/settings"],
  ["rebuild-failed", "/plans/audit-plan/settings"],
  ["rebuild-interrupted", "/plans/audit-plan/settings"],
  ["rebuild-review", "/plans/audit-plan/settings"],
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
  // A chat made from a lesson's selection: its header has the way back to the lesson.
  ["ask-from-lesson", "/plans/audit-plan/lesson/audit-topic"],
  ["reading-large-lesson", "/plans/audit-plan/lesson/audit-topic"],
  ["reading-large-exam", "/plans/audit-plan"],
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
  // The same, over the map's page, which fills the window, and over the Library: Resume sits in the top strip and the
  // page keeps its height.
  ["map-exam-active", "/plans/audit-plan/map/audit-topic"],
  ["library-exam-active", "/exams/library"],
  ["library-ocr-refused", "/exams/library"],
  ["library-ocr-ready", "/exams/library"],
  ["ask-ocr-refused", "/ask"],
  ["ask-ocr-ready", "/ask"],
  // The chat panel and search; the subject chip's menu on a chat with a very long subject, and on a new chat's first page.
  ["ask-panel", "/ask/audit-chat"],
  ["ask-search", "/ask/audit-chat"],
  ["ask-search-empty", "/ask/audit-chat"],
  ["ask-subject-menu", "/ask/audit-guided"],
  ["ask-new-subject-menu", "/ask"],
  // A guided answer, with "Dammi la soluzione" under it, and an answer from general knowledge that says so.
  ["ask-guided", "/ask/audit-guided"],
  ["ask-general", "/ask/audit-general"],
  // The confirmations behind a solid danger button: delete a chat and delete a hand-made flashcard.
  ["ask-delete", "/ask/audit-chat"],
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
    INSERT INTO message_passages(message_id,passage_id,label) VALUES('audit-assistant','audit-passage','P1');
    INSERT INTO chats(id,title,scope_json,subject,created_at,updated_at) VALUES('audit-guided','Accelerazione, passo per passo','{"sourceIds":[],"subjectBy":"pyxis"}','Linguaggio cinematografico e storia del cinema italiano del dopoguerra',1,1);
    INSERT INTO messages(id,chat_id,role,body,created_at) VALUES('audit-guided-user','audit-guided','user','Non ho capito come si trova la forza, mi aiuti?',1);
    INSERT INTO messages(id,chat_id,role,body,grounding,prompt_template,created_at) VALUES('audit-guided-reply','audit-guided','assistant','Facciamolo un passo alla volta. La forza dipende dalla massa e dall''accelerazione [P1].

Passo 1 di 2: quale legge lega le tre grandezze?','sources','chat.socratic',2);
    INSERT INTO message_passages(message_id,passage_id,label) VALUES('audit-guided-reply','audit-passage','P1');
    INSERT INTO chats(id,title,created_at,updated_at) VALUES('audit-general','Teorema di Bayes',1,1);
    INSERT INTO messages(id,chat_id,role,body,created_at) VALUES('audit-general-user','audit-general','user','Che cos''è il teorema di Bayes?',1);
    INSERT INTO messages(id,chat_id,role,body,grounding,prompt_template,passages_json,created_at) VALUES('audit-general-reply','audit-general','assistant','Il teorema di Bayes dice come cambia la probabilità di un''ipotesi dopo un fatto osservato: $P(A|B) = P(B|A)P(A)/P(B)$.','general','chat.solver','{"found":false,"where":"files"}',2);`);
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
        "## La dinamica\n\nLa seconda legge di Newton è $F=ma$ [P1].\n\n## Un esempio in $\\mathbb{R}^n$\n\nCon una massa di $2\\,kg$ e un’accelerazione di $3\\,m/s^2$,\n\n$$F=2\\cdot3=6\\,N.$$",
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
  // The subject's own map, with no exam: the same concepts under the subject's name.
  db.prepare(
    "INSERT INTO maps(id,subject_id,graph_json,grounding,created_at) VALUES('audit-subject-map','audit-subject',?,'sources',1)",
  ).run(
    JSON.stringify({
      version: 1,
      maps: [
        {
          id: "audit-subject-map-entry",
          title: "Fisica",
          passageIds: ["audit-passage"],
          graph: {
            ...graph,
            nodes: graph.nodes.map((node) => (node.parent ? node : { ...node, label: "Fisica" })),
          },
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
/** Whether the app's sidebar is folded to icons, as it is below 1100px. */
const sidebarFolded = async (page: Page) =>
  (await page.locator(".px-side").getAttribute("data-folded")) !== null;

/** Opens a file's details from its menu: a click on the file opens the source panel instead. */
async function openDetails(page: Page, title: string) {
  await page.getByRole("button", { name: both(`Azioni per ${title}`, `Actions for ${title}`) }).click();
  await page.getByRole("menuitem", { name: both("Dettagli della fonte", "Source details") }).click();
}

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
    .getByRole("button", { name: both("Aggiungi file", "Add files") })
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
/** A study folder with subject folders and a holiday folder, linked by setup's material step. */
let auditStudy = "";

/** Two course folders the Library's linked-folder states show as linked, beside the one setup links. */
let auditCourses = "";

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

/** A part's text with two sections, formulas, one check whose right answer is "né aperto né chiuso". */
const auditPartText = [
  "Con l'interno $\\mathring{X}$ e la frontiera $\\partial X$ delle parti prima si dice quando un insieme è aperto o chiuso.",
  "",
  "## Aperti e chiusi",
  "",
  "Un insieme $X \\subseteq \\mathbb{R}^n$ è **aperto** quando ogni suo punto è interno, cioè $\\mathring{X} = X$, ed è **chiuso** quando contiene tutta la sua frontiera, cioè $\\partial X \\subseteq X$ [P1].",
  "",
  "$$X \\text{ chiuso} \\iff \\mathbb{R}^n \\setminus X \\text{ aperto}$$",
  "",
  "## Quando non è nessuno dei due",
  "",
  "Le due parole non sono contrarie: $\\mathbb{R}^n$ e $\\emptyset$ sono aperti e chiusi insieme, e una corona $\\{2 \\le \\|x\\| < 3\\}$ non è né aperta né chiusa.",
  "",
  "```pyxis-check",
  JSON.stringify({
    question: "Com'è $X = \\{x^2 + y^2 < 1\\} \\cup \\{(1, 0)\\}$?",
    options: ["aperto, perché contiene il disco aperto", "chiuso, perché contiene il punto $(1, 0)$", "né aperto né chiuso"],
    answer: 2,
    explanation: "$(1, 0)$ sta sulla frontiera e appartiene a $X$, quindi $X$ non è aperto; il resto della circonferenza no, quindi non è chiuso.",
  }),
  "```",
].join("\n");

const auditRecapText = [
  "## Il capitolo in otto punti",
  "",
  "- La distanza in $\\mathbb{R}^n$ e gli intorni.",
  "- Interno, esterno e frontiera.",
  "- Aperti e chiusi.",
  "",
  "```pyxis-recap",
  JSON.stringify({
    questions: [
      { question: "Un insieme che contiene la sua frontiera è…", options: ["chiuso", "aperto"], answer: 0 },
      { question: "$\\mathbb{R}^n$ è…", options: ["aperto e chiuso", "né aperto né chiuso"], answer: 0 },
      { question: "Una palla aperta è…", options: ["aperta", "chiusa"], answer: 0 },
    ],
  }),
  "```",
].join("\n");

const PART_STATES = new Set([
  "lesson-part",
  "lesson-part-answered",
  "lesson-part-other",
  "lesson-part-writing",
  "lesson-part-failed",
  "lesson-part-failed-dismissed",
  "lesson-part-recap",
  "lesson-part-popover",
  "lesson-one-part",
  "lesson-part-planning",
  "lesson-part-book",
  // Level and rewrites on a part.
  "lesson-part-menu",
  "lesson-part-level",
  "lesson-part-rewrite",
  "lesson-part-section",
  "lesson-part-rewriting",
  "lesson-part-rewrite-failed",
]);

/**
 * Analisi Matematica 2, for the lesson part states: "Funzioni di più variabili" in eight parts and a recap, parts 1 to 3
 * written and 1 and 2 read, "Formula di Taylor" in one part, and "Serie di funzioni" not planned yet. Part 4 has a
 * running job for the writing state and a failed one for the failed state, part 5 a job that found no AI tool for the
 * book state, and "Serie di funzioni" a running job for the planning state; the recap state has parts 1 to 8 read and the
 * recap written. Each state starts from it again, and every other state starts without the exam.
 */
function prepareLessonParts(name: string) {
  const wanted = PART_STATES.has(name);
  if (!wanted && !auditLessonParts) return;
  auditLessonParts = wanted;
  withDb((db) => {
    // A state before this one can have started a part's write (the page does when it opens a part with none), and that job's failure would show here.
    db.exec("DELETE FROM jobs WHERE id = 'audit-part-job' OR (kind = 'lesson-part' AND params_json LIKE '%audit-parts-topic%'); DELETE FROM plans WHERE id = 'audit-parts-plan';");
    if (!wanted) return;
    const now = Date.now();
    seedPlan(db, {
      id: "audit-parts-plan",
      subjectId: "audit-subject",
      title: "Analisi Matematica 2",
      language: "it",
      sourceIds: ["audit-source"],
      topics: [
        { id: "audit-parts-topic", title: "Funzioni di più variabili" },
        { id: "audit-one-topic", title: "Formula di Taylor" },
        { id: "audit-new-topic", title: "Serie di funzioni" },
      ],
    });
    db.exec(`INSERT INTO topic_passages(topic_id,passage_id) VALUES('audit-parts-topic','audit-passage'),('audit-one-topic','audit-passage'),('audit-new-topic','audit-passage');
      INSERT INTO lesson_outlines(id,plan_id,topic_id,passage_key,origin,created_at) VALUES
        ('audit-outline','audit-parts-plan','audit-parts-topic','key','model',1),
        ('audit-one-outline','audit-parts-plan','audit-one-topic','key','single',1);`);
    const titles = [
      "Intorni e distanza in $\\mathbb{R}^n$",
      "Interno, esterno, frontiera",
      "Insiemi aperti e chiusi",
      "Limitati, compatti, connessi",
      "Limiti e continuità",
      "Derivate parziali e gradiente",
      "Differenziabilità e piano tangente",
      "Derivate seconde e matrice hessiana",
      "Ripasso del capitolo",
    ];
    const minutes = [5, 6, 6, 5, 7, 7, 8, 6, 4];
    const recap = name === "lesson-part-recap";
    const part = db.prepare(
      "INSERT INTO lesson_parts(id,outline_id,position,kind,title,about,passage_ids_json,minutes,summary,done_at) VALUES(?,?,?,?,?,'','[\"audit-passage\"]',?,?,?)",
    );
    const item = db.prepare(
      `INSERT INTO items(id,plan_id,topic_id,kind,body_json,engine_provider,model_id,model_source,prompt_template,prompt_version,grounding,created_at)
       VALUES(?,'audit-parts-plan',?,'lesson',?,'fixture','fixture-model','reported','lesson.part','part-1','sources',1)`,
    );
    const write = (partId: string, topicId: string, markdown: string) => {
      const itemId = `${partId}-item`;
      item.run(
        itemId,
        topicId,
        JSON.stringify({
          cacheKey: JSON.stringify({ kind: "lesson", scopeId: partId, promptVersion: "part-1|balanced", passageIds: ["audit-passage"] }),
          markdown,
          passageIds: ["audit-passage"],
        }),
      );
      db.prepare("INSERT INTO item_passages(item_id,passage_id) VALUES(?,'audit-passage')").run(itemId);
      db.prepare("UPDATE lesson_parts SET item_id = ? WHERE id = ?").run(itemId, partId);
    };
    titles.forEach((title, index) => {
      const position = index + 1;
      const kind = position === titles.length ? "recap" : "part";
      const done = position <= 2 || (recap && kind === "part") ? now - 86_400_000 : null;
      part.run(
        `audit-part-${position}`,
        "audit-outline",
        position,
        kind,
        title,
        minutes[index]!,
        // Only a written part has its summary.
        kind === "recap"
          ? recap
            ? "Il capitolo in breve: intorni, frontiera, aperti e chiusi, poi limiti e derivate fino alla matrice hessiana."
            : null
          : position <= 3
            ? "Un insieme è aperto se non contiene punti della sua frontiera e chiuso se la contiene tutta. I due casi non si escludono: $\\mathbb{R}^n$ e $\\emptyset$ sono entrambi."
            : null,
        done,
      );
      if (position <= 3) write(`audit-part-${position}`, "audit-parts-topic", auditPartText);
    });
    if (recap) write("audit-part-9", "audit-parts-topic", auditRecapText);
    part.run("audit-one-part", "audit-one-outline", 1, "part", "Formula di Taylor", 6, "Il polinomio di Taylor approssima una funzione vicino a un punto.", null);
    write("audit-one-part", "audit-one-topic", auditPartText);
    const job = db.prepare(
      "INSERT INTO jobs(id,kind,params_json,state,progress,error,created_at,updated_at) VALUES('audit-part-job','lesson-part',?,?,0,?,?,?)",
    );
    const params = (topicId: string, position: number) =>
      JSON.stringify({ planId: "audit-parts-plan", topicId, position });
    if (name === "lesson-part-writing") job.run(params("audit-parts-topic", 4), "running", null, now, now);
    if (name === "lesson-part-failed") job.run(params("audit-parts-topic", 4), "failed", "lesson-part-invalid", now, now);
    // A failed write whose job the student dismissed in Attività: the part keeps the mark and no job is left.
    if (name === "lesson-part-failed-dismissed")
      db.prepare("UPDATE lesson_parts SET write_failed_at = ? WHERE id = 'audit-part-4'").run(now);
    if (name === "lesson-part-book")
      job.run(params("audit-parts-topic", 5), "failed", "engines.errors.engine-missing", now, now);
    if (name === "lesson-part-planning") job.run(params("audit-new-topic", 1), "running", null, now, now);
    // Part 3 written again at the Semplice level: still running, or failed.
    const rewrite = JSON.stringify({ planId: "audit-parts-plan", topicId: "audit-parts-topic", position: 3, rewrite: "level", wording: "simple" });
    if (name === "lesson-part-rewriting") job.run(rewrite, "running", null, now, now);
    if (name === "lesson-part-rewrite-failed") job.run(rewrite, "failed", "lesson-part-invalid", now, now);
  });
}

// Old lessons in parts. The audit exam's lesson was written before parts, and no lesson step is recorded on its topic,
// so it is unfinished: opening it would rewrite it in parts. The states of the reader that came before parts read it as
// a finished lesson, with its step; the rewrite states keep it unfinished, with part 1's job running or failed.
const FINISHED_OLD_LESSON_STATES = new Set([
  "lesson",
  "lesson-rewrite",
  "lesson-menu",
  "lesson-menu-parts",
  "lesson-rewrite-parts",
  "export-lesson",
  "selection-lesson",
  "ask-from-lesson",
  "reading-large-lesson",
]);
const OLD_LESSON_JOBS: Record<string, { state: string; error: string | null }> = {
  "lesson-rewriting-old": { state: "running", error: null },
  "lesson-rewrite-failed": { state: "failed", error: "engines.errors.engine-missing" },
};

function prepareOldLessons(name: string) {
  withDb((db) => {
    db.exec("DELETE FROM learning_events WHERE id = 'audit-old-lesson-done'; DELETE FROM jobs WHERE id = 'audit-old-job';");
    if (FINISHED_OLD_LESSON_STATES.has(name))
      db.prepare(
        "INSERT INTO learning_events(id,kind,plan_id,topic_id,payload_json,created_at) VALUES('audit-old-lesson-done','lesson_completed','audit-plan','audit-topic',?,?)",
      ).run(JSON.stringify({ activity: "lesson", itemId: "audit-lesson" }), Date.now() - 60_000);
    const job = OLD_LESSON_JOBS[name];
    if (job)
      db.prepare(
        "INSERT INTO jobs(id,kind,params_json,state,progress,error,created_at,updated_at) VALUES('audit-old-job','lesson-part',?,?,0,?,?,?)",
      ).run(
        JSON.stringify({ planId: "audit-plan", topicId: "audit-topic", position: 1, replaces: "audit-lesson" }),
        job.state,
        job.error,
        Date.now(),
        Date.now(),
      );
  });
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
let auditLessonParts = false;
let auditUnfinished = false;

/**
 * Cards of a second subject, of an exam with no subject and with no exam, for the flashcard browser only. Every other
 * state removes them. The flashcard dialog of a subject with no exam gets that subject alone.
 */
function prepareCardBrowser(name: string) {
  withDb((db) => {
    db.exec(`DELETE FROM cards WHERE plan_id IS NULL;
      DELETE FROM card_reviews WHERE id LIKE 'audit-later-%';
      DELETE FROM maps WHERE id = 'audit-chem-map';
      DELETE FROM plans WHERE id IN ('audit-chem-plan','audit-loose-plan');
      DELETE FROM topic_passages WHERE passage_id LIKE 'audit-chem-p%';
      DELETE FROM passages WHERE source_id = 'audit-chem-book';
      DELETE FROM source_documents WHERE source_id = 'audit-chem-book';
      DELETE FROM sources WHERE id = 'audit-chem-book';
      DELETE FROM subjects WHERE id IN ('audit-chem','audit-gal');
      UPDATE topics SET archived_at = NULL WHERE archived_at = 7;`);
    // A subject with no exam, hence no topics, for the new-map dialog.
    if (name === "maps-new-no-topics") seedSubjects(db, [{ id: "audit-chem", name: "Chimica", position: 1 }]);
    if (name === "map-cards-no-exam" || name === "map-switcher") {
      // The whole-subject map of Chimica, which has no exam: the dialog opens from this page and names this subject.
      seedSubjects(db, [{ id: "audit-chem", name: "Chimica", position: 1 }]);
      const node = (id: string, label: string, parent: string | null, x: number) => ({ id, label, parent, x, y: parent ? 160 : 0, pinned: false });
      db.prepare(
        "INSERT INTO maps(id,subject_id,graph_json,grounding,created_at) VALUES('audit-chem-map','audit-chem',?,'general',1)",
      ).run(
        JSON.stringify({
          version: 1,
          maps: [
            {
              id: "audit-chem-map-entry",
              title: "Chimica",
              passageIds: [],
              graph: {
                layout: "tree",
                nodes: [
                  node("chem-root", "Chimica", null, 0),
                  node("chem-orbitals", "Orbitali", "chem-root", -120),
                  node("chem-quantum", "Numeri quantici", "chem-root", 120),
                ],
                edges: [
                  { from: "chem-root", to: "chem-orbitals" },
                  { from: "chem-root", to: "chem-quantum" },
                ],
                undo: null,
              },
            },
            // A second map of the subject, asked for in words, for the switcher.
            ...(name === "map-switcher"
              ? [
                  {
                    id: "audit-chem-bonds-entry",
                    title: "Legami chimici",
                    instruction: "solo i legami, con un esempio per ognuno",
                    passageIds: [],
                    graph: {
                      layout: "tree",
                      nodes: [node("bond-root", "Legami chimici", null, 0), node("bond-ionic", "Legame ionico", "bond-root", 120)],
                      edges: [{ from: "bond-root", to: "bond-ionic" }],
                      undo: null,
                    },
                  },
                ]
              : []),
          ],
        }),
      );
    }
    // The Flashcard section shows the browser's cards, by subject, exam and topic.
    if (!name.startsWith("cards-browser") && !name.startsWith("flashcards")) return;
    // An archived topic hides its cards, so no topic holds a card: the browser has nothing to show.
    if (name === "cards-browser-empty" || name === "flashcards-empty") {
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
        ('audit-card-cloze','audit-chem-plan','audit-atoms','Gli {{c1::elettroni}} occupano i {{c2::livelli}} di energia.','Modello a gusci.','sources',3);
      INSERT INTO cards(id,subject_id,front,back,seed_key,grounding,created_at) VALUES
        ('audit-card-free','audit-chem','Che cos’è un orbitale?','La regione dove è più probabile trovare l’elettrone.','z4','general',4);`);
    db.prepare(
      "INSERT INTO card_reviews(id,card_id,rating,state_json,reviewed_at) VALUES('audit-review-z','audit-card-z','good',?,1)",
    ).run(JSON.stringify({ intervalDays: 9, ease: 2, dueAt: later }));
    if (!name.startsWith("flashcards")) return;
    // A subject with a long name and flashcards with no exam only.
    seedSubjects(db, [{ id: "audit-gal", name: "Geometria e algebra lineare per l’ingegneria dell’informazione", position: 2 }]);
    db.exec(`INSERT INTO cards(id,subject_id,front,back,grounding,created_at) VALUES
      ('audit-card-gal1','audit-gal','Quando una matrice è invertibile?','Quando il determinante non è nullo.','general',5),
      ('audit-card-gal2','audit-gal','Che cos’è un autovalore?','Uno scalare λ per cui Av = λv con v non nullo.','general',6);`);
    // Chimica's book, which Pyxis writes flashcards from on the new-flashcard dialog's other side.
    if (name.startsWith("flashcards-new")) {
      seedSource(db, {
        id: "audit-chem-book",
        subjectId: "audit-chem",
        title: "Atkins",
        document: { id: "audit-chem-doc" },
        passages: [
          { id: "audit-chem-p1", text: "Il numero atomico Z è il numero di protoni nel nucleo.", section: "L’atomo" },
          { id: "audit-chem-p2", text: "Un orbitale è la regione in cui è più probabile trovare l’elettrone.", section: "L’atomo" },
        ],
      });
      db.exec("INSERT INTO topic_passages(topic_id,passage_id) VALUES('audit-atoms','audit-chem-p1'),('audit-atoms','audit-chem-p2')");
    }
    // Every card rated and due in nine days: nothing to review today.
    if (name === "flashcards-none-due")
      db.prepare(
        `INSERT INTO card_reviews(id,card_id,rating,state_json,reviewed_at)
         SELECT 'audit-later-' || id, id, 'good', ?, 2 FROM cards WHERE id NOT IN (SELECT card_id FROM card_reviews)`,
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
/**
 * Stand-in CLIs for the whole audit. Claude Code and Cursor Agent report a sign-in only while the `on` file exists, so
 * every state but setup step 2 sees installed engines that are signed out. Cursor Agent's provider refuses every call,
 * Codex is always signed out and Antigravity is not installed. No model is ever called.
 */
let auditEngines = "";
function fakeEngines(): Record<string, string> {
  auditEngines = mkdtempSync(join(tmpdir(), "pyxis-ui-audit-engines-"));
  // The stand-ins are POSIX shell scripts. On Windows setup step 2 shows the computer with no engine instead.
  if (process.platform === "win32") return {};
  const on = join(auditEngines, "on");
  const fake = (name: string, body: string) => {
    const path = join(auditEngines, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  };
  return {
    CLI_FUNNEL_NO_SHELL_PATH: "1",
    CLI_FUNNEL_CLAUDE_BIN: fake(
      "claude",
      `case "$1" in --version) echo "2.1.0";; auth) if [ -f "${on}" ]; then echo '{"loggedIn":true,"authMethod":"claude.ai"}'; else echo '{"loggedIn":false}'; fi;; *) exit 1;; esac`,
    ),
    CLI_FUNNEL_CODEX_BIN: fake(
      "codex",
      `case "$1" in --version) echo "codex-cli 0.150.0";; login) echo "Not logged in"; exit 1;; *) exit 1;; esac`,
    ),
    CLI_FUNNEL_AGENT_BIN: fake(
      "agent",
      `case "$1" in
  --version) echo "2026.09.28-64d2043";;
  status) if [ -f "${on}" ]; then echo '{"isAuthenticated":true}'; else echo '{"isAuthenticated":false}'; fi;;
  about) echo '{}';;
  --list-models) printf 'gemini-3.8-flash - Gemini 3.8 Flash\\n';;
  *) echo "Error: request failed with status 401 Unauthorized" >&2; exit 1;;
esac`,
    ),
    CLI_FUNNEL_AGY_BIN: join(auditEngines, "not-installed"),
  };
}

/**
 * Setup step 2 signs the stand-ins in; every other state finds them signed out and nothing chosen or confirmed. The
 * pinned default engine of the recorded replies stays: the guided flow and the chats answer through it.
 */
function prepareEngines(name: string) {
  const on = join(auditEngines, "on");
  const engines = name.startsWith("onboarding-engines");
  if (engines) writeFileSync(on, "");
  else rmSync(on, { force: true });
  withDb((db) => {
    // Debug mode only for its own state, so no other page shows its details.
    db.exec("DELETE FROM settings WHERE key = 'debug'");
    if (name === "settings-engines-debug")
      db.prepare("INSERT INTO settings(key,value_json,updated_at) VALUES('debug',?,?)").run(
        JSON.stringify({ on: true }),
        Date.now(),
      );
    db.exec(`DELETE FROM feature_engines WHERE json_extract(selection_json, '$.auto') = 1;
      DELETE FROM settings WHERE key LIKE 'engine-disclosure:%' OR key LIKE 'engine-signed-out:%' OR key = 'engines.allowed';`);
    if (name === "onboarding-engines-chosen")
      db.prepare(
        "INSERT INTO settings(key,value_json,updated_at) VALUES('engines.allowed',?,?)",
      ).run(JSON.stringify(["claude", "codex"]), Date.now());
  });
}

/** One exam archived for the archived list's state only; every other state has it back. */
function prepareExamsArchived(name: string) {
  withDb((db) =>
    db
      .prepare("UPDATE plans SET archived_at = ? WHERE id = 'audit-review-plan'")
      .run(name === "exams-archived" ? 1 : null),
  );
}

/**
 * The exam page's exam in parts, only for its states: four topics, the diagnostic done, and the second topic's lesson
 * in eight parts and a recap, the first two read (yesterday for Riprendi da, with the third) and the first three written.
 * The lesson part states have an exam of their own (`prepareLessonParts`), whose parts were read yesterday.
 */
let auditExamParts = false;
function prepareExamParts(name: string) {
  const mine = name === "plan-now-part" || name === "plan-resume" || name === "plan-now-other";
  if (!mine && !auditExamParts) return;
  auditExamParts = mine;
  withDb((db) => {
    db.exec(`DELETE FROM lesson_parts WHERE outline_id = 'audit-exam-parts-outline';
      DELETE FROM lesson_outlines WHERE id = 'audit-exam-parts-outline';
      DELETE FROM items WHERE id LIKE 'audit-exam-parts-%';
      DELETE FROM learning_events WHERE id LIKE 'audit-exam-parts-%';
      DELETE FROM topics WHERE plan_id = 'audit-exam-parts-plan';
      DELETE FROM plans WHERE id = 'audit-exam-parts-plan';`);
    if (!mine) return;
    seedPlan(db, {
      id: "audit-exam-parts-plan",
      title: "Analisi Matematica 2",
      language: "it",
      target: 0.75,
      examAt: Date.now() + 81 * 86_400_000,
      topics: [
        { id: "audit-exam-parts-t1", title: "Successioni e serie di funzioni" },
        { id: "audit-exam-parts-t2", title: "Funzioni di più variabili" },
        { id: "audit-exam-parts-t3", title: "Formula di Taylor in più variabili" },
        { id: "audit-exam-parts-t4", title: "Massimi e minimi liberi" },
      ],
    });
    db.prepare(
      "INSERT INTO learning_events(id,kind,plan_id,payload_json,created_at) VALUES('audit-exam-parts-diagnostic','lesson_completed','audit-exam-parts-plan',?,?)",
    ).run(JSON.stringify({ activity: "diagnostic" }), Date.now() - 2 * 86_400_000);
    const read = name === "plan-resume" ? new Date().setHours(0, 0, 0, 0) - 6 * 3_600_000 : Date.now() - 60_000;
    const parts: SeedPart[] = [
      ["Intorni e distanza in $\\mathbb{R}^n$", 5],
      ["Interno, esterno, frontiera", 6],
      ["Insiemi aperti e chiusi", 6],
      ["Limitati, compatti, connessi", 5],
      ["Limiti e continuità", 7],
      ["Derivate parziali e gradiente", 7],
      ["Differenziabilità e piano tangente", 8],
      ["Derivate seconde e matrice hessiana", 6],
    ].map(([title, minutes], index) => ({
      title: title as string,
      minutes: minutes as number,
      markdown: index < 3 ? partMarkdown(title as string) : null,
      doneAt: index < (name === "plan-resume" ? 3 : 2) ? read + index : null,
    }));
    parts.push({ kind: "recap", title: "Ripasso del capitolo", minutes: 4 });
    // The app's database is node:sqlite here; the helper uses only prepare and run, which both drivers share.
    seedOutline(db as unknown as Database.Database, {
      id: "audit-exam-parts-outline",
      planId: "audit-exam-parts-plan",
      topicId: "audit-exam-parts-t2",
      parts,
    });
  });
}

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

/** Files added from the Library at each point of choosing their subject, for the states that show it only. */
function prepareLibrarySubjects(name: string) {
  withDb((db) => {
    db.exec(`DELETE FROM jobs WHERE id = 'audit-sort-job';
      DELETE FROM sources WHERE id LIKE 'audit-sort-%';
      DELETE FROM subjects WHERE id = 'audit-sort-made';`);
    if (!["library-sorting", "library-unsorted", "library-move-menu"].includes(name)) return;
    const now = Date.now();
    const source = db.prepare(
      "INSERT INTO sources(id,kind,title,status,subject_id,subject_sort,created_at,updated_at) VALUES(?,'pdf',?,?,?,?,?,?)",
    );
    if (name === "library-unsorted") {
      source.run("audit-sort-board", "Lavagna 6 novembre", "ready", null, "no-ai", now, now);
      source.run("audit-sort-mixed", "Esercizi misti", "ready", null, "unsure", now + 1, now);
      // A file the Library never asked about has no reason to say Pyxis could not place it.
      source.run("audit-sort-never", "Appunti mai chiesti", "ready", null, null, now + 2, now);
      return;
    }
    seedSubjects(db, [{ id: "audit-sort-made", name: "Probabilità e statistica", position: 5 }]);
    source.run("audit-sort-made-file", "Calcolo delle probabilità, dispense", "ready", "audit-sort-made", "created", now, now);
    // A sort job reading in Attività keeps the newest file in its working state.
    source.run("audit-sort-working", "Esercizi sui limiti", "extracting", null, "waiting", now + 1, now);
    db.prepare(
      "INSERT INTO jobs(id,kind,params_json,state,progress,step_label,created_at,updated_at) VALUES('audit-sort-job','library-sort',?,'running',0,'sources.jobs.sortRead',?,?)",
    ).run(JSON.stringify({ sourceIds: ["audit-sort-working"] }), now, now);
  });
}

/**
 * The Library's shelves: the audit's own sources in Fisica, three files of Analisi 1 (a free book, slides and a past
 * exam paper) and an empty Probabilità e statistica, for the Library states except the empty one. Every other state
 * starts without them, and the audit's sources lose the subject again.
 */
function prepareLibraryShelf(name: string) {
  withDb((db) => {
    db.exec(`DELETE FROM plan_sources WHERE source_id LIKE 'audit-shelf-%';
      DELETE FROM sources WHERE id LIKE 'audit-shelf-%';
      DELETE FROM subjects WHERE id LIKE 'audit-shelf-%';
      UPDATE sources SET subject_id = NULL WHERE id IN ('audit-source', 'audit-photo');`);
    if (!name.startsWith("library") || name === "library-empty") return;
    seedSubjects(db, [
      { id: "audit-shelf-analysis", name: "Analisi 1", position: 6 },
      { id: "audit-shelf-empty", name: "Probabilità e statistica", position: 7 },
    ]);
    db.exec(`UPDATE sources SET subject_id = 'audit-subject' WHERE id IN ('audit-source', 'audit-photo');`);
    const file = db.prepare(
      "INSERT INTO sources(id,kind,title,status,library,subject_id,created_at,updated_at) VALUES(?,?,?,'ready',1,'audit-shelf-analysis',1,1)",
    );
    file.run("audit-shelf-book", "smartbook", "Analisi matematica 1");
    file.run("audit-shelf-slides", "pptx", "Slide del corso");
    file.run("audit-shelf-paper", "pdf", "Temi d'esame 2022-2025");
    db.prepare("INSERT INTO plan_sources(plan_id,source_id,role) VALUES('audit-plan','audit-shelf-paper','past_paper')").run();
    if (name !== "library-kinds") return;
    const state = db.prepare(
      "INSERT INTO sources(id,kind,title,status,library,subject_id,created_at,updated_at) VALUES(?,?,?,?,1,'audit-shelf-analysis',1,1)",
    );
    state.run("audit-shelf-notes", "pdf", "Appunti lezioni 1-12", "ready");
    state.run("audit-shelf-exercises", "pdf", "Esercizi serie 3", "ready");
    state.run("audit-shelf-photo", "image", "Lavagna 6 novembre", "ready");
    state.run("audit-shelf-handout", "pdf", "Dispense sui limiti", "ready");
    state.run("audit-shelf-reading", "pdf", "Slide lezione 7", "extracting");
    state.run("audit-shelf-failed", "pdf", "Esercitazione 4, scansione", "failed");
  });
}

/**
 * Three linked folders for the Library's linked-folder states: two course folders on disk, read two minutes ago, with a
 * file each on a shelf, and a third that is no longer there (only in the missing state). Every other state starts
 * without them.
 */
function prepareLinkedFolders(name: string) {
  withDb((db) => {
    db.exec(`DELETE FROM linked_folders WHERE id LIKE 'audit-folder-%';
      DELETE FROM sources WHERE id LIKE 'audit-folder-%';`);
    if (!name.startsWith("library-folders")) return;
    const checked = Date.now() - 2 * 60_000;
    const folder = db.prepare(
      "INSERT INTO linked_folders(id,path,mode,detection,cut_json,confirmed_at,synced_at,created_at) VALUES(?,?,'subject','names','{}',?,?,?)",
    );
    const source = db.prepare(
      "INSERT INTO sources(id,kind,title,status,library,subject_id,created_at,updated_at) VALUES(?,'text',?,'ready',1,'audit-subject',1,1)",
    );
    const file = db.prepare(
      "INSERT INTO linked_files(folder_id,rel_path,subfolder,source_id,size,mtime_ms,missing_at) VALUES(?,?,'',?,10,1,?)",
    );
    const courses: Array<[string, string, string, boolean]> = [
      ["audit-folder-digital", join(auditCourses, "Tecnologie Digitali"), "Slide lezione 9", false],
      ["audit-folder-cinema", join(auditCourses, "Linguaggio cinematografico"), "Schede dei film", false],
    ];
    if (name === "library-folders-missing")
      courses.push(["audit-folder-gone", join(auditCourses, "Fisica (spostata)"), "Esercitazione 4", true]);
    for (const [id, path, title, gone] of courses) {
      folder.run(id, path, checked, checked, checked);
      source.run(`${id}-file`, title);
      file.run(id, `${title}.txt`, `${id}-file`, gone ? checked : null);
    }
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

/** The files the source panel states open: a 12-page PDF, a Word file and a linked file moved away. Others have none. */
function prepareSourcePanel(name: string) {
  const ids = "('audit-sp-pdf', 'audit-sp-docx', 'audit-sp-moved')";
  withDb((db) => {
    db.exec(`DELETE FROM linked_files WHERE folder_id = 'audit-sp-folder';
      DELETE FROM linked_folders WHERE id = 'audit-sp-folder';
      DELETE FROM passages WHERE source_id IN ${ids};
      DELETE FROM source_documents WHERE source_id IN ${ids};
      DELETE FROM sources WHERE id IN ${ids};`);
  });
  if (!name.startsWith("source-panel-")) return;
  const workspace = join(auditUserData, "workspace");
  const pdf = putBlob(workspace, manyPagePdf(12, "Esercizio sul limite della successione"), "application/pdf", "pdf");
  const notes = "Un integrale doppio si calcola per fili, integrando prima in y e poi in x.";
  const word = putBlob(workspace, docx(notes), "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx");
  withDb((db) => {
    const source = db.prepare(
      "INSERT INTO sources(id,kind,title,status,library,blob_sha,mime,created_at,updated_at) VALUES(?,?,?,'ready',1,?,?,1,1)",
    );
    const document = db.prepare("INSERT INTO source_documents(id,source_id,version,tree_json,created_at) VALUES(?,?,1,'{}',1)");
    const passage = db.prepare(
      "INSERT INTO passages(id,source_id,document_id,version,text,locator_json,section_path,created_at) VALUES(?,?,?,1,?,?,?,1)",
    );
    source.run("audit-sp-pdf", "pdf", "Esercitazioni di Analisi I, 2025", pdf, "application/pdf");
    document.run("audit-sp-pdf-doc", "audit-sp-pdf");
    passage.run("audit-sp-pdf-p5", "audit-sp-pdf", "audit-sp-pdf-doc", "Esercizio sul limite della successione 5", '{"page":5}', "Successioni");
    source.run("audit-sp-docx", "docx", "Appunti di Analisi II, lezioni 1-9", word, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    document.run("audit-sp-docx-doc", "audit-sp-docx");
    passage.run("audit-sp-docx-p0", "audit-sp-docx", "audit-sp-docx-doc", "Lezione 1. Integrali curvilinei.", "{}", "Lezione 1");
    passage.run("audit-sp-docx-p9", "audit-sp-docx", "audit-sp-docx-doc", notes, "{}", "Lezione 9");
    source.run("audit-sp-moved", "pdf", "Appunti lezione 5", null, null);
    document.run("audit-sp-moved-doc", "audit-sp-moved");
    passage.run(
      "audit-sp-moved-p3",
      "audit-sp-moved",
      "audit-sp-moved-doc",
      "Nel moto circolare uniforme l'accelerazione punta verso il centro.",
      '{"page":3}',
      "p. 3",
    );
    db.prepare("INSERT INTO linked_folders(id,path,mode,created_at) VALUES('audit-sp-folder',?,'root',1)").run(
      join(auditUserData, "Università"),
    );
    db.prepare(
      "INSERT INTO linked_files(folder_id,rel_path,subfolder,source_id,size,mtime_ms,missing_at) VALUES('audit-sp-folder','Fisica I/Appunti lezione 5.pdf','Fisica I','audit-sp-moved',1,1,1)",
    ).run();
  });
}

/** A quiz half answered (an answer, a "Non lo so", one marked) for the answer sheet, and a simulation under way. */
function prepareAnswerSheet(name: string) {
  withDb((db) => {
    db.exec(`DELETE FROM attempt_answers WHERE attempt_id IN ('audit-sheet-attempt', 'audit-run-attempt');
      DELETE FROM attempts WHERE id IN ('audit-sheet-attempt', 'audit-run-attempt');
      DELETE FROM items WHERE id IN ('audit-sheet-quiz', 'audit-run-exam');`);
    const now = Date.now();
    const item = db.prepare(
      "INSERT INTO items(id,plan_id,topic_id,kind,body_json,engine_provider,grounding,created_at) VALUES(?,'audit-plan','audit-topic',?,?,'fixture','sources',?)",
    );
    const attempt = db.prepare("INSERT INTO attempts(id,plan_id,item_id,started_at) VALUES(?,'audit-plan',?,?)");
    if (name === "quiz-open" || name === "quiz-handin") {
      const questions = [
        {
          id: "sheet-mcq",
          stem: "Quale formula descrive la forza?",
          options: ["$F=ma$", "$F=m/a$", "$F=a/m$", "$F=0$"],
          answer: { kind: "mcq", correct: 0, picked: -1 },
        },
        {
          id: "sheet-open",
          stem: "La velocità di un punto è $v(t) = 3t^2 - 2t$ e all'istante $t = 0$ il punto è in $x = 1\\,m$. Scrivi la legge oraria $x(t)$.",
          answer: { kind: "open", answer: "", reference: "$x(t) = t^3 - t^2 + 1$" },
        },
        {
          id: "sheet-blank",
          stem: "L'accelerazione si misura in {{1}}.",
          answer: { kind: "completion", answers: [], accepted: [["m/s^2"]] },
        },
        {
          id: "sheet-tf",
          stem: "La forza è il prodotto di massa e accelerazione.",
          answer: { kind: "tf", correct: true, picked: false },
        },
      ].map((question) => ({ ...question, topicId: "audit-topic", sourceIds: ["audit-passage"], explanation: "Seconda legge di Newton." }));
      item.run(
        "audit-sheet-quiz",
        "quiz",
        JSON.stringify({ questions, config: { count: 4, feedback: true, types: ["mcq", "open", "completion", "tf"] }, complete: true }),
        now,
      );
      attempt.run("audit-sheet-attempt", "audit-sheet-quiz", now);
      db.prepare(
        "INSERT INTO attempt_answers(id,attempt_id,payload_json,created_at) VALUES('audit-sheet-draft','audit-sheet-attempt',?,?)",
      ).run(
        JSON.stringify({
          draft: {
            picks: { "sheet-mcq": "0", "sheet-tf": "" },
            index: name === "quiz-open" ? 1 : 0,
            marked: ["sheet-blank"],
          },
        }),
        now,
      );
    }
    if (name === "simulation-run") {
      item.run(
        "audit-run-exam",
        "simulation",
        JSON.stringify({
          minutes: 60,
          questions: [
            { id: "run-1", topicId: "audit-topic", stem: "Calcola la forza con $m=2$ e $a=3$.", answer: { kind: "completion", accepted: [["6 N"]] } },
            { id: "run-2", topicId: "audit-topic", stem: "Spiega la seconda legge di Newton.", answer: { kind: "completion", accepted: [["F = ma"]] } },
          ],
          picks: { "run-1": "$F = ma = 6$ N", "run-2": "" },
          marked: ["run-2"],
        }),
        now,
      );
      attempt.run("audit-run-attempt", "audit-run-exam", now);
    }
  });
}

/** Pyxis stays at work on the new-flashcard dialog until this file exists; every other state finds it there. */
const newCardsHold = () => join(auditUserData, "subject-cards-hold");
function prepareNewCards(name: string) {
  if (name === "flashcards-new-working") rmSync(newCardsHold(), { force: true });
  else writeFileSync(newCardsHold(), "");
}

/** The radial maps' subject, Cinema, with its two maps, for the radial states only. */
function prepareRadialMaps(name: string) {
  withDb((db) => {
    db.exec(`DELETE FROM maps WHERE id = 'audit-cinema-map';
      DELETE FROM subjects WHERE id = 'audit-cinema';`);
    if (!name.startsWith("map-radial-")) return;
    seedSubjects(db, [{ id: "audit-cinema", name: "Cinema", position: 1 }]);
    db.prepare(
      "INSERT INTO maps(id,subject_id,graph_json,grounding,created_at) VALUES('audit-cinema-map','audit-cinema',?,'general',1)",
    ).run(
      JSON.stringify({
        version: 1,
        maps: [
          { id: "audit-film-entry", title: radialFixtures.filmHistory.title, passageIds: [], graph: storedGraph(radialFixtures.filmHistory, "radial") },
          { id: "audit-physics-entry", title: radialFixtures.physics.title, passageIds: [], graph: storedGraph(radialFixtures.physics, "radial") },
        ],
      }),
    );
  });
}

/** The audit exam's build as the wait screen follows it: only the build states have one, and the others start without. */
function prepareBuild(name: string) {
  withDb((db) => {
    db.exec("DELETE FROM job_steps WHERE job_id = 'audit-build'; DELETE FROM jobs WHERE id = 'audit-build'");
    const states: Record<string, string> = { "build-running": "running", "build-done": "succeeded", "build-cancelled": "cancelled" };
    const state = states[name];
    if (!state) return;
    const now = Date.now();
    db.prepare(
      "INSERT INTO jobs(id,kind,params_json,state,progress,error,created_at,updated_at) VALUES('audit-build','plan-build',?,?,?,NULL,?,?)",
    ).run(JSON.stringify({ planId: "audit-plan" }), state, state === "succeeded" ? 1 : 0.4, now, now);
    const steps: Array<[string, string]> = [
      ["sources", "wizard.stepSources"],
      ["topics", "wizard.stepTopics"],
      ["path", "wizard.stepPath"],
      ["diagnostic", "wizard.stepDiagnostic"],
      ["ready", "wizard.stepReady"],
    ];
    const insert = db.prepare("INSERT INTO job_steps(id,job_id,name,position,label,state) VALUES(?,?,?,?,?,?)");
    steps.forEach(([step, label], index) =>
      insert.run(`audit-build-${step}`, "audit-build", step, index, label, state === "succeeded" || index < 1 ? "succeeded" : index === 1 && state === "running" ? "running" : "pending"),
    );
  });
}

function prepareState(name: string) {
  prepareLessonParts(name);
  prepareOldLessons(name);
  prepareRadialMaps(name);
  prepareNewCards(name);
  prepareAnswerSheet(name);
  prepareEngines(name);
  prepareExamsEmpty(name);
  prepareExamsArchived(name);
  prepareExamParts(name);
  preparePanelSources(name);
  prepareSourcePanel(name);
  prepareLibraryEmpty(name);
  prepareLibrarySubjects(name);
  prepareLibraryShelf(name);
  prepareLinkedFolders(name);
  prepareMapsEmpty(name);
  prepareCardBrowser(name);
  prepareBackupState(name);
  prepareUpdate(name);
  prepareGradingLive(name);
  prepareBuild(name);
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
  // Unfinished activities on the audit exam beside its open quiz, so "Da finire" lists seven; other states keep one.
  if (name.startsWith("plan-unfinished") || auditUnfinished)
    withDb((db) => {
      db.exec(`DELETE FROM attempts WHERE id LIKE 'audit-unf-%'; DELETE FROM items WHERE id LIKE 'audit-unf-%';
        DELETE FROM jobs WHERE id LIKE 'audit-unf-%'; DELETE FROM topics WHERE id = 'audit-unf-topic'`);
      if (!name.startsWith("plan-unfinished")) return;
      const now = Date.now();
      const questions = (count: number) =>
        Array.from({ length: count }, (_, i) => ({ id: `audit-unf-q${i}`, stem: `Domanda ${i}`, answer: { kind: "tf", value: true } }));
      db.prepare("INSERT INTO topics(id,plan_id,title,position,created_at) VALUES('audit-unf-topic','audit-plan',?,99,1)").run(
        "Successioni e serie numeriche, criteri di convergenza assoluta e condizionata con esempi svolti",
      );
      const add = (id: string, kind: string, topicId: string | null, body: object, at: number) => {
        db.prepare("INSERT INTO items(id,plan_id,topic_id,kind,body_json,created_at) VALUES(?,'audit-plan',?,?,?,1)").run(
          `audit-unf-${id}-item`,
          topicId,
          kind,
          JSON.stringify(body),
        );
        db.prepare("INSERT INTO attempts(id,plan_id,item_id,started_at) VALUES(?,'audit-plan',?,?)").run(
          `audit-unf-${id}`,
          `audit-unf-${id}-item`,
          at,
        );
      };
      add("writing", "quiz", "audit-topic", { complete: false, config: { count: 8 }, questions: questions(2) }, now - 60_000);
      db.prepare(
        "INSERT INTO jobs(id,kind,params_json,state,created_at,updated_at) VALUES('audit-unf-job','quiz-build',?,'running',?,?)",
      ).run(JSON.stringify({ attemptId: "audit-unf-writing", input: { planId: "audit-plan", topicId: "audit-topic" } }), now, now);
      add("long", "quiz", "audit-unf-topic", { complete: true, questions: questions(10) }, now - 86_400_000);
      add("diag", "diagnostic", null, { questions: questions(10) }, now - 3 * 86_400_000);
      add("redo", "quiz", null, { redo: true, complete: true, questions: questions(4) }, now - 9 * 86_400_000);
      add("past", "quiz", null, { pastPaper: 1, complete: true, questions: questions(6) }, now - 12 * 86_400_000);
      db.prepare(
        "INSERT INTO jobs(id,kind,params_json,state,created_at,updated_at) VALUES('audit-unf-build','simulation-build',?,'succeeded',?,?)",
      ).run(
        JSON.stringify({
          planId: "audit-plan",
          minutes: 60,
          batches: [],
          next: 0,
          questions: [{ id: "audit-unf-sq", topicId: "audit-topic", passageIds: ["audit-passage"], stem: "Calcola la forza." }],
        }),
        now - 5 * 86_400_000,
        now - 5 * 86_400_000,
      );
    });
  auditUnfinished = name.startsWith("plan-unfinished");
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
  // An open gap with the model's reading of the mistakes, for the exam page's Ripasso mirato.
  withDb((db) => {
    db.prepare("DELETE FROM gaps WHERE plan_id = 'audit-plan'").run();
    if (name !== "plan-gaps") return;
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
  });
  withDb((db) => {
    db.exec(
      `DELETE FROM attempts WHERE id = 'audit-active-attempt'; DELETE FROM items WHERE id = 'audit-active-exam'`,
    );
    if (!name.endsWith("-exam-active")) return;
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
    // The requests that found nothing go too: one stays in every later state's Attività button until it is dismissed.
    db.exec("DELETE FROM jobs WHERE id LIKE 'audit-running-%' OR id LIKE 'audit-empty-%' OR id LIKE 'audit-ended-%'");
    db.exec(
      "DELETE FROM linked_files WHERE folder_id = 'audit-group-folder'; DELETE FROM linked_folders WHERE id = 'audit-group-folder'",
    );
    const now = Date.now();
    if (name === "jobs-group") {
      // A folder being read: three files running, two read already, five recorded and waiting for the queue.
      db.prepare(
        "INSERT INTO linked_folders(id,path,mode,created_at) VALUES('audit-group-folder',?,'root',?)",
      ).run(join(tmpdir(), "Università"), now);
      const job = db.prepare(
        "INSERT INTO jobs(id,kind,params_json,state,progress,step_label,created_at,updated_at) VALUES(?,'source-import',?,?,?,?,?,?)",
      );
      const read = (title: string) =>
        JSON.stringify({ sourceId: `audit-group-${title}`, title, folderId: "audit-group-folder", linked: true });
      ["Slide lezione 3, cinematica", "Temi d'esame 2024", "Chimica generale, capitolo 4"].forEach((title, index) =>
        job.run(`audit-running-group-${index}`, read(title), "running", 0.3, "sources.jobs.extract", now + index, now),
      );
      for (const index of [0, 1])
        job.run(`audit-running-group-done-${index}`, read(`Letto ${index}`), "succeeded", 1, null, now - 60_000, now);
      const file = db.prepare(
        "INSERT INTO linked_files(folder_id,rel_path,subfolder,size,mtime_ms,pending) VALUES('audit-group-folder',?,'Fisica 1',10,1,1)",
      );
      for (let index = 0; index < 5; index += 1) file.run(`Fisica 1/nota ${index}.txt`);
      return;
    }
    if (name === "map-building" || name === "map-building-asked") {
      db.prepare(
        "INSERT INTO jobs(id,kind,params_json,state,progress,created_at,updated_at) VALUES('audit-running-map','map-build',?,'running',0,?,?)",
      ).run(
        JSON.stringify({
          input: { planId: "audit-ready-plan", topicId: "audit-ready-topic" },
          ...(name === "map-building-asked" ? { instruction: "solo le leggi di Newton, con un esempio per ognuna" } : {}),
        }),
        now,
        now,
      );
      return;
    }
    if (name === "map-nothing-matched") {
      db.prepare(
        "INSERT INTO jobs(id,kind,params_json,state,progress,error,created_at,updated_at) VALUES('audit-empty-map','map-build',?,'failed',1,'map-nothing-matched',?,?)",
      ).run(
        JSON.stringify({
          input: { planId: "audit-ready-plan", topicId: "audit-ready-topic" },
          instruction: "solo i teoremi sulle onde gravitazionali",
        }),
        now,
        now,
      );
      return;
    }
    if (name === "map-build-failed" || name === "map-build-stopped") {
      db.prepare(
        "INSERT INTO jobs(id,kind,params_json,state,progress,error,created_at,updated_at) VALUES('audit-ended-map','map-build',?,?,0,?,?,?)",
      ).run(
        JSON.stringify({
          input: { planId: "audit-plan", topicId: "audit-topic" },
          instruction: "solo le leggi di Newton, con un esempio per ognuna",
        }),
        name === "map-build-failed" ? "failed" : "interrupted",
        name === "map-build-failed" ? "offline" : null,
        now,
        now,
      );
      return;
    }
    if (name !== "jobs-popover") return;
    const running = db.prepare(
      "INSERT INTO jobs(id,kind,params_json,state,progress,step_label,created_at,updated_at) VALUES(?,?,?,'running',?,?,?,?)",
    );
    // Study work names its topic and exam.
    running.run(
      "audit-running-cards",
      "cards-build",
      JSON.stringify({ planId: "audit-plan", topicId: "audit-topic" }),
      0.4,
      "jobs.cards",
      now,
      now,
    );
    // A lesson the lesson page wrote itself, finished today. Finished today means since local midnight, so both
    // finished jobs end now: a run that crosses midnight would otherwise list them as yesterday's and hide them.
    db.prepare(
      "INSERT INTO jobs(id,kind,params_json,state,progress,created_at,updated_at) VALUES('audit-running-lesson','lesson-write',?,'succeeded',1,?,?)",
    ).run(JSON.stringify({ exam: "Analisi 1", topic: "Limiti" }), now - 60_000, now);
    db.prepare("UPDATE jobs SET updated_at = ? WHERE id = 'audit-ready-build'").run(now);
    running.run(
      "audit-running-photo",
      "source-import",
      JSON.stringify({ sourceId: "audit-photo" }),
      0.75,
      "sources.jobs.extract",
      now,
      now,
    );
    // A map request that found nothing waits for the student under C'è bisogno di te, with its own line.
    db.prepare(
      "INSERT OR REPLACE INTO jobs(id,kind,params_json,state,progress,error,created_at,updated_at) VALUES('audit-empty-popover','map-build',?,'failed',1,'map-nothing-matched',?,?)",
    ).run(
      JSON.stringify({
        input: { planId: "audit-ready-plan", topicId: "audit-ready-topic" },
        instruction: "solo i teoremi sulle onde gravitazionali",
      }),
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
  // A map request that found nothing waits under C'è bisogno di te, in every page's Attività button, until it is
  // dismissed, so only the states that seed one have one, and the others do not inherit it.
  const requests = { n: 0 };
  withDb((db) => {
    requests.n = (db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE error = 'map-nothing-matched'").get() as { n: number }).n;
  });
  expect(requests.n, `${name}: requests left over from another state`).toBe(
    ["jobs-popover", "map-nothing-matched"].includes(name) ? 1 : 0,
  );
  const dialog = page.getByRole("dialog");
  const source = /^Appunti di fisica$/;
  switch (name) {
    case "quiz-handin":
      await page.locator(".px-qz-handin > .px-btn").click();
      await expect(page.locator(".px-qz-confirm")).toBeVisible();
      break;
    case "onboarding-material":
    case "onboarding-material-folder":
    case "onboarding-material-subjects": {
      const title = page.getByRole("heading", { level: 1 });
      await page.getByRole("button", { name: both("Continua", "Continue") }).click();
      // The engines are signed out here, so the AI step's footer says it is done later.
      await page.getByRole("button", { name: /^(Lo faccio dopo|Continua|I'll do it later|Continue)$/ }).click();
      await expect(title).toHaveText(/^(Come tieni il materiale per studiare\?|How do you keep your study material\?)$/);
      if (name === "onboarding-material") break;
      await page
        .getByRole("button", { name: both("Una cartella con tutto lo studio", "One folder with all my studies") })
        .click();
      await expect(title).toHaveText(
        /^(Dov'è la cartella con tutto lo studio\?|Where's the folder with all your studies\?)$/,
      );
      if (name === "onboarding-material-folder") break;
      // The picker answers with the study folder for this state only.
      await auditApp!.evaluate((_electron, path) => {
        process.env["PYXIS_E2E_FILE"] = path;
      }, auditStudy);
      try {
        await page.getByRole("button", { name: both("Scegli la cartella", "Choose the folder") }).click();
        await expect(title).toHaveText(both("Ho trovato 3 materie", "I found 3 subjects"), { timeout: 30000 });
      } finally {
        await auditApp!.evaluate((_electron, path) => {
          process.env["PYXIS_E2E_FILE"] = path;
        }, auditPicked);
      }
      break;
    }
    case "onboarding-engines":
    case "onboarding-engines-chosen": {
      await page
        .getByRole("button", { name: both("Continua", "Continue") })
        .click();
      if (process.platform === "win32") break;
      const cards = page
        .getByRole("list", {
          name: both("Le AI che Pyxis può usare", "The AIs Pyxis can use"),
        })
        .getByRole("listitem");
      await expect(cards).toHaveCount(4, { timeout: 30000 });
      const agent = cards.filter({ hasText: "Cursor" });
      // Cursor's provider refuses a call, so its card reads as an expired sign-in.
      await page.evaluate(async () => {
        await window.pyxis.invoke("engines.acknowledge", {
          providers: ["claude", "agent"],
        });
        await window.pyxis
          .invoke("engines.test", { provider: "agent" })
          .catch(() => undefined);
      });
      await expect(agent).toContainText(/Accesso scaduto|Sign-in expired/, {
        timeout: 30000,
      });
      // A saved pick of engines opens Advanced by itself, with the pick ticked.
      if (name === "onboarding-engines-chosen")
        await expect(
          page.getByRole("checkbox", { name: /^(Usa|Use) ChatGPT$/ }),
        ).toBeChecked();
      break;
    }
    // The plain page has the advanced options closed, whatever a state before it left open.
    case "settings-engines": {
      const toggle = page.getByRole("switch", { name: /^(Opzioni avanzate|Advanced options)$/ });
      await expect(toggle).toBeVisible();
      if ((await toggle.getAttribute("aria-checked")) === "true") await toggle.click();
      await expect(page.getByRole("radiogroup", { name: both("Quali strumenti può usare Pyxis", "Which AI tools Pyxis may use") })).toHaveCount(0);
      break;
    }
    case "settings-engines-advanced":
      await openAdvancedEngines(page);
      await expect(page.getByRole("radiogroup", { name: both("Quali strumenti può usare Pyxis", "Which AI tools Pyxis may use") })).toBeVisible();
      break;
    case "settings-engines-debug":
      await openAdvancedEngines(page);
      await expect(page.getByRole("region", { name: both("Questa settimana", "This week") })).toBeVisible();
      break;
    // The download state lives in main and outlasts a reload, so the plain route starts from no download.
    case "settings-updates":
      await page.evaluate(() => window.pyxis.cancelUpdate());
      // The installed version is written once, under "Versione e licenze", as the About text writes it ("0.5.0 dev.10"),
      // and the updates block repeats nothing of it.
      await expect(page.locator(".px-about-version dd").first()).toHaveText(/^\d+\.\d+\.\d+( [a-z]+\.\d+)?$/);
      await expect(page.getByText(/Versione installata|Installed version/)).toHaveCount(0);
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
    case "plan-gaps":
      await expect(
        page.getByRole("button", { name: /^(Ripasso mirato|Targeted review)/ }).first(),
      ).toBeVisible();
      break;
    case "review-quiz-pending":
      await expect(
        page
          .getByRole("button", { name: both("Vedi lo stato", "See status") })
          .or(page.getByText(/in preparazione|being prepared/))
          .first(),
      ).toBeVisible();
      // The Review's questions are its own screen, not the diagnostic test's: the bar names it, over the question's
      // own heading.
      await expect(page.locator(".px-studybar-title b")).toHaveText(both("Ripasso", "Review"));
      break;
    case "rebuild-intro":
    case "rebuild-running":
    case "rebuild-failed":
    case "rebuild-interrupted":
    case "rebuild-review":
      // The exam settings page opens the rebuild dialog.
      await page
        .getByRole("button", { name: both("Ricostruisci", "Rebuild") })
        .click();
      await expect(dialog).toHaveCount(1);
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
      // While it works the dialog shows Pyxis at work in its body, with a line on what it is doing (feedback.md).
      if (name === "rebuild-running") {
        const working = dialog.last().getByRole("status");
        await expect(working).toContainText(
          /Sto rileggendo le fonti per confrontare gli argomenti|I'm reading your sources again to compare the topics/,
        );
        await expect(working.locator(".px-logo-working")).toBeVisible();
      }
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
      // Below 1100px the sidebar is folded and the chats are in the search.
      if (!(await sidebarFolded(page))) {
        await expect(page.getByRole("list", { name: both("Chat", "Chats") })).toBeVisible();
        break;
      }
      await page.getByRole("button", { name: both("Cerca", "Search"), exact: true }).click();
      await expect(
        page.getByRole("option", { name: /Seconda legge di Newton/ }),
      ).toBeVisible();
      break;
    case "ask-search":
    case "ask-search-empty": {
      // The search over the whole app, from the sidebar.
      const empty = name === "ask-search-empty";
      await page.getByRole("button", { name: both("Cerca", "Search"), exact: true }).click();
      await page
        .getByRole("combobox", { name: both("Cerca", "Search") })
        .fill(empty ? "zzzz" : "forza");
      await expect(
        empty
          ? page.getByText(/Niente con queste parole|Nothing matches these words/)
          : page.getByRole("option", { name: /Seconda legge di Newton/ }),
      ).toBeVisible();
      break;
    }
    case "ask-subject-menu":
    case "ask-new-subject-menu": {
      const chip = page.getByRole("button", { name: /^(Materia della chat|Chat subject|Materia: sceglie|Subject: Pyxis)/ });
      await atRest(chip);
      await chip.click();
      await expect(
        page.getByRole("menuitemradio", { name: both("Tutta la Libreria", "Whole Library") }),
      ).toBeVisible();
      break;
    }
    case "ask-guided":
      await expect(page.getByRole("button", { name: both("Dammi la soluzione", "Give me the solution") })).toBeVisible();
      break;
    case "ask-general":
      await expect(page.getByText(/^(Non ho trovato niente su questa domanda|I found nothing on this)/)).toBeVisible();
      break;
    case "ask-delete":
      await answerNextMenu(auditApp!, ["Elimina", "Delete"]);
      // The chat's "…" button in the sidebar, or a right-click on it in the search where the sidebar is folded.
      if (!(await sidebarFolded(page)))
        await page
          .getByRole("button", {
            name: /^(Azioni per|Actions for) Seconda legge di Newton/,
          })
          .click();
      else {
        await page.getByRole("button", { name: both("Cerca", "Search"), exact: true }).click();
        await page
          .getByRole("option", { name: /Seconda legge di Newton/ })
          .click({ button: "right" });
      }
      await expect(dialog.last()).toHaveAccessibleName(
        /^(Eliminare questa chat|Delete this chat)\?$/,
      );
      break;
    case "cards-due-delete":
      await page
        .getByRole("button", { name: both("Azioni sulla flashcard", "Flashcard actions") })
        .click();
      await page
        .getByRole("menuitem", { name: /^(Elimina|Delete)( D)?$/ })
        .click();
      await expect(dialog).toBeVisible();
      break;
    case "ask-formula": {
      await page.getByRole("button", { name: both("Aggiungi un file o una formula", "Add a file or a formula") }).click();
      await page.getByRole("menuitem", { name: both("Scrivi una formula", "Write a formula") }).click();
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
      await openDetails(page, "Appunti di fisica");
      await expect(
        dialog.getByText(/look unrelated to|sembrano? non c'entrare con/),
      ).toBeVisible();
      break;
    case "selection-source":
      await page.evaluate(() => {
        // Marks the text of an opening already shown, so the wait below can tell it from the text of this opening.
        for (const old of document.querySelectorAll(".source-viewer-paragraph p")) old.setAttribute("data-audit-old", "");
        window.dispatchEvent(
          new CustomEvent("pyxis:source-viewer", {
            detail: { passageId: "audit-passage" },
          }),
        );
      });
      // The panel takes each opening with its title focused and the page drawn anew, then scrolls the cited passage into
      // view. Opened again while it is open (the reopen after the keyboard walk), the text shown until then is replaced,
      // and a selection made in it is lost with it; the scroll's event comes a frame later and hides the toolbar of a
      // selection made before it. A slow runner selects in between, so the text must be in place and at rest first.
      // The title keeps the focus from one opening to the next, so the focus alone does not say the new text is there:
      // the text of the opening before must be gone, and the text of this one in place.
      await expect(page.locator(".source-panel .source-viewer-title")).toBeFocused();
      await expect(page.locator(".source-viewer-paragraph p[data-audit-old]")).toHaveCount(0);
      await atRest(page.locator(".source-viewer-paragraph p:not([data-audit-old])").first());
      await selectText(page, ".source-viewer-paragraph p");
      break;
    case "selection-lesson":
      await selectText(page, ".passage .px-markdown p");
      break;
    case "ask-from-lesson":
      await selectText(page, ".passage .px-markdown p");
      await page
        .getByRole("group", { name: both("Chiedi al tutor", "Ask the tutor") })
        .getByRole("button", { name: both("Chiedi al tutor", "Ask the tutor") })
        .click();
      await expect(page.locator(".ask-bar-name")).toBeVisible();
      await expect(page.getByRole("button", { name: /^(Torna a|Back to) / })).toBeVisible();
      break;
    case "mistakes-from-exam":
      await page
        .locator(".px-exam-aside")
        .getByRole("button", { name: both("Quaderno degli errori", "Mistakes notebook") })
        .click();
      await expect(page.getByRole("button", { name: /^(Torna a|Back to) / })).toBeVisible();
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
    case "cards-new": {
      const open = page
        .getByRole("banner")
        .getByRole("button", { name: both("Nuova flashcard", "New flashcard") });
      await open.click();
      await expect(open).toHaveAttribute("aria-expanded", "true");
      await expect(dialog).toHaveAccessibleName(both("Nuova flashcard", "New flashcard"));
      await expect(dialog.getByRole("textbox", { name: both("Fronte", "Front") })).toBeFocused();
      // The study bar has no close button: the way back is named after the exam.
      await expect(page.getByRole("button", { name: /^(Chiudi|Close)$/ })).toHaveCount(0);
      break;
    }
    case "lesson-part":
    case "lesson-part-answered":
    case "lesson-part-other": {
      await expect(page.getByRole("heading", { level: 1, name: "Insiemi aperti e chiusi" })).toBeVisible();
      if (name === "lesson-part") break;
      const check = page.getByRole("region", { name: both("Verifica", "Check") });
      await check.getByRole("button", { name: /né aperto né chiuso/ }).click();
      await expect(check.getByText(both("Giusto\\.", "Right\\."))).toBeVisible();
      const other = page.getByRole("button", { name: both("Scegli altro", "Something else") });
      await other.scrollIntoViewIfNeeded();
      if (name === "lesson-part-other") {
        await atRest(other);
        await other.click();
        await expect(page.getByRole("menuitem", { name: /Rileggi una parte|Reread a part/ })).toBeVisible();
      }
      break;
    }
    case "lesson-part-writing":
      await expect(page.getByRole("status").filter({ hasText: /Sto scrivendo la parte 4|Writing part 4/ })).toBeVisible();
      break;
    case "lesson-part-failed":
    case "lesson-part-failed-dismissed": {
      const failed = page.locator(".px-notice", { hasText: /Non sono riuscito a scrivere la parte 4\.|I couldn't write part 4\./ });
      await expect(failed).toBeVisible();
      // A write that failed is red; one with no error left (its job dismissed) only waits for Riprova, so amber.
      await expect(failed).toHaveClass(name === "lesson-part-failed" ? /\bis-danger\b/ : /\bis-warning\b/);
      break;
    }
    case "lesson-part-recap": {
      const recap = page.getByRole("region", { name: both("Ripasso finale", "Recap") });
      for (const answer of ["chiuso", "aperto e chiuso", "aperta"])
        await recap.getByRole("button", { name: new RegExp(`^[AB] ${answer}`) }).click();
      await expect(page.getByText(both("Fine del capitolo", "End of the chapter"))).toBeVisible();
      await page.getByText(both("Fine del capitolo", "End of the chapter")).scrollIntoViewIfNeeded();
      break;
    }
    case "lesson-part-popover": {
      const title = page.locator(".px-studybar-title-menu");
      if (await title.isVisible()) {
        await title.click();
        await expect(page.getByRole("dialog", { name: both("Parti del capitolo", "Parts of the chapter") })).toBeVisible();
      } else await expect(page.getByRole("navigation", { name: both("Parti del capitolo", "Parts of the chapter") })).toBeVisible();
      break;
    }
    case "lesson-part-planning":
      await expect(page.getByRole("status").filter({ hasText: /Sto dividendo il capitolo in parti|Splitting the chapter into parts/ })).toBeVisible();
      break;
    case "lesson-part-book":
      await expect(page.getByRole("heading", { level: 1, name: "Limiti e continuità" })).toBeVisible();
      await expect(page.getByRole("button", { name: both("Fatto", "Done") })).toBeVisible();
      break;
    // Level and rewrites on a part: the part's menu with its rewrites, the level menu with what it applies to, the two
    // dialogs, and part 3 being written again at another level, then failing.
    case "lesson-part-menu":
    case "lesson-part-rewrite":
    case "lesson-part-section": {
      await expect(page.getByRole("heading", { level: 1, name: "Insiemi aperti e chiusi" })).toBeVisible();
      await page.getByRole("button", { name: both("Altre azioni", "More actions") }).click();
      const rewritePart = page.getByRole("menuitem", { name: both("Riscrivi questa parte", "Rewrite this part") });
      await expect(rewritePart).toBeVisible();
      await expect(page.getByRole("menuitem", { name: both("Riscrivi una sezione", "Rewrite a section") })).toBeVisible();
      if (name === "lesson-part-rewrite") {
        await rewritePart.click();
        await expect(page.getByRole("dialog", { name: both("Riscrivere questa parte\\?", "Rewrite this part\\?") })).toBeVisible();
      }
      if (name === "lesson-part-section") {
        await page.getByRole("menuitem", { name: both("Riscrivi una sezione", "Rewrite a section") }).click();
        const dialog = page.getByRole("dialog", { name: both("Quale sezione riscrivo\\?", "Which section should I rewrite\\?") });
        await expect(dialog.getByRole("radio")).toHaveCount(2);
      }
      break;
    }
    case "lesson-part-level":
      await page.getByRole("button", { name: /^(Livello|Level) / }).click();
      await expect(page.getByRole("menuitem", { name: both("Semplice", "Simple") })).toBeVisible();
      await expect(page.getByText(both("Vale per questa parte e per le prossime", "For this part and the ones after it"))).toBeVisible();
      break;
    case "lesson-part-rewriting":
      await expect(page.getByRole("status").filter({ hasText: /Sto riscrivendo la parte 3|Rewriting part 3/ })).toBeVisible();
      await expect(page.getByRole("region", { name: both("Verifica", "Check") })).toBeVisible();
      break;
    case "lesson-part-rewrite-failed":
      await expect(
        page.locator(".px-notice", { hasText: /Non sono riuscito a riscrivere la parte 3 al livello Semplice|I couldn't rewrite part 3 at the Simple level/ }),
      ).toHaveClass(/\bis-danger\b/);
      break;
    case "lesson-one-part":
      await expect(page.getByRole("heading", { level: 1, name: "Formula di Taylor" })).toBeVisible();
      await expect(page.getByRole("navigation", { name: both("Parti del capitolo", "Parts of the chapter") })).toHaveCount(0);
      break;
    case "lesson-menu":
      await page
        .getByRole("button", { name: both("Altre azioni", "More actions") })
        .click();
      await expect(
        page.getByRole("menuitem", { name: both("Mappa", "Map") }),
      ).toBeVisible();
      break;
    case "lesson-menu-parts":
    case "lesson-rewrite-parts": {
      await page.getByRole("button", { name: both("Altre azioni", "More actions") }).click();
      const parts = page.getByRole("menuitem", { name: both("Riscrivi in parti", "Rewrite in parts") });
      await expect(parts).toBeVisible();
      if (name === "lesson-menu-parts") break;
      await parts.click();
      await expect(
        page.getByRole("dialog", { name: both("Riscrivere la lezione in parti brevi\\?", "Rewrite the lesson in short parts\\?") }),
      ).toBeVisible();
      break;
    }
    case "lesson-rewriting-old":
      await expect(
        page.getByRole("status").filter({ hasText: /Sto riscrivendo la lezione in parti brevi|Rewriting the lesson in short parts/ }),
      ).toBeVisible();
      break;
    case "lesson-earlier":
      await expect(page.getByText(/Questa è la versione di prima della lezione|This is the earlier version of the lesson/)).toBeVisible();
      await expect(page.getByText("La seconda legge di Newton", { exact: false })).toBeVisible();
      break;
    case "lesson-rewrite-failed":
      // The rewrite stopped for want of an AI tool, a step the student takes: amber, not red.
      await expect(
        page.locator(".px-notice", { hasText: /Non sono riuscito a riscrivere la lezione in parti|I couldn't rewrite the lesson in parts/ }),
      ).toHaveClass(/\bis-warning\b/);
      await expect(page.getByText("La seconda legge di Newton", { exact: false })).toBeVisible();
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
        .getByRole("button", { name: /^(Attività|Background tasks)(:|\s|$)/ })
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
          list.getByRole("heading", { name: /^(C'è bisogno di te|Needs you)$/ }),
        ).toBeVisible();
        await expect(
          list.getByText(
            /Pyxis non riesce a leggere questa immagine|Pyxis cannot read this image/,
          ),
        ).toBeVisible();
        await expect(list.getByText(/troppi pixel|too many pixels/)).toBeVisible();
        // A request that found nothing sits in the same group, with its way to the page where it can be changed, and
        // with no retry and no technical details of its own.
        const request = list
          .getByRole("region", { name: /^(C'è bisogno di te|Needs you)$/ })
          .locator(".px-jobs-problem", {
            hasText: /Nel materiale non c’è niente per la tua richiesta|Nothing in the material matches your request/,
          })
          .first();
        await expect(request).toBeVisible();
        await expect(request.getByRole("button", { name: /^(Cambia la richiesta|Change the request)$/ })).toBeVisible();
        await expect(request.getByRole("button", { name: /^(Riprova|Retry)/ })).toHaveCount(0);
        await expect(request.getByText(/Dettagli tecnici|Technical details/)).toHaveCount(0);
        await expect(
          list.getByRole("heading", { name: /^(In corso|Running)$/ }),
        ).toBeVisible();
        await expect(
          list.getByRole("progressbar"),
        ).toHaveCount(2);
        await expect(
          list.getByRole("progressbar", {
            name: /Scrivo le flashcard|Writing flashcards/,
          }),
        ).toBeVisible();
        await expect(
          list.getByRole("button", {
            name: /^(Ferma|Stop): (Scrivo le flashcard su|Writing flashcards on) .+$/,
          }),
        ).toBeVisible();
        // A lesson the lesson page wrote shows as finished work, named after its topic, with its exam.
        await expect(
          list.locator("li", { hasText: /^(Lezione su Limiti scritta|Lesson on Limiti written)/ }),
        ).toContainText("Analisi 1");
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
          list.getByRole("heading", { name: /^(Finite oggi|Finished today)$/ }),
        ).toBeVisible();
        await expect(
          list.getByText(
            /Il tuo abbonamento a Cursor non include questo modello, quindi ha risposto Claude\.|Your Cursor subscription doesn't include this model, so Claude answered\./,
          ),
        ).toBeVisible();
        await expect(
          list.getByRole("button", { name: /^(Chiudi le finite|Clear finished)$/ }),
        ).toBeVisible();
      }
      break;
    case "jobs-group":
      await page
        .getByRole("button", { name: /^(Attività|Background tasks)(:|\s|$)/ })
        .click();
      {
        const running = page.getByRole("region", { name: /^(In corso|Running)$/ });
        const row = running.getByRole("button", {
          name: /^(Leggo le fonti · 2 di 10|Reading sources · 2 of 10)/,
        });
        await expect(row).toContainText(/Dalla cartella Università|From the folder Università/);
        await row.click();
        await expect(row).toHaveAttribute("aria-expanded", "true");
        await expect(
          running.getByText(/^(Altri 5 in attesa · 2 già letti|5 more waiting · 2 already read)$/),
        ).toBeVisible();
        await expect(running.locator(".px-logo-working")).toHaveCount(4);
      }
      break;
    case "map-building":
      await expect(page.locator(".px-map-working")).toHaveText(/^(Creo la mappa «Force»…|Building the map “Force”…)$/);
      await expect(page.locator(".px-map-working .px-logo-working")).toBeVisible();
      break;
    case "map-building-asked":
      await expect(page.locator(".px-map-working")).toHaveText(
        /^(Creo la mappa «Force»…«solo le leggi di Newton, con un esempio per ognuna»|Building the map “Force”…“solo le leggi di Newton, con un esempio per ognuna”)$/,
      );
      await expect(page.locator(".px-map-asked")).toBeVisible();
      break;
    case "map-nothing-matched": {
      await expect(
        page.getByRole("heading", {
          name: /^(Nel materiale non c’è niente per la tua richiesta|Nothing in the material matches your request)$/,
        }),
      ).toBeVisible();
      await expect(page.locator(".px-map-empty")).toContainText("solo i teoremi sulle onde gravitazionali");
      await expect(page.getByLabel(/^(Come la vuoi\?|How do you want it\?)/)).toHaveValue(
        "solo i teoremi sulle onde gravitazionali",
      );
      await expect(page.locator(".px-map-working")).toHaveCount(0);
      break;
    }
    case "ocr-settings-missing":
      await expect(
        page.getByText(
          /I dati per leggere le scansioni non sono ancora|The scan-reading data is not on this computer yet/,
        ),
      ).toBeVisible();
      // Where the data comes from is folded under the row; opened, it names the server.
      await page.getByText(both("Cosa scarica", "What it downloads")).click();
      await expect(page.getByText(/raw\.githubusercontent\.com/)).toBeVisible();
      await expect(
        page.getByRole("button", { name: /^(Scarica|Download) \([\d.,]+ MB\)$/ }),
      ).toBeVisible();
      break;
    case "ocr-settings-integrity":
      await expect(
        page.getByText(/danneggiati o incompleti|damaged or incomplete/),
      ).toBeVisible();
      await expect(
        page.getByRole("button", {
          name: /^(Scarica di nuovo|Download again) \([\d.,]+ MB\)$/,
        }),
      ).toBeVisible();
      break;
    case "ocr-settings-ready":
      await expect(
        page.getByText(/^(Pronta\. I dati|Ready\. The data), [\d.,]+ MB, (sono su questo computer|is on this computer)\.$/),
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
        name: both("Copia automatica ogni giorno", "Back up every day"),
      });
      if (on) await expect(toggle).toBeChecked();
      else await expect(toggle).not.toBeChecked();
      await expect(
        page.getByText(on ? /^(Mentre Pyxis è aperto|While Pyxis is open)\./ : /^(Spenta|Off)\./),
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
        page.getByText("/Volumes/CHIAVETTA/Pyxis", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", {
          name: both("Cambia la cartella delle copie", "Change the backup folder"),
        }),
      ).toBeVisible();
      break;
    case "ocr-download-cancelled":
      await expect(
        page.getByText(/download è stato annullato|download was cancelled/),
      ).toBeVisible();
      break;
    case "ocr-jobs-popover":
      await page
        .getByRole("button", { name: /^(Attività|Background tasks)(:|\s|$)/ })
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
    case "map-exam-active":
    case "library-exam-active":
    case "shell-exam-active":
      if (name === "map-exam-active") await expect(page.locator(".react-flow__node")).toHaveCount(3);
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
      // Attaching lives in the composer's plus menu.
      await page
        .getByRole("button", { name: both("Aggiungi un file o una formula", "Add a file or a formula") })
        .click();
      await page
        .getByRole("menuitem", {
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
          name: /^(Riprendi la correzione|Resume grading)$/,
        }),
      ).toBeVisible();
      // Grading is not a question: the header shows no position, the count says graded rather than correct, and the
      // way to the engines names the page it opens.
      await expect(page.getByText(/^(Domanda|Question) \d+ (di|of) \d+$/)).toHaveCount(0);
      await expect(page.getByText(/\d+ su \d+ risposte? apert[ae] valutat[ae]|\d+ of \d+ open answers? graded/)).toBeVisible();
      await expect(
        page.getByRole("button", { name: /^(Apri gli strumenti AI|Open the AI tools)$/ }),
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
      await expect(changes).toContainText("You leave the weight out");
      await expect(changes).toContainText(/Nuovo passo: ripasso mirato|New step: targeted review/);
      await expect(changes).toContainText(/Force · (una lacuna seria|a serious gap)/);
      await expect(page.locator(".px-res-rises")).toContainText(/Energy (sale|rises)/);
      await expect(page.locator(".px-res-fallback")).toContainText("ChatGPT");
      // One primary button, Ripasso mirato; every exercise in order, the one to review open.
      await expect(page.locator(".px-res .ant-btn-primary")).toHaveCount(1);
      await expect(page.locator(".px-res .ant-btn-primary")).toHaveText(/Ripasso mirato|Targeted review/);
      await expect(page.locator(".px-res-q:not(.is-correct)")).toHaveCount(1);
      await expect(page.locator(".px-res-q:not(.is-correct)")).toContainText(/Sbagliata|Wrong/);
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
      await expect(page.locator(".px-res-working .px-logo-working")).toBeVisible();
      await expect(page.locator(".px-res-changes")).toContainText(/Lo vedi a correzione finita|once grading is done/);
      await expect(page.locator(".px-res-fallback")).toContainText("ChatGPT");
      // While it grades there is no primary action: the bar's control is the way back.
      await expect(page.locator(".px-res .ant-btn-primary")).toHaveCount(0);
      break;
    case "simulation-grading-failed":
      // The results screen while grading is stopped: retry is the one primary action, the study bar's control is the
      // one way back (the foot has none), and the exercise not graded yet says so in words. The bar goes back to the
      // exam by name.
      await expect(
        page.getByRole("banner").getByRole("button", { name: /^(Torna a|Back to) / }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", {
          name: /^(Riprendi la correzione|Resume grading)$/,
        }),
      ).toHaveClass(/ant-btn-primary/);
      await expect(
        page.getByRole("button", {
          name: /^(Torna al percorso|Back to the path)$/,
        }),
      ).toHaveCount(0);
      await expect(
        page.locator(".px-res-q.is-ungraded").getByText(/^(Da correggere|Not graded yet)$/),
      ).toBeVisible();
      break;
    case "reading-large-lesson":
    case "reading-large-exam": {
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
          : [".px-xpath-title", ".px-exam-asec h2"];
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
      // The subject the audit has stays on the page, with no file in it, so the student can still act on it.
      await expect(page.getByRole("region", { name: /^Fisica (nessun file|no files)$/ })).toBeVisible();
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
      await page.getByRole("button", { name: both("Altro sulla Libreria", "More for the Library") }).click();
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
    case "maps-new-topics":
    case "maps-new-no-topics": {
      const withTopics = name === "maps-new-topics";
      await page.getByRole("button", { name: both("Nuova mappa", "New map") }).click();
      await expect(dialog).toBeVisible();
      await dialog.getByLabel(both("Materia", "Subject")).click();
      await page
        .locator(`.ant-select-dropdown:visible .ant-select-item-option[title^="${withTopics ? "Fisica" : "Chimica"}"]`)
        .click();
      const topic = dialog.getByLabel(both("Argomento", "Topic"));
      // The select folds out of the subject select when the subject has topics, and is not there at all otherwise.
      if (withTopics) await expect(topic).toBeVisible();
      else await expect(topic).toBeHidden();
      await dialog
        .getByLabel(/^(Come la vuoi\?|How do you want it\?)/)
        .fill("solo le leggi di Newton, con un esempio per ognuna");
      break;
    }
    case "map-radial-film":
      await expect(page.locator(".react-flow__node")).toHaveCount(radialFixtures.filmHistory.nodes.length);
      await expect(page.getByRole("radio", { name: both("Radiale", "Radial") })).toHaveAttribute("aria-checked", "true");
      break;
    case "map-radial-physics": {
      // The root and its six branches, folded; then the second branch opens, with its five sections.
      await expect(page.locator(".react-flow__node")).toHaveCount(7);
      const fold = page.locator('.react-flow__node[data-id="t1"] .px-concept-fold');
      await fold.click();
      await expect(fold).toHaveAttribute("aria-expanded", "true");
      await expect(page.locator(".react-flow__node")).toHaveCount(12);
      await expect(page.locator(".px-map-canvas[data-moving]")).toHaveCount(0);
      break;
    }
    case "map-subject":
      await expect(page.locator(".react-flow__node")).toHaveCount(3);
      await expect(page.locator(".px-map-sub")).toContainText("Fisica");
      break;
    case "map-source": {
      await expect(page.locator(".react-flow__node")).toHaveCount(3);
      await page.locator('.react-flow__node[data-id="map-force"]').click();
      await page
        .locator(".px-map-foot")
        .getByRole("button", { name: "Appunti di fisica", exact: true })
        .click();
      const panel = page.getByRole("complementary", { name: /Appunti di fisica/ });
      await expect(panel.locator(".source-viewer-paragraph.is-current")).toBeVisible();
      await expect(panel).toBeFocused();
      break;
    }
    case "map-cards":
    case "map-cards-no-exam": {
      await expect(page.locator(".react-flow__node")).toHaveCount(3);
      await page.getByRole("button", { name: both("Crea flashcard da questa mappa", "Make flashcards from this map") }).click();
      const dialog = page.getByRole("dialog", { name: both("Crea flashcard", "Make flashcards") });
      // The dialog names the subject of the map it was opened from.
      await expect(dialog.locator(".px-mc-lead b")).toHaveText(name === "map-cards" ? "Fisica" : "Chimica");
      await expect(dialog.locator("#mc-plan")).toHaveCount(name === "map-cards" ? 1 : 0);
      break;
    }
    case "map-build-failed":
    case "map-build-stopped": {
      await expect(page.locator(".react-flow__node")).toHaveCount(3);
      const line = page.locator(".px-map-notice .px-notice");
      // A failure is red and one that stopped by itself is amber (feedback.md, notices).
      await expect(line).toHaveClass(name === "map-build-failed" ? /\bis-danger\b/ : /\bis-warning\b/);
      await expect(line).toContainText(
        name === "map-build-failed"
          ? /^(L’ultima costruzione della mappa non è riuscita|The last build of this map did not finish)/
          : /^(L’ultima costruzione della mappa si è fermata|The last build of this map stopped)/,
      );
      await expect(
        line.getByRole("button", {
          name: name === "map-build-failed" ? both("Riprova", "Try again") : both("Riprendi", "Resume"),
        }),
      ).toBeVisible();
      await expect(line.getByRole("button", { name: both("Chiudi", "Dismiss") })).toBeVisible();
      break;
    }
    case "map-menu":
    case "map-export":
    case "map-rename":
    case "map-delete":
      // The map's dots hold three actions on the map; its tools sit on the canvas.
      await expect(page.locator(".react-flow__node")).toHaveCount(3);
      await page.locator(".px-map-actions").getByRole("button", { name: both("Altro", "More") }).click();
      await expect(page.getByRole("menuitem", { name: both("Rinomina", "Rename") })).toBeVisible();
      if (name === "map-export") {
        await page.getByRole("menuitem", { name: both("Esporta", "Export") }).click();
        await expect(page.getByRole("menuitem", { name: /^(Schema in testo|Outline as text)/ })).toBeVisible();
      }
      if (name === "map-rename") {
        await page.getByRole("menuitem", { name: both("Rinomina", "Rename") }).click();
        await expect(page.getByRole("textbox", { name: both("Nome della mappa", "Map name") })).toBeFocused();
      }
      if (name === "map-delete") {
        await page.getByRole("menuitem", { name: both("Elimina la mappa…", "Delete map…") }).click();
        await expect(dialog).toBeVisible();
      }
      break;
    case "map-switcher":
      await expect(page.locator(".react-flow__node")).toHaveCount(3);
      await page.locator(".px-map-switch").click();
      await expect(page.getByRole("menuitemradio")).toHaveCount(2);
      break;
    case "maps-tile-menu":
    case "maps-delete": {
      const tile = page.locator(".px-maps-tilew").first();
      await tile.locator(".px-maps-thumb").click({ button: "right" });
      await expect(page.getByRole("menuitem", { name: both("Apri", "Open") })).toBeVisible();
      if (name === "maps-delete") {
        await page.getByRole("menuitem", { name: both("Elimina la mappa…", "Delete map…") }).click();
        await expect(dialog).toBeVisible();
      }
      break;
    }
    case "exams-archived":
      await page.getByRole("button", { name: both("Archiviati", "Archived") }).click();
      await expect(page.getByRole("list", { name: both("Esami archiviati", "Archived exams") })).toBeVisible();
      break;
    case "exams-import-menu":
      await page.getByRole("button", { name: both("Altro su Esami", "More for Exams") }).click();
      await expect(page.getByRole("menuitem").first()).toBeVisible();
      break;
    case "plan-menu":
      await page.locator(".px-exam-head").getByRole("button", { name: both("Altro sull'esame", "More for this exam") }).click();
      await expect(page.getByRole("menuitem").first()).toBeVisible();
      break;
    case "library-menu":
      await page.getByRole("button", { name: both("Altro sulla Libreria", "More for the Library") }).click();
      await expect(page.getByRole("menuitem", { name: both("Libri PoliTost gratuiti", "Free PoliTost books") })).toBeVisible();
      break;
    case "cards-browser-from-exam":
      await page.locator(".px-exam-aside").getByRole("button", { name: both("Sfoglia tutte", "Browse all") }).click();
      await expect(page.getByRole("heading", { level: 1, name: both("Tutte le flashcard", "All flashcards") })).toBeVisible();
      await expect(page.getByRole("button", { name: /^(Torna a|Back to) Chimica generale$/ })).toBeVisible();
      await expect(page.getByRole("navigation", { name: both("Sezioni", "Sections") }).getByRole("link", { name: both("Esami", "Exams"), exact: true })).toHaveAttribute("aria-current", "page");
      break;
    case "cards-browser-menu":
      await page.getByRole("button", { name: both("Altro sulle flashcard", "More for flashcards") }).click();
      await expect(page.getByRole("menuitem").first()).toBeVisible();
      break;
    case "library-sorting":
      await expect(page.getByText(both("Scelgo la materia", "Choosing its subject"))).toBeVisible();
      // The notice that Pyxis made a subject, not the "New subject…" choice of the pickers beside it.
      await expect(page.locator(".px-library-newsubject").getByText(both("Materia nuova\\.", "New subject\\."))).toBeVisible();
      break;
    case "library-unsorted": {
      const group = page.getByRole("region", { name: both("Da sistemare", "To sort") });
      await expect(group).toBeVisible();
      // The group has files Pyxis could not place and one it never asked about, so each line says it is about some.
      await expect(group.getByText(both("Per alcuni file non ho capito a quale materia vanno: scegli tu.", "For some files I couldn't tell which subject they belong to, so you choose."))).toBeVisible();
      await expect(group.getByText(both("Alcuni file non hanno ancora una materia: scegli tu.", "Some files have no subject yet, so you choose."))).toBeVisible();
      break;
    }
    case "library-move-menu":
      await page
        .getByRole("button", { name: /^(Azioni per|Actions for) Calcolo delle probabilità, dispense$/ })
        .click();
      await page.getByRole("menuitem", { name: both("Sposta in", "Move to") }).hover();
      await expect(page.getByRole("menuitem", { name: both("Nuova materia…", "New subject…") })).toBeVisible();
      break;
    case "library-folders-open":
    case "library-folders-missing":
    case "library-folders-unlink": {
      await page.getByRole("button", { name: /^\d+ (cartelle collegate|linked folders)/ }).click();
      const list = page.getByRole("dialog", { name: both("Cartelle collegate", "Linked folders") });
      await expect(list).toBeFocused();
      if (name === "library-folders-missing")
        await expect(list.getByRole("button", { name: both("Trova la cartella…", "Find the folder…") })).toBeVisible();
      if (name !== "library-folders-unlink") break;
      await list
        .getByRole("button", { name: both("Azioni sulla cartella Polito › Tecnologie Digitali", "Actions on the folder Polito › Tecnologie Digitali") })
        .click();
      await page.getByRole("menuitem", { name: both("Scollega…", "Unlink…") }).click();
      await expect(page.getByRole("dialog", { name: /^(Scollegare|Unlink)/ })).toBeVisible();
      break;
    }
    case "library-kind-menu":
      await page.getByRole("button", { name: /^(Azioni per|Actions for) Temi d'esame 2022-2025$/ }).click();
      await page.getByRole("menuitem", { name: both("Tipo", "Kind") }).hover();
      await expect(page.getByRole("menuitemradio", { name: both("Tema d'esame", "Exam paper") })).toHaveAttribute(
        "aria-checked",
        "true",
      );
      break;
    case "plan-unfinished":
      await expect(page.locator(".px-unf-open")).toHaveCount(3);
      await page.locator(".px-unf-more").click();
      await expect(page.locator(".px-unf-open")).toHaveCount(7);
      break;
    case "plan-now-part":
    case "plan-resume":
      await expect(page.getByRole("list", { name: both("Parti della lezione su Funzioni di più variabili", "Parts of the lesson on Funzioni di più variabili") })).toBeVisible();
      break;
    case "plan-now-other":
      await page.locator(".px-exam-now").getByRole("button", { name: both("Scegli altro", "Something else") }).click();
      await expect(page.getByRole("menuitem", { name: /^(Rileggi una parte|Reread a part)/ })).toBeVisible();
      break;
    case "plan-unfinished-menu":
      await page.locator(".px-unf-dots").first().click();
      await expect(page.getByRole("menuitem", { name: both("Elimina…", "Delete…") })).toBeVisible();
      break;
    case "library-row-menu":
      await page
        .getByRole("button", {
          name: /^(Azioni per|Actions for) Appunti di fisica$/,
        })
        .click();
      await expect(page.getByRole("menuitem").first()).toBeVisible();
      break;
    case "library-subject-menu":
      await page.getByRole("button", { name: both("Azioni sulla materia Analisi 1", "Actions for the subject Analisi 1") }).click();
      await expect(page.getByRole("menuitem", { name: both("Nuova mappa di questa materia", "New map of this subject") })).toBeVisible();
      await expect(page.getByRole("menuitem", { name: both("Crea flashcard di questa materia", "Make flashcards for this subject") })).toBeVisible();
      await expect(page.getByRole("menuitem", { name: both("Elimina la materia…", "Delete the subject…") })).toHaveCount(0);
      break;
    case "library-empty-subject":
      await page
        .getByRole("heading", { name: "Probabilità e statistica", exact: true })
        .click({ button: "right" });
      await expect(page.getByRole("menuitem", { name: both("Crea flashcard di questa materia", "Make flashcards for this subject") })).toBeVisible();
      await expect(page.getByRole("menuitem", { name: both("Elimina la materia…", "Delete the subject…") })).toBeVisible();
      break;
    case "library-vision":
      await openDetails(page, "Photo notes");
      // The model that read the photo is named the way a student reads it, never by its id.
      await expect(dialog).toContainText("Vision Fixture Model");
      await expect(dialog).not.toContainText("vision-fixture-model");
      break;
    case "library-details":
      await openDetails(page, "Appunti di fisica");
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
      await openDetails(page, "Esercitazioni Analisi 1 2025");
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
      await openDetails(page, "Serie di Fourier");
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
      await openDetails(page, "Esercitazioni Analisi 1 2025");
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
      await openDetails(page, "Esercitazioni Analisi 1 2025");
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
      // The row opens the file in the source panel; Escape closes it and focus goes back to the row. The details are an
      // item of the row's menu.
      const row = page.getByRole("button", { name: source });
      await row.click();
      await expect(page.locator("aside.source-panel")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.locator("aside.source-panel")).toHaveCount(0);
      await expect(row).toBeFocused();
      await openDetails(page, "Appunti di fisica");
      await expect(
        dialog.getByRole("heading", { name: both("Negli esami", "In exams") }),
      ).toBeVisible();
      await expect(dialog.getByText("Fisica 1", { exact: true })).toBeVisible();
      break;
    }
    case "library-panel-scan":
      await openDetails(page, "Appello 10 febbraio 2025");
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
      await expect(page.locator("aside.source-panel").getByText(/La forza è il prodotto/)).toBeVisible();
      break;
    case "source-panel-pdf":
    case "source-panel-text":
    case "source-panel-missing": {
      const passageId = {
        "source-panel-pdf": "audit-sp-pdf-p5",
        "source-panel-text": "audit-sp-docx-p9",
        "source-panel-missing": "audit-sp-moved-p3",
      }[name];
      await page.evaluate(
        (passageId) => window.dispatchEvent(new CustomEvent("pyxis:source-viewer", { detail: { passageId } })),
        passageId,
      );
      const panel = page.locator("aside.source-panel");
      if (name === "source-panel-pdf") {
        await expect(panel.getByRole("group", { name: both("Pagina 5 di 12", "Page 5 of 12") })).toBeVisible();
        await expect(panel.locator(".source-cite-mark")).toBeVisible();
      } else if (name === "source-panel-text") {
        await expect(panel.locator(".source-viewer-paragraph.is-current")).toContainText("Un integrale doppio");
        await expect(panel.getByRole("button", { name: both("Apri il file", "Open the file") })).toBeVisible();
      } else {
        await expect(
          panel.getByRole("heading", { name: both("Non trovo più questo file", "I can't find this file any more") }),
        ).toBeVisible();
        await expect(panel.getByText(/accelerazione punta verso il centro/)).toBeVisible();
      }
      break;
    }
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
        .getByRole("button", { name: /^Gemini/ })
        .click();
      await expect(dialog).toBeVisible();
      break;
    case "engine-add-cli":
      await openAdvancedEngines(page);
      await page
        .getByRole("button", { name: both("Aggiungi strumento AI", "Add AI tool") })
        .click();
      await expect(dialog.getByRole("tab", { selected: true })).toBeVisible();
      break;
    case "engine-add-key":
      await openAdvancedEngines(page);
      await page
        .getByRole("button", { name: both("Aggiungi strumento AI", "Add AI tool") })
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
    case "flashcards":
      await expect(page.getByRole("heading", { level: 2, name: "Chimica" })).toBeVisible();
      await expect(page.getByRole("heading", { level: 3, name: "Chimica generale" })).toBeVisible();
      await expect(page.getByRole("heading", { level: 2, name: both("Nessuna materia", "No subject") })).toBeVisible();
      // The band under the head holds the day's review, and the head holds the browser and a new flashcard.
      await expect(page.locator(".px-fc-band").getByText(/^(Oggi ne hai \d+ da ripassare|You have \d+ flashcards? to review today)/)).toBeVisible();
      await expect(
        page.locator(".px-fc-band").getByRole("button", { name: /^(Ripassa le \d+ di oggi|Review today's \d+)$/ }),
      ).toBeVisible();
      await expect(page.locator(".px-fc-head").getByRole("button", { name: both("Sfoglia tutte", "Browse all") })).toBeVisible();
      break;
    case "flashcards-empty":
      // One line on what will appear and the one button that writes the first flashcard.
      await expect(page.getByText(/^(Qui compariranno le tue flashcard|Your flashcards will appear here)/)).toBeVisible();
      await expect(page.getByRole("button", { name: both("Nuova flashcard", "New flashcard") })).toBeVisible();
      break;
    case "flashcards-new-hand":
    case "flashcards-new-pyxis":
    case "flashcards-new-working":
    case "flashcards-new-review": {
      await page.getByRole("button", { name: both("Nuova flashcard", "New flashcard") }).click();
      const dialog = page.getByRole("dialog", { name: both("Nuova flashcard", "New flashcard") });
      const subject = dialog.getByRole("combobox", { name: both("Materia", "Subject") });
      await expect(subject).toBeFocused();
      if (name === "flashcards-new-hand") {
        await expect(dialog.getByRole("combobox", { name: both("Esame facoltativo", "Exam optional") })).toBeVisible();
        await dialog
          .getByRole("textbox", { name: both("Fronte", "Front") })
          .fill("Quanto vale $\\lim_{x \\to 0} \\frac{\\sin x}{x}$?");
        await dialog
          .getByRole("textbox", { name: both("Retro", "Back") })
          .fill("Vale 1. Si vede confrontando le aree di due triangoli e di un settore circolare.");
        await expect(dialog.locator(".px-formula-preview .katex").first()).toBeVisible();
        break;
      }
      await dialog.getByRole("radio", { name: both("Falla fare a Pyxis", "Let Pyxis write them") }).click();
      await subject.selectOption({ label: "Chimica" });
      await dialog.getByRole("combobox", { name: both("Argomento", "Topic") }).selectOption({ label: "Struttura dell’atomo" });
      await dialog.getByRole("textbox", { name: /^(Su cosa\?|About what\?)/ }).fill("il numero atomico");
      if (name === "flashcards-new-pyxis") break;
      await dialog.getByRole("button", { name: both("Crea le flashcard", "Make the flashcards") }).click();
      if (name === "flashcards-new-working") {
        await expect(dialog.getByRole("button", { name: both("Sto scrivendo", "Writing") })).toBeDisabled();
        break;
      }
      await expect(
        dialog.getByRole("list", { name: both("Flashcard proposte", "Proposed flashcards") }).getByRole("listitem"),
      ).toHaveCount(3);
      break;
    }
    case "flashcards-none-due":
      await expect(page.getByRole("heading", { level: 2, name: "Chimica" })).toBeVisible();
      // No band, and "Nuova flashcard" is the head's one primary button.
      await expect(page.locator(".px-fc-band")).toBeHidden();
      await expect(page.locator(".px-fc-head").getByRole("button", { name: both("Nuova flashcard", "New flashcard") })).toBeVisible();
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
    case "plan-settings-changes":
      await page
        .getByLabel(both("Nome dell'esame", "Exam name"))
        .fill("Fisica generale");
      await page.getByRole("slider", { name: /^(Obiettivo|Goal)/ }).focus();
      await page.keyboard.press("ArrowRight");
      await expect(
        page.getByRole("region", {
          name: both("Modifiche da salvare", "Changes to save"),
        }),
      ).toContainText(/2 (modifiche da salvare|changes to save)/);
      break;
    case "plan-settings-leave":
      await page.getByLabel(both("Nome dell'esame", "Exam name")).fill("Fisica generale");
      await page
        .getByRole("navigation", { name: both("Sezioni", "Sections") })
        .getByRole("link", { name: both("Esami", "Exams") })
        .click();
      await expect(
        page.getByRole("dialog", { name: both("Uscire senza salvare\\?", "Leave without saving\\?") }),
      ).toBeVisible();
      break;
    case "build-running":
    case "build-done":
    case "build-cancelled": {
      // Cancelling is in the page in full words; the bar holds the way back, the title and line, and Attività.
      await expect(page.getByRole("banner").getByRole("button")).toHaveCount(2);
      const cancel = page.getByRole("button", { name: both("Annulla la preparazione", "Cancel the preparation") });
      if (name === "build-running") await expect(cancel).toBeVisible();
      else await expect(cancel).toHaveCount(0);
      if (name === "build-done") await expect(page.getByRole("button", { name: both("Apri l'esame", "Open the exam") })).toBeVisible();
      if (name === "build-cancelled") await expect(page.getByRole("button", { name: both("Riprova", "Retry") })).toBeVisible();
      break;
    }
    case "wizard-leave":
      // A name typed on the first step is lost by leaving, so the bar's way back asks first.
      await openWizard(page, 1);
      await page.getByRole("button", { name: /^(Torna a|Back to) / }).click();
      await expect(
        page.getByRole("dialog", { name: both("Uscire senza salvare\\?", "Leave without saving\\?") }),
      ).toBeVisible();
      break;
    case "whiteboard-leave": {
      const canvas = page.locator(".px-whiteboard canvas");
      const box = (await canvas.boundingBox())!;
      await page.mouse.move(box.x + 100, box.y + 120);
      await page.mouse.down();
      await page.mouse.move(box.x + 260, box.y + 220, { steps: 8 });
      await page.mouse.up();
      // The page keeps the stroke; the next states open on an empty board.
      await page.evaluate(() => sessionStorage.removeItem("pyxis-board"));
      await page.getByRole("button", { name: /^(Torna a|Back to) / }).click();
      await expect(
        page.getByRole("dialog", { name: both("Uscire senza salvare\\?", "Leave without saving\\?") }),
      ).toBeVisible();
      break;
    }
    case "flashcards-new-leave": {
      await page.getByRole("button", { name: both("Nuova flashcard", "New flashcard") }).click();
      const card = page.getByRole("dialog", { name: both("Nuova flashcard", "New flashcard") });
      await expect(card.getByRole("combobox", { name: both("Materia", "Subject") })).toBeFocused();
      await card.getByRole("textbox", { name: both("Fronte", "Front") }).fill("Che cos'è il numero atomico?");
      await page.keyboard.press("Escape");
      await expect(
        page.getByRole("dialog", { name: both("Uscire senza salvare\\?", "Leave without saving\\?") }),
      ).toBeVisible();
      break;
    }
    case "gallery-dialog-confirm":
    case "gallery-dialog-form":
    case "gallery-dialog-info": {
      const kinds: Record<string, [RegExp, RegExp]> = {
        "gallery-dialog-confirm": [both("Conferma che elimina", "Confirmation that deletes"), both("Eliminare Fisica 1\\?", "Delete Physics 1\\?")],
        "gallery-dialog-form": [both("Modulo", "Form"), both("Nuova mappa", "New map")],
        "gallery-dialog-info": [both("Solo informa", "Only informs"), both("Scorciatoie da tastiera", "Keyboard shortcuts")],
      };
      const [opener, title] = kinds[name]!;
      await page.getByRole("button", { name: opener }).click();
      await expect(page.getByRole("dialog", { name: title })).toBeVisible();
      break;
    }
    case "plan-settings-delete":
      await page
        .getByRole("button", { name: both("Elimina", "Delete") })
        .click();
      await expect(dialog.getByRole("listitem").first()).toBeVisible();
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
  if (name === "ask-new")
    cases.push({ field: ".px-composer-field", frame: ".px-composer" });
  if (/^wizard-\d$/.test(name) && (await page.locator("#plan-date").isVisible()))
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
  // A dialog can hold only links, as the parts popover of a lesson part does.
  const controls = surface.locator(
    `button:visible:not([disabled]),input:visible:not([disabled]),textarea:visible:not([disabled]),select:visible:not([disabled]),[tabindex="0"]:visible${dialogOpen ? ",a[href]:visible" : ""}`,
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
        modal: Boolean(element?.closest("[role='dialog'], dialog[open]")),
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
  if (name === "ask-new" || /^wizard-\d$/.test(name)) await focusRingChecks(page, name);
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
  // The study folder setup links: three subjects and a folder of holiday paperwork the recorded reply skips.
  auditStudy = join(mkdtempSync(join(tmpdir(), "pyxis-ui-audit-study-")), "Università");
  auditCourses = join(mkdtempSync(join(tmpdir(), "pyxis-ui-audit-courses-")), "Polito");
  for (const course of ["Tecnologie Digitali", "Linguaggio cinematografico"])
    mkdirSync(join(auditCourses, course), { recursive: true });
  for (const [folder, file, text] of [
    ["Fisica 1", "Mazzoldi cap 2.txt", "La velocità è la derivata della posizione."],
    ["Analisi 2", "appunti integrali.md", "# Integrali doppi\n\nSi calcolano per fili."],
    ["GAL", "dispense matrici.txt", "Una matrice quadrata è invertibile se il determinante non è nullo."],
    ["Erasmus", "learning agreement.txt", "Learning agreement."],
  ]) {
    mkdirSync(join(auditStudy, folder!), { recursive: true });
    writeFileSync(join(auditStudy, folder!, file!), text!);
  }
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
    ...fakeEngines(),
    PYXIS_E2E_BOOKS: booksSite,
    PYXIS_E2E_FILE: importFolder,
    ...updateEnv(),
    PYXIS_E2E_REPLY: "La forza è $F=ma$ [P1].",
    PYXIS_E2E_PLAN_REPLIES: JSON.stringify({
      // A subject's flashcards from the new-flashcard dialog: held while that state shows Pyxis at work.
      subjectCards: {
        hold: join(userData, "subject-cards-hold"),
        cards: [
          {
            kind: "qa",
            front: "Che cosa indica il numero atomico $Z$?",
            back: "Il numero di protoni nel nucleo dell’atomo.",
            passageId: "{{passage:0}}",
          },
          {
            kind: "concept",
            term: "Orbitale",
            definition: "La regione dello spazio in cui è più probabile trovare l’elettrone.",
            passageId: "{{passage:0}}",
          },
          {
            kind: "cloze",
            text: "Gli isotopi hanno lo stesso {{c1::numero atomico}} ma un diverso numero di neutroni.",
            extra: "Isotopi di un elemento.",
            passageId: "{{passage:0}}",
          },
        ],
      },
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
      folders: {
        folders: [
          { folder: "Fisica 1", subject: "Fisica I", study: true, kinds: ["book"] },
          { folder: "Analisi 2", subject: "Analisi matematica II", study: true, kinds: ["notes"] },
          { folder: "GAL", subject: "Geometria e algebra lineare", study: true, kinds: ["handouts"] },
          { folder: "Erasmus", subject: "Erasmus", study: false, kinds: [] },
        ],
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
              if (/^wizard-\d$/.test(name))
                await openWizard(page, Number(name.split("-")[1]));
              if (name === "library-import") {
                await page
                  .getByRole("button", {
                    name: /Aggiungi file|Add files/,
                    exact: true,
                  })
                  .click();
                // The dialog mounts a frame after the click; the keyboard check needs it there.
                await expect(page.getByRole("dialog")).toBeVisible();
              }
              if (name === "plan-create" || name === "plan-create-simulation") {
                // Creating an activity by hand sits in the exam page's menu.
                await page.locator(".px-exam-head").getByRole("button", { name: /^(Altro sull'esame|More for this exam)$/ }).click();
                await page.getByRole("menuitem", { name: /Crea un'attività|Create an activity/ }).click();
                await expect(page.getByRole("dialog")).toBeVisible();
                if (name === "plan-create-simulation")
                  await page.getByRole("dialog").getByRole("radio", { name: /^(Simulazione|Simulation)$/ }).click();
              }
              if (name === "plan-done") {
                // The topic the path is on is open, its finished steps ticked.
                await expect(page.getByRole("list", { name: /^(Passi di|Steps)/ })).toBeVisible();
              }
              await openState(page, name);
              if (name === "diagnostic") {
                await page
                  .getByRole("button", { name: /Inizia|Start/, exact: true })
                  .click();
                await expect(page.locator(".px-qz-sheet")).toBeVisible();
              }
              if (name === "lesson")
                await expect(
                  page.getByRole("heading", { level: 2, name: "La dinamica" }),
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
                  name === "library-kind-menu" ||
                  name === "plan-unfinished-menu" ||
                  name === "plan-now-other" ||
                  name === "library-subject-menu" ||
                  name === "library-empty-subject" ||
                  name === "exams-import-menu" ||
                  name === "plan-menu" ||
                  name === "library-menu" ||
                  name === "cards-browser-menu" ||
                  name === "map-menu" ||
                  name === "map-export" ||
                  name === "map-switcher" ||
                  name === "maps-tile-menu" ||
                  name === "lesson-part-other") &&
                !(await page.getByRole("menuitem").first().isVisible())
              )
                await openState(page, name);
              // Tabbing away from the name field ends the rename; it opens again for the visual and axe checks.
              if (
                name === "map-rename" &&
                !(await page.getByRole("textbox", { name: both("Nome della mappa", "Map name") }).isVisible())
              )
                await openState(page, name);
              // The parts popover closes when the keyboard check's focus leaves it; it opens again for the visual and axe checks.
              if (name === "lesson-part-popover" && !(await page.locator(".px-parts-popover").isVisible()))
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
              // What is still moving as axe measures, named in a failure: a colour checked halfway through a fade fails
              // on a slow runner only.
              const moving = await page.evaluate(() =>
                document
                  .getAnimations()
                  .filter((animation) => animation.playState === "running")
                  .map((animation) => {
                    const target = (animation.effect as KeyframeEffect | null)?.target;
                    const name =
                      animation instanceof CSSTransition
                        ? animation.transitionProperty
                        : animation instanceof CSSAnimation
                          ? animation.animationName
                          : "script";
                    const own = target ? [...target.classList].filter((name) => name.startsWith("px-")) : [];
                    return `${name} on ${target ? [target.tagName.toLowerCase(), ...own].join(".") : "?"}`;
                  }),
              );
              const violations = await axeViolations(page);
              await saveShot(page, `m14/${key}.png`, { fullPage: true, animations: "disabled" });
              // Fixed headers and modal backdrops are viewport-bound; keep a real viewport capture alongside the full-page image.
              // Without PYXIS_SHOTS (every CI run) nothing keeps it, and the full-page capture has already ended the animations.
              if (SHOTS) await saveShot(page, `m14/${key}.viewport.png`, { fullPage: false, animations: "disabled" });
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
              // Resume takes no room from the page under it: the page is as tall without it and its title stays where
              // it is, Resume ends above the title, and a map's page, which fills the window, is no taller than it.
              if (name.endsWith("-exam-active")) {
                const sizes = await page
                  .getByRole("button", { name: both("Riprendi l’esame", "Resume the exam") })
                  .evaluate((button) => {
                    const root = document.documentElement;
                    const title = () => document.querySelector("main h1")!.getBoundingClientRect().top;
                    const withIt = { height: root.scrollHeight, title: title() };
                    const bottom = button.getBoundingClientRect().bottom;
                    button.style.display = "none";
                    const without = { height: root.scrollHeight, title: title() };
                    button.style.display = "";
                    return { withIt, without, bottom, window: innerHeight };
                  });
                if (sizes.withIt.height !== sizes.without.height)
                  errors.push(`Resume makes the page ${sizes.withIt.height - sizes.without.height}px taller`);
                if (sizes.withIt.title !== sizes.without.title)
                  errors.push(`Resume moves the title by ${sizes.withIt.title - sizes.without.title}px`);
                if (sizes.bottom + 4 > sizes.withIt.title)
                  errors.push(`Resume ends ${Math.round(sizes.withIt.title - sizes.bottom)}px above the title`);
                if (name === "map-exam-active" && sizes.withIt.height > sizes.window)
                  errors.push(`The map's page is ${sizes.withIt.height - sizes.window}px taller than the window`);
              }
              // On the exam page nothing but the grid's own gap lies between Adesso and Percorso, whatever the exam has and
              // however tall the sections beside them are.
              const apart = await page.evaluate(() => {
                const now = document.querySelector(".px-exam-now");
                const heading = document.querySelector(".px-exam-path .px-exam-sech");
                const grid = document.querySelector(".px-exam-grid");
                if (!now || !heading || !grid) return null;
                return {
                  apart: heading.getBoundingClientRect().top - now.getBoundingClientRect().bottom,
                  gap: Number.parseFloat(getComputedStyle(grid).rowGap),
                };
              });
              if (apart && Math.abs(apart.apart - apart.gap) > 1)
                errors.push(`Adesso and Percorso are ${apart.apart}px apart, the grid's gap is ${apart.gap}px`);
              // Every disclosure draws the app's chevron (global.css), never the browser's triangle.
              const triangles = await page.evaluate(() =>
                [...document.querySelectorAll<HTMLElement>("details > summary")]
                  .filter(
                    (summary) =>
                      summary.checkVisibility() &&
                      (getComputedStyle(summary).listStyleType !== "none" ||
                        getComputedStyle(summary, "::before").content === "none"),
                  )
                  .map((summary) => summary.textContent?.trim().slice(0, 40)),
              );
              if (triangles.length) errors.push(`Disclosures without the chevron: ${triangles.join(", ")}`);
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
              // The record file stays on the runner, so a failure says which elements axe flagged and why, and what moved.
              if (violations.length)
                console.log(
                  `M14 ${key} details: ${violations
                    .map(
                      (v) =>
                        `${v.id}: ${v.nodes
                          .map((n) => `${n.target.join(" ")} (${(n.failureSummary ?? "").replace(/\s+/g, " ").trim()})`)
                          .join(" | ")}`,
                    )
                    .join("; ")}; moving: ${moving.join(", ") || "nothing"}`,
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
    removeTestFolder(userData);
    rmSync(importFolder, { recursive: true, force: true });
    rmSync(dirname(auditStudy), { recursive: true, force: true });
    rmSync(dirname(auditCourses), { recursive: true, force: true });
    rmSync(booksSite, { recursive: true, force: true });
    rmSync(updateFolder, { recursive: true, force: true });
    rmSync(auditEngines, { recursive: true, force: true });
  }
  expect(failures, failures.join("\n")).toEqual([]);
});
