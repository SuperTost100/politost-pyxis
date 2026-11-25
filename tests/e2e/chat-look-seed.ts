import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { darkFigureKey, figureKey } from "../../src/shared/smart-text";
import { dataUrl, photoPng, plotPng } from "./pictures";

/** Chats for the look of Chiedi: figures, the outline, a stopped answer and the files a message carried. */

const PLOT = "plt.plot([0, 6], [2, 11])";
const OLD_PLOT = "plt.plot([0, 6], [11, 2])";
export const FIGURE_CAPTION = "La velocità $v(t)=2+1{,}5\\,t$ cresce di 1,5 m/s ogni secondo. L'area colorata è lo spostamento tra 1 s e 4 s.";
export const OLD_FIGURE_CAPTION = "La velocità scende di 1,5 m/s ogni secondo.";

const block = (code: string, caption: string) => "```pyxis-figure\n" + JSON.stringify({ caption, code }) + "\n```";

/**
 * A short chat with one figure drawn for both themes (`look-figure-one`), so the page does not scroll under an open menu
 * or viewer. With `both`, also a chat (`look-figure`) whose answers hold that figure and one stored before there was a dark one.
 */
export function seedFigureChat(db: DatabaseSync, options: { both?: boolean } = {}) {
  const light = dataUrl(plotPng(false));
  const dark = dataUrl(plotPng(true));
  const key = figureKey(PLOT);
  const oldKey = figureKey(OLD_PLOT);
  const message = db.prepare("INSERT INTO messages(id,chat_id,role,body,figures_json,created_at) VALUES(?,?,?,?,?,?)");
  if (options.both) {
    db.prepare("INSERT INTO chats(id,title,created_at,updated_at) VALUES('look-figure','Area sotto v(t)',1,4)").run();
    message.run("lf-q1", "look-figure", "user", "Perché l'area sotto il grafico della velocità è lo spostamento? Me lo fai vedere?", null, 1);
    message.run(
      "lf-a1",
      "look-figure",
      "assistant",
      `In un intervallo piccolissimo la velocità è quasi costante.\n\n${block(PLOT, FIGURE_CAPTION)}\n\nSommando le strisce ottieni l'area intera.`,
      JSON.stringify({ [key]: light, [darkFigureKey(key)]: dark }),
      2,
    );
  }
  db.prepare("INSERT INTO chats(id,title,created_at,updated_at) VALUES('look-figure-one','Area sotto v(t)',1,2)").run();
  message.run("lo-q1", "look-figure-one", "user", "Perché l'area sotto il grafico della velocità è lo spostamento? Me lo fai vedere?", null, 1);
  message.run(
    "lo-a1",
    "look-figure-one",
    "assistant",
    `In un intervallo piccolissimo la velocità è quasi costante.\n\n${block(PLOT, FIGURE_CAPTION)}`,
    JSON.stringify({ [key]: light, [darkFigureKey(key)]: dark }),
    2,
  );
  if (options.both) {
    message.run("lf-q2", "look-figure", "user", "E se la velocità scende?", null, 3);
    message.run(
      "lf-a2",
      "look-figure",
      "assistant",
      `Il segno cambia.\n\n${block(OLD_PLOT, OLD_FIGURE_CAPTION)}`,
      JSON.stringify({ [oldKey]: light }),
      4,
    );
  }
}

const QUESTIONS = [
  "Quanto vale la forza normale?",
  "Attacco il blocco a una molla: che cosa cambia?",
  "Attrito statico e dinamico: quando uso l'uno e quando l'altro?",
  "Come trovo l'angolo a cui il blocco inizia a scivolare?",
  "E se il piano è liscio?",
  "Che cosa succede se raddoppio la massa?",
  "Mi fai un esempio con i numeri?",
  "Come si scompone il peso sul piano inclinato?",
  "Riassumi tutto in cinque righe.",
];
const ANSWER = (i: number) =>
  `Risposta ${i + 1}. Lungo l'asse perpendicolare al piano il blocco non si muove, quindi le forze si bilanciano: $N = mg\\cos\\theta$. Con un blocco di 2 kg e un piano a 30° ottieni $N = 17{,}0$ N, come nel primo esempio che abbiamo visto insieme.`;

/** A chat of `count` questions, each answered, for the conversation outline. `short` keeps it within one window. */
export function seedOutlineChat(db: DatabaseSync, id = "look-outline", count = QUESTIONS.length, options: { short?: boolean } = {}) {
  db.prepare("INSERT INTO chats(id,title,created_at,updated_at) VALUES(?,?,1,?)").run(id, "Piano inclinato con attrito", count * 2);
  const message = db.prepare("INSERT INTO messages(id,chat_id,role,body,created_at) VALUES(?,?,?,?,?)");
  for (let i = 0; i < count; i++) {
    message.run(`${id}-q${i}`, id, "user", QUESTIONS[i % QUESTIONS.length]!, i * 2 + 1);
    message.run(`${id}-a${i}`, id, "assistant", options.short ? `Risposta ${i + 1}.` : ANSWER(i), i * 2 + 2);
  }
}

/** A chat whose last answer the student stopped in the middle of a sentence. */
export function seedStoppedChat(db: DatabaseSync, id = "look-stopped") {
  db.prepare("INSERT INTO chats(id,title,created_at,updated_at) VALUES(?,?,1,2)").run(id, "Il terzo principio, un esempio");
  db.prepare("INSERT INTO messages(id,chat_id,role,body,created_at) VALUES(?,?,?,?,1)").run(`${id}-q`, id, "user", "Mi spieghi il terzo principio con un esempio?");
  db.prepare("INSERT INTO messages(id,chat_id,role,body,stopped,created_at) VALUES(?,?,?,?,1,2)").run(
    `${id}-a`,
    id,
    "assistant",
    "Il terzo principio dice che le forze nascono sempre in coppia.\n\nPrendi un libro appoggiato sul tavolo. Il libro preme sul tavolo con una forza verso il basso, e il tavolo",
  );
}

const PHOTO_SHA = "c".repeat(64);
/** A file name with the marks Markdown and TeX read, which the viewer must show as written. */
export const PHOTO_NAME = "Appunti [set](2026) {1} $x$.png";

/** A picture in the workspace's blob store under a name of 64 hex digits, as the app's `pyxis-blob:` address reads it. */
export function writeBlob(userData: string, sha: string, bytes: Buffer, mime: string) {
  const folder = join(userData, "workspace", "blobs", sha.slice(0, 2));
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, sha), bytes);
  writeFileSync(join(folder, `${sha}.json`), JSON.stringify({ mime }));
}

/** A question that carried a photo (stored), a document and a photo sent before pictures were kept. */
export function seedSentFilesChat(db: DatabaseSync, userData: string, id = "look-files") {
  writeBlob(userData, PHOTO_SHA, photoPng(), "image/png");
  db.prepare("INSERT INTO chats(id,title,created_at,updated_at) VALUES(?,?,1,2)").run(id, "Esercizio 4, il mio svolgimento");
  db.prepare("INSERT INTO messages(id,chat_id,role,body,created_at) VALUES(?,?,?,?,1)").run(
    `${id}-q`,
    id,
    "user",
    "Mi controlli l'esercizio 4? Nella foto c'è il mio svolgimento, il testo è nel PDF.",
  );
  db.prepare("INSERT INTO messages(id,chat_id,role,body,created_at) VALUES(?,?,?,?,2)").run(
    `${id}-a`,
    id,
    "assistant",
    "Il disegno delle forze è giusto. L'errore è nella terza riga: hai scritto l'attrito come $\\mu mg$.",
  );
  const attach = db.prepare(
    "INSERT INTO attachments(id,message_id,blob_sha,mime,created_at,name,kind,size,source_id) VALUES(?,?,?,?,?,?,?,?,?)",
  );
  attach.run(`${id}-photo`, `${id}-q`, PHOTO_SHA, "image/png", 1, PHOTO_NAME, "photo", 204800, null);
  attach.run(`${id}-old`, `${id}-q`, "d".repeat(64), "image/png", 2, null, "photo", null, null);
  attach.run(`${id}-doc`, `${id}-q`, "e".repeat(64), "application/pdf", 3, "esercizi-scansione.pdf", "document", 1048576, `${id}-source`);
  db.exec(`INSERT INTO sources(id,kind,title,status,library,created_at,updated_at) VALUES('${id}-source','pdf','esercizi-scansione','ready',0,1,1);`);
}

/** A student's attempt and an answer that ends with three suggestions. */
export function seedFollowupsChat(db: DatabaseSync, id = "look-followups") {
  db.prepare("INSERT INTO chats(id,title,created_at,updated_at) VALUES(?,?,1,2)").run(id, "Blocco sul piano, dove sbaglio?");
  db.prepare("INSERT INTO messages(id,chat_id,role,body,created_at) VALUES(?,?,?,?,1)").run(
    `${id}-q`,
    id,
    "user",
    "Un blocco di 2 kg scende su un piano inclinato di 30° con attrito dinamico $\\mu = 0,2$. Ho scritto $a = 9,81 \\cdot (0,5 - 0,2) = 2,94$ m/s². Il libro dice 3,21. Dove sbaglio?",
  );
  db.prepare("INSERT INTO messages(id,chat_id,role,body,created_at) VALUES(?,?,?,?,2)").run(
    `${id}-a`,
    id,
    "assistant",
    "L'impostazione è giusta: hai messo l'asse lungo il piano.\n\nIl primo passaggio che non torna è la forza di attrito: hai scritto $\\mu mg$. L'attrito è $\\mu$ per la forza normale.\n\nUna domanda sola: su un piano inclinato, quanto vale la forza normale?\n\n<followups>\n- Mostrami la soluzione completa\n- Dammi un indizio\n- Perché non è $\\mu mg$?\n</followups>",
  );
}

/** The sources the answers below cite: a book with chapters and pages, lecture notes and an exercise sheet. */
const LOOK_SOURCES = [
  { id: "look-src-book", title: "Analisi matematica 2" },
  { id: "look-src-notes", title: "Appunti · Lezione 14" },
  { id: "look-src-sheet", title: "Esercitazione 7" },
] as const;
const LOOK_PASSAGES = [
  ["look-p-volume", "look-src-book", { chapter: 5 }, "5. Calcolo integrale in più variabili", "Se f è continua e non negativa su un dominio D limitato e misurabile, l'integrale doppio di f su D è il volume del solido compreso tra il grafico di f e il piano xy."],
  ["look-p-when", "look-src-notes", { page: 6 }, null, "Polari: convengono quando D è un disco, una corona o un settore, oppure quando f dipende solo da x² + y²."],
  ["look-p-jacobian", "look-src-book", { page: 181 }, null, "Nel passaggio a coordinate polari l'elemento d'area dx dy si trasforma in ρ dρ dθ: il fattore ρ è il determinante jacobiano della trasformazione."],
  ["look-p-bounds", "look-src-notes", { page: 7 }, null, "Il disco di raggio R diventa il rettangolo [0, R] × [0, 2π] nel piano (ρ, θ). Controllare sempre gli estremi dopo il cambio."],
  ["look-p-split", "look-src-book", { page: 172 }, null, "Se D è un rettangolo e f(x, y) = g(x) h(y), l'integrale doppio è il prodotto dei due integrali in una variabile."],
  ["look-p-exercise", "look-src-sheet", { page: 2 }, null, "Esercizio 3. Calcolare il volume del solido compreso tra il piano z = 0 e il paraboloide z = 9 − x² − y²."],
  // A section with no page and a long name, which the open list wraps.
  ["look-p-cartesian", "look-src-sheet", {}, "Svolgimento completo in coordinate cartesiane, con la sostituzione trigonometrica x = 3 sin t e tutti i passaggi", "Svolgimento in coordinate cartesiane: si arriva all'integrale di (9 − x²)^{3/2}, che richiede la sostituzione x = 3 sin t."],
  // A second passage on page 172, behind another sentence: the page stands for both.
  ["look-p-mean", "look-src-book", { page: 172 }, null, "Per una funzione non negativa, l'altezza media del solido è il volume diviso per l'area della base."],
] as const;

const POLAR = "$$V = \\int_0^{2\\pi} d\\theta \\int_0^2 (4 - \\rho^2)\\,\\rho\\,d\\rho = 2\\pi \\left[2\\rho^2 - \\frac{\\rho^4}{4}\\right]_0^2 = 8\\pi$$";
const MEAN = "$$h = \\frac{V}{\\pi \\cdot 2^2} = \\frac{8\\pi}{4\\pi} = 2$$";
const MEAN_WRONG = "$$h = \\frac{V}{\\pi \\cdot 2} = \\frac{8\\pi}{2\\pi} = 4$$";
/** The answer the sources row is drawn on: seven passages of three sources, two formulas Pyxis checks. */
export const SOURCES_ANSWER = (mean: string) =>
  [
    "Il solido sta sopra il disco $D$ di raggio 2 e sotto il paraboloide, quindi il suo volume è l'integrale doppio dell'altezza sulla base [P1].",
    "$$V = \\iint_D (4 - x^2 - y^2)\\,dx\\,dy$$",
    "Le coordinate polari convengono quando il dominio è un disco o la funzione dipende solo da $x^2 + y^2$ [P2]: qui valgono tutte e due le cose. Nel passaggio cambiano tre cose:",
    "- **L'elemento d'area:** $dx\\,dy$ diventa $\\rho\\,d\\rho\\,d\\theta$. Il fattore $\\rho$ è lo jacobiano, ed è la dimenticanza più frequente [P3].\n- **Gli estremi:** il disco diventa il rettangolo $0 \\le \\rho \\le 2$, $0 \\le \\theta \\le 2\\pi$ [P4].\n- **La funzione:** $4 - x^2 - y^2$ diventa $4 - \\rho^2$.",
    "Ora il dominio è un rettangolo e la funzione non dipende da $\\theta$, quindi l'integrale si separa in due integrali in una variabile [P5]:",
    POLAR,
    "Per controllo, l'altezza media del solido è il volume diviso per l'area della base:",
    mean,
    "Torna, perché il paraboloide scende da 4 al centro a 0 sul bordo [P8]. L'esercizio 3 dell'esercitazione 7 è lo stesso con $z = 9 - x^2 - y^2$ [P6], e lo svolgimento in coordinate cartesiane [P7] mostra quanta fatica risparmi con le polari.",
  ].join("\n\n");
const CHECKS = (mean: string, claimed: string) =>
  `<checks>${JSON.stringify([
    { kind: "equal", expr: "2*pi*(2*2**2 - 2**4/4)", claimed: "8*pi", step: POLAR },
    { kind: "equal", expr: "8*pi/(4*pi)", claimed, step: mean },
  ])}</checks>`;
const JACOBIAN = "$$\\det J = \\cos\\theta \\cdot \\rho\\cos\\theta + \\rho\\sin\\theta \\cdot \\sin\\theta = \\rho$$";
const GAUSS = "$$I^2 = \\int_0^{2\\pi} d\\theta \\int_0^{\\infty} e^{-\\rho^2}\\rho\\,d\\rho = 2\\pi \\cdot \\frac{1}{2} = \\pi$$";

/**
 * Chats for the sources row: `look-sources` (seven passages of three sources and two checked formulas), `look-sources-one`
 * (one passage of one source and one checked formula), `look-sources-none` (general knowledge and one checked formula) and
 * `look-sources-failed` (the first chat with a mean height Pyxis finds wrong).
 */
export function seedSourcesChats(db: DatabaseSync) {
  const source = db.prepare("INSERT INTO sources(id,kind,title,status,library,created_at,updated_at) VALUES(?,'pdf',?,'ready',1,1,1)");
  const document = db.prepare("INSERT INTO source_documents(id,source_id,version,tree_json,created_at) VALUES(?,?,1,'{\"kind\":\"pdf\"}',1)");
  for (const { id, title } of LOOK_SOURCES) {
    source.run(id, title);
    document.run(`${id}-doc`, id);
  }
  const passage = db.prepare("INSERT INTO passages(id,source_id,document_id,text,locator_json,section_path,created_at) VALUES(?,?,?,?,?,?,1)");
  for (const [id, sourceId, locator, section, text] of LOOK_PASSAGES) passage.run(id, sourceId, `${sourceId}-doc`, text, JSON.stringify(locator), section);
  const chat = db.prepare("INSERT INTO chats(id,title,subject,created_at,updated_at) VALUES(?,?,'Analisi matematica II',1,2)");
  const message = db.prepare("INSERT INTO messages(id,chat_id,role,body,grounding,passages_json,created_at) VALUES(?,?,?,?,?,?,?)");
  const cite = db.prepare("INSERT INTO message_passages(message_id,passage_id,label) VALUES(?,?,?)");
  const question = "Come calcolo il volume sotto il paraboloide $z = 4 - x^2 - y^2$? Non capisco quando conviene passare alle polari.";
  for (const [id, mean, claimed] of [
    ["look-sources", MEAN, "2"],
    ["look-sources-failed", MEAN_WRONG, "4"],
  ] as const) {
    chat.run(id, "Volume sotto il paraboloide");
    message.run(`${id}-q`, id, "user", question, null, null, 1);
    message.run(`${id}-a`, id, "assistant", `${SOURCES_ANSWER(mean)}\n${CHECKS(mean, claimed)}`, "sources", null, 2);
    LOOK_PASSAGES.forEach(([passageId], index) => cite.run(`${id}-a`, passageId, `P${index + 1}`));
  }
  chat.run("look-sources-one", "Lo jacobiano delle polari");
  message.run("look-sources-one-q", "look-sources-one", "user", "E lo jacobiano $\\rho$ da dove esce?", null, null, 1);
  message.run(
    "look-sources-one-a",
    "look-sources-one",
    "assistant",
    `È il determinante della matrice delle derivate di $x = \\rho\\cos\\theta$ e $y = \\rho\\sin\\theta$ rispetto a $\\rho$ e $\\theta$ [P1]:\n\n${JACOBIAN}\n\nSi vede anche a occhio: un rettangolino di lati $d\\rho$ e $d\\theta$ diventa un pezzetto di corona di lati $d\\rho$ e $\\rho\\,d\\theta$, che è tanto più grande quanto più sei lontano dall'origine.\n<checks>${JSON.stringify([{ kind: "equal", expr: "cos(t)*r*cos(t) + r*sin(t)*sin(t)", claimed: "r", vars: ["r", "t"], step: JACOBIAN }])}</checks>`,
    "sources",
    null,
    2,
  );
  cite.run("look-sources-one-a", "look-p-jacobian", "P1");
  chat.run("look-sources-none", "Integrale di Gauss");
  message.run("look-sources-none-q", "look-sources-none", "user", "Quanto vale l'integrale di $e^{-x^2}$ su tutta la retta?", null, null, 1);
  message.run(
    "look-sources-none-a",
    "look-sources-none",
    "assistant",
    `Vale $\\sqrt{\\pi}$, e si calcola con le coordinate polari. Se chiami $I$ l'integrale, il suo quadrato è un integrale doppio su tutto il piano:\n\n${GAUSS}\n\nQuindi $I = \\sqrt{\\pi}$, circa 1,772.\n<checks>${JSON.stringify([
      { kind: "equal", expr: "2*pi/2", claimed: "pi", step: GAUSS },
      // A second check of the same step: one mark beside it, which says two results passed.
      { kind: "equal", expr: "2*pi*(1/2)", claimed: "pi", step: GAUSS },
    ])}</checks>`,
    "general",
    JSON.stringify({ found: false, where: "library" }),
    2,
  );
}

/** The passages of `seedSourcesChats`, in the order a lesson part given them numbers them. */
export const SOURCES_PASSAGE_IDS = LOOK_PASSAGES.map(([id]) => id);
/** The same text as a lesson part, its two formulas checked by ```check blocks. */
const fence = (claim: object) => `\n\n\`\`\`check\n${JSON.stringify(claim)}\n\`\`\``;
// Replaced by a function, since "$$" in a replacement string stands for one "$".
export const SOURCES_LESSON = SOURCES_ANSWER(MEAN)
  .replace(POLAR, () => POLAR + fence({ kind: "equal", expr: "2*pi*(2*2**2 - 2**4/4)", claimed: "8*pi" }))
  .replace(MEAN, () => MEAN + fence({ kind: "equal", expr: "8*pi/(4*pi)", claimed: "2" }));

/** The cards a chat's flashcard tool made in the fixture chats and specs: eight on the three principles of dynamics. */
export const TOOL_CARDS = [
  { front: "Che cosa afferma il primo principio della dinamica?", back: "Un corpo con forza risultante nulla resta in quiete o in moto rettilineo uniforme." },
  { front: "Che cos'è un sistema di riferimento inerziale?", back: "Un sistema in cui vale il primo principio." },
  { front: "Scrivi il secondo principio della dinamica.", back: "$\\vec F = m\\vec a$" },
  { front: "In che unità si misura la forza nel SI?", back: "In newton: $1\\,\\mathrm{N} = 1\\,\\mathrm{kg\\,m/s^2}$." },
  { front: "Che cosa afferma il terzo principio della dinamica?", back: "$\\vec F_{AB} = -\\vec F_{BA}$: forze uguali e opposte su corpi diversi." },
  { front: "Perché azione e reazione non si annullano?", back: "Agiscono su due corpi diversi." },
  { front: "Che differenza c'è tra massa e peso?", back: "La massa misura l'inerzia; il peso è la forza $\\vec P = m\\vec g$." },
  { front: "Quanto vale $g$ sulla Terra?", back: "Circa $9{,}81\\,\\mathrm{m/s^2}$." },
];

/**
 * A chat whose answer created flashcards with the chat's tool, in one of the three states the reply shows: the tool at
 * work (`working`, a block still pending), the card of what it made (`done`) and the line after «Annulla» (`undone`).
 */
export function seedToolChat(db: DatabaseSync, state: "working" | "done" | "undone", id = `look-tool-${state}`) {
  if (!db.prepare("SELECT 1 FROM subjects WHERE id = 'look-phys'").get())
    db.prepare("INSERT INTO subjects(id,name,created_at) VALUES('look-phys','Fisica 1',1)").run();
  db.prepare("INSERT INTO chats(id,title,subject,created_at,updated_at) VALUES(?,?,?,1,2)").run(id, "I tre principi della dinamica", "Fisica 1");
  db.prepare("INSERT INTO messages(id,chat_id,role,body,created_at) VALUES(?,?,?,?,1)").run(
    `${id}-q`,
    id,
    "user",
    "Fammi 8 flashcard sui tre principi della dinamica.",
  );
  const resultId = `0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a${state === "working" ? "50" : state === "done" ? "51" : "52"}`;
  const ids = TOOL_CARDS.map((_, index) => `${id}-card-${index}`);
  const insertCard = db.prepare(
    "INSERT INTO cards(id,subject_id,front,back,seed_key,removed,prompt_template,created_at) VALUES(?,?,?,?,?,?,'chat.tutor',?)",
  );
  if (state !== "working") {
    TOOL_CARDS.forEach((card, index) =>
      insertCard.run(ids[index]!, "look-phys", card.front, card.back, `text:${id}-${index}`, state === "undone" ? 1 : 0, 2),
    );
    db.prepare("INSERT INTO chat_tool_results(id,chat_id,message_id,tool,data_json,undone_json,created_at) VALUES(?,?,?,?,?,?,2)").run(
      resultId,
      id,
      `${id}-a`,
      "create_flashcards",
      JSON.stringify({
        cardIds: ids,
        duplicates: 0,
        title: "sui tre principi della dinamica",
        deck: "Fisica 1",
        fronts: TOOL_CARDS.slice(0, 3).map((card) => card.front),
      }),
      state === "undone" ? JSON.stringify(ids) : null,
    );
  }
  const block = "```pyxis-tool\n" + (state === "working" ? "pending:create_flashcards" : resultId) + "\n```";
  db.prepare("INSERT INTO messages(id,chat_id,role,body,engine_provider,model_id,model_source,created_at) VALUES(?,?,?,?,?,?,?,2)").run(
    `${id}-a`,
    id,
    "assistant",
    `Ecco le flashcard che mi hai chiesto.\n\n${block}${state === "working" ? "" : "\n\nLe trovi nel mazzo di Fisica 1: ripassale domani."}`,
    "claude",
    "claude-sonnet-5-5",
    "reported",
  );
}
