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
  attach.run(`${id}-photo`, `${id}-q`, PHOTO_SHA, "image/png", 1, "esercizio-4.png", "photo", 204800, null);
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
