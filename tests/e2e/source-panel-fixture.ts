import { strToU8, zipSync } from "fflate";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { PNG } from "pngjs";
import { putBlob } from "../../src/core/blobs";
import { onePagePdf } from "../../src/core/sources/test-pdf";
import { imageOnlyPdf } from "./scanned-pdf-fixture";
import { seedSource, seedSubjects } from "./seed";

/** The pages of the textbook, and the page a chat answer cites. */
export const BOOK_PAGES = 900;
export const CITED_PAGE = 412;
/** The cited passage, as the book prints it on that page over three lines. */
export const CITED_LINES = [
  "Il percorso inverso richiede un integrazione.",
  "Scrivendo dx = v dt e integrando tra t0 e t",
  "si ottiene la legge oraria del moto rettilineo.",
];
export const LONG_TITLE =
  "Appunti_di_fisica_generale_per_il_corso_di_laurea_in_ingegneria_edile_e_dei_sistemi_territoriali_2026";

/** A PDF built from its objects, with the cross-reference table computed. */
function pdf(objects: string[]): Buffer {
  const parts: Buffer[] = [Buffer.from("%PDF-1.4\n")];
  let at = parts[0]!.length;
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(at);
    const chunk = Buffer.from(`${index + 1} 0 obj\n${body}\nendobj\n`, "latin1");
    parts.push(chunk);
    at += chunk.length;
  });
  const xref = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`, ...offsets.map((n) => `${String(n).padStart(10, "0")} 00000 n \n`)].join("");
  parts.push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${at}\n%%EOF\n`, "latin1"));
  return Buffer.concat(parts);
}

/**
 * A textbook of `pages` A4 pages, each about 40 KB like a scanned-and-typeset book page, so the whole file is about
 * 36 MB and reading all of it would show. Every page has a running head and a line; page CITED_PAGE also has the
 * passage a chat answer cites.
 */
export function textbook(pages = BOOK_PAGES): Buffer {
  const font = pages + 3;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Count ${pages} /Kids [${Array.from({ length: pages }, (_, i) => `${i + 3} 0 R`).join(" ")}] >>`,
  ];
  for (let n = 1; n <= pages; n += 1)
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents ${font + n} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`,
    );
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman >>");
  const filler = `% ${"x".repeat(98)}\n`.repeat(400);
  for (let n = 1; n <= pages; n += 1) {
    const lines = [
      `BT /F1 10 Tf 72 790 Td (Capitolo 2 - Cinematica del punto) Tj ET`,
      `BT /F1 10 Tf 500 790 Td (${n}) Tj ET`,
      `BT /F1 15 Tf 72 740 Td (2.${(n % 9) + 1} Pagina ${n} del libro) Tj ET`,
      `BT /F1 12 Tf 72 700 Td (Questa e la pagina ${n} del testo di fisica.) Tj ET`,
      ...(n === CITED_PAGE ? CITED_LINES.map((line, i) => `BT /F1 12 Tf 72 ${660 - i * 18} Td (${line}) Tj ET`) : []),
    ].join("\n");
    const stream = `${filler}${lines}`;
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }
  return pdf(objects);
}

/** A Word file with one paragraph: the parts mammoth needs and nothing else. */
export function docx(text: string): Uint8Array {
  return zipSync({
    "[Content_Types].xml": strToU8(
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ),
    "_rels/.rels": strToU8(
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    ),
    "word/document.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
    ),
  });
}

/** A photo of a blackboard: green, with a few chalk strokes. */
function board(): Buffer {
  const png = new PNG({ width: 480, height: 320 });
  for (let y = 0; y < png.height; y += 1)
    for (let x = 0; x < png.width; x += 1) {
      const i = (y * png.width + x) * 4;
      const chalk = (y > 90 && y < 96 && x > 60 && x < 360) || (y > 150 && y < 155 && x > 60 && x < 280) || (x > 380 && x < 386 && y > 60 && y < 240);
      png.data[i] = chalk ? 235 : 46;
      png.data[i + 1] = chalk ? 235 : 75;
      png.data[i + 2] = chalk ? 225 : 62;
      png.data[i + 3] = 255;
    }
  return PNG.sync.write(png);
}

/** A scanned page: white, with dark bars where the lines of an exercise are. */
function scanPage(): Buffer {
  const png = new PNG({ width: 306, height: 396 });
  png.data.fill(255);
  for (let y = 0; y < png.height; y += 1)
    for (let x = 0; x < png.width; x += 1)
      if ((y % 28 < 6 && y > 40 && y < 300 && x > 30 && x < 270 - (y % 3) * 30) || (y > 20 && y < 30 && x > 30 && x < 160)) {
        const i = (y * png.width + x) * 4;
        png.data[i] = png.data[i + 1] = png.data[i + 2] = 40;
      }
  return PNG.sync.write(png);
}

/**
 * The Library the source panel is checked on, in Fisica I: the textbook (stored), a scanned exam paper, a photo of the
 * board, Word notes, a page saved from a link, notes in a linked folder that were moved away, and a file with a very
 * long name. A chat cites the textbook at page 412 and the Word notes. `userData` is the profile the app runs on.
 */
export function seedSourcePanel(db: DatabaseSync, userData: string): { bookBytes: number } {
  const workspace = join(userData, "workspace");
  seedSubjects(db, [{ id: "sub-fis", name: "Fisica I" }]);
  const stored = (id: string, bytes: Uint8Array, mime: string, ext: string) => {
    const sha = putBlob(workspace, bytes, mime, ext);
    db.prepare("UPDATE sources SET blob_sha = ?, mime = ? WHERE id = ?").run(sha, mime, id);
  };
  const book = textbook();
  seedSource(db, {
    id: "sp-book",
    title: "Fisica I · Mazzoldi, Nigro, Voci",
    kind: "pdf",
    subjectId: "sub-fis",
    document: { id: "sp-book-doc", tree: { kind: "pdf" } },
    passages: [
      { id: "sp-book-p1", text: "Questa e la pagina 1 del testo di fisica.", locator: { page: 1 }, section: "2.2 Moto rettilineo" },
      { id: "sp-book-cited", text: CITED_LINES.join(" "), locator: { page: CITED_PAGE }, section: "2.2 Moto rettilineo" },
      { id: "sp-book-last", text: `Questa e la pagina ${BOOK_PAGES} del testo di fisica.`, locator: { page: BOOK_PAGES }, section: "Indice" },
      // Cited when the file had more pages: a linked file shortened since keeps the citation's words.
      { id: "sp-book-gone", text: "Appendice B. Tavole delle costanti fisiche.", locator: { page: BOOK_PAGES + 40 }, section: "Appendice B" },
    ],
  });
  stored("sp-book", book, "application/pdf", "pdf");
  seedSource(db, {
    id: "sp-scan",
    title: "Tema d'esame, febbraio 2025",
    kind: "pdf",
    subjectId: "sub-fis",
    document: { id: "sp-scan-doc", tree: { kind: "pdf" } },
    passages: [{ id: "sp-scan-p1", text: "Esercizio 1. Calcola la velocità media del punto tra t1 e t2.", locator: { page: 1 }, section: "p. 1" }],
  });
  stored("sp-scan", imageOnlyPdf([scanPage()]), "application/pdf", "pdf");
  seedSource(db, {
    id: "sp-photo",
    title: "Lavagna, lezione 10",
    kind: "image",
    subjectId: "sub-fis",
    document: { id: "sp-photo-doc", tree: { kind: "image" } },
    passages: [{ id: "sp-photo-p1", text: "Sulla lavagna: la velocità è la derivata della posizione, v = dx/dt.", section: "Lavagna" }],
  });
  stored("sp-photo", board(), "image/png", "png");
  const notes = "Un integrale doppio si calcola per fili, integrando prima in y e poi in x.";
  seedSource(db, {
    id: "sp-docx",
    title: "Appunti, lezioni 1-9",
    kind: "docx",
    subjectId: "sub-fis",
    document: { id: "sp-docx-doc", tree: { kind: "docx" } },
    passages: [
      { id: "sp-docx-p0", text: "Lezione 1. Grandezze fisiche e unità di misura.", section: "Lezione 1" },
      { id: "sp-docx-cited", text: notes, section: "Lezione 9" },
    ],
  });
  stored("sp-docx", docx(notes), "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx");
  seedSource(db, {
    id: "sp-link",
    title: "Serie di Fourier",
    kind: "link",
    subjectId: "sub-fis",
    document: { id: "sp-link-doc", tree: { kind: "link" } },
    passages: [{ id: "sp-link-p1", text: "Una funzione periodica si scrive come somma di seni e coseni.", section: "Coefficienti" }],
  });
  db.prepare("UPDATE sources SET origin_url = 'https://appunti.example.org/fourier', fetched_at = 1 WHERE id = 'sp-link'").run();
  // A file in a linked folder that was moved away: Pyxis keeps its text, not a copy.
  const folder = join(userData, "Università");
  mkdirSync(join(folder, "Fisica I"), { recursive: true });
  seedSource(db, {
    id: "sp-moved",
    title: "Appunti lezione 5",
    kind: "pdf",
    subjectId: "sub-fis",
    document: { id: "sp-moved-doc", tree: { kind: "pdf" } },
    passages: [{ id: "sp-moved-p3", text: "Nel moto circolare uniforme l'accelerazione punta verso il centro.", locator: { page: 3 }, section: "p. 3" }],
  });
  db.prepare("INSERT INTO linked_folders (id, path, mode, created_at) VALUES ('sp-folder', ?, 'root', 1)").run(folder);
  db.prepare(
    "INSERT INTO linked_files (folder_id, rel_path, subfolder, source_id, size, mtime_ms, missing_at) VALUES ('sp-folder', 'Fisica I/Appunti lezione 5.pdf', 'Fisica I', 'sp-moved', 1, 1, 1)",
  ).run();
  seedSource(db, {
    id: "sp-long",
    title: LONG_TITLE,
    kind: "pdf",
    subjectId: "sub-fis",
    document: { id: "sp-long-doc", tree: { kind: "pdf" } },
    passages: [{ id: "sp-long-p1", text: "Una riga del file dal nome lungo.", locator: { page: 1 }, section: "p. 1" }],
  });
  stored("sp-long", onePagePdf("Una riga del file dal nome lungo."), "application/pdf", "pdf");
  // A chat whose answer cites the textbook at page 412 and the Word notes.
  const now = Date.now();
  db.exec(`
    INSERT INTO chats(id,title,subject,created_at,updated_at) VALUES('sp-chat','Area sotto v(t)','Fisica I',${now},${now});
    INSERT INTO messages(id,chat_id,role,body,created_at) VALUES('sp-q','sp-chat','user','Perché l''area sotto v(t) è lo spostamento?',${now});
    INSERT INTO messages(id,chat_id,role,body,grounding,created_at) VALUES('sp-a','sp-chat','assistant',
      'Integrare la velocità vuol dire sommare tanti piccoli spostamenti [P1]. Lo stesso vale per un integrale doppio, fatto per fili [P2].','sources',${now + 1});
    INSERT INTO message_passages(message_id,passage_id,label) VALUES('sp-a','sp-book-cited','P1'),('sp-a','sp-docx-cited','P2');
  `);
  return { bookBytes: book.length };
}

/** Bigger than one `sources.readOriginal` call returns (2 MiB), so pdf.js asks for its stream in one longer range. */
export const FIGURE_BYTES = 1024 * 800 * 3;

/** One A4 page with a photo-sized picture on it, stored without compression, and a line of text under it. */
export function figurePdf(): Buffer {
  const pixels = Buffer.alloc(FIGURE_BYTES);
  for (let i = 0; i < pixels.length; i += 3) {
    const x = (i / 3) % 1024;
    const y = Math.floor(i / 3 / 1024);
    pixels[i] = (x * 7 + y) % 256;
    pixels[i + 1] = (y * 5) % 256;
    pixels[i + 2] = (x ^ y) % 256;
  }
  const content = "q 480 0 0 375 57 380 cm /Im1 Do Q\nBT /F1 12 Tf 72 340 Td (Una figura che pesa piu di due mega.) Tj ET";
  const head = Buffer.from("%PDF-1.4\n", "latin1");
  const objects: Buffer[] = [
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>", "latin1"),
    Buffer.from("<< /Type /Pages /Count 1 /Kids [3 0 R] >>", "latin1"),
    Buffer.from(
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> /XObject << /Im1 6 0 R >> >> >>",
      "latin1",
    ),
    Buffer.from(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`, "latin1"),
    Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman >>", "latin1"),
    Buffer.concat([
      Buffer.from(`<< /Type /XObject /Subtype /Image /Width 1024 /Height 800 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${FIGURE_BYTES} >>\nstream\n`, "latin1"),
      pixels,
      Buffer.from("\nendstream", "latin1"),
    ]),
  ];
  const parts = [head];
  let at = head.length;
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(at);
    const chunk = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`, "latin1"), body, Buffer.from("\nendobj\n", "latin1")]);
    parts.push(chunk);
    at += chunk.length;
  });
  const xref = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`, ...offsets.map((n) => `${String(n).padStart(10, "0")} 00000 n \n`)].join("");
  parts.push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${at}\n%%EOF\n`, "latin1"));
  return Buffer.concat(parts);
}

/**
 * Two more files, for what can go wrong while the panel is open: a stored PDF whose page has a picture larger than one
 * read, and a 40-page PDF in the linked folder that is there now (`linkedPath`), which a spec moves away. Seeded after
 * `seedSourcePanel`, whose linked folder it uses.
 */
export function seedPanelReads(db: DatabaseSync, userData: string): { linkedPath: string } {
  const workspace = join(userData, "workspace");
  seedSource(db, {
    id: "sp-figure",
    title: "Figura grande",
    kind: "pdf",
    subjectId: "sub-fis",
    document: { id: "sp-figure-doc", tree: { kind: "pdf" } },
    passages: [{ id: "sp-figure-p1", text: "Una figura che pesa piu di due mega.", locator: { page: 1 }, section: "p. 1" }],
  });
  const sha = putBlob(workspace, figurePdf(), "application/pdf", "pdf");
  db.prepare("UPDATE sources SET blob_sha = ?, mime = 'application/pdf' WHERE id = 'sp-figure'").run(sha);
  const linkedPath = join(userData, "Università", "Fisica I", "Esercizi svolti.pdf");
  writeFileSync(linkedPath, textbook(40));
  seedSource(db, {
    id: "sp-linked",
    title: "Esercizi svolti",
    kind: "pdf",
    subjectId: "sub-fis",
    document: { id: "sp-linked-doc", tree: { kind: "pdf" } },
    passages: [{ id: "sp-linked-p1", text: "Questa e la pagina 1 del testo di fisica.", locator: { page: 1 }, section: "p. 1" }],
  });
  const stat = statSync(linkedPath);
  db.prepare(
    "INSERT INTO linked_files (folder_id, rel_path, subfolder, source_id, size, mtime_ms, missing_at) VALUES ('sp-folder', 'Fisica I/Esercizi svolti.pdf', 'Fisica I', 'sp-linked', ?, ?, NULL)",
  ).run(stat.size, Math.trunc(stat.mtimeMs));
  return { linkedPath };
}
