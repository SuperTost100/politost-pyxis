import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import {
  addDocumentVersion,
  extractPdf,
  extractPlain,
  extractPptx,
  storeExtracted,
  type ExtractedDocument,
} from "./documents";
import { onePagePdf, manyPagePdf, lockedPdf, blankPdf } from "./test-pdf";
import { listSources } from "./smartbook";
import { sourceDetails } from "./details";
import { tempDir } from "../test-temp";
import { sourceImports } from "./test-import";

describe("document extract", () => {
  it("reads the text layer of a PDF", async () => {
    const extracted = await extractPdf(
      onePagePdf("l energia interna del sistema aumenta con il calore"),
    );
    expect(extracted.pages[0]?.text).toContain("energia");
    expect(extracted.scanned).toBe(false);
    expect(extracted.pages[0]?.locator.page).toBe(1);
  });

  it("calls a PDF with no text a scan", async () => {
    const extracted = await extractPdf(blankPdf());
    expect(extracted.scanned).toBe(true);
    expect(extracted.pages[0]?.text).toBe("");
  });

  it("reads slide text from a pptx zip", () => {
    const xml = `<?xml version="1.0"?><p:sld><a:t>forza</a:t></p:sld>`;
    const bytes = zipSync({
      "ppt/presentation.xml": strToU8(
        `<p:presentation><p:sldIdLst><p:sldId r:id="rId1"/></p:sldIdLst></p:presentation>`,
      ),
      "ppt/_rels/presentation.xml.rels": strToU8(
        `<Relationships><Relationship Id="rId1" Target="slides/slide1.xml"/></Relationships>`,
      ),
      "ppt/slides/slide1.xml": strToU8(xml),
    });
    const extracted = extractPptx(bytes);
    expect(extracted.pages[0]?.text).toBe("forza");
    expect(extracted.pages[0]?.locator.slide).toBe(1);
    const reversed = extractPptx(
      zipSync({
        "ppt/presentation.xml": strToU8(
          `<p:presentation><p:sldIdLst><p:sldId r:id="rId1"/></p:sldIdLst></p:presentation>`,
        ),
        "ppt/_rels/presentation.xml.rels": strToU8(
          `<Relationships><Relationship Target="slides/slide1.xml" Id="rId1"/></Relationships>`,
        ),
        "ppt/slides/slide1.xml": strToU8(`<p:sld><a:t>R&amp;D</a:t></p:sld>`),
      }),
    );
    expect(reversed.pages[0]?.text).toBe("R&D");
  });

  it("reads a pptx whose XML repeats open tags without closing them in linear time", () => {
    // Every `<p:sldId`, `<Relationship` and `<a:t` here starts a match that never completes. A pattern that scans to the end of the
    // part for each start takes quadratic time on this; one that stops at the next `<` does not.
    const hostile = (tag: string) => strToU8(tag.repeat(60_000));
    const started = performance.now();
    const extracted = extractPptx(
      zipSync({
        "ppt/presentation.xml": hostile("<p:sldId "),
        "ppt/_rels/presentation.xml.rels": hostile("<Relationship "),
        "ppt/slides/slide1.xml": hostile("<a:t "),
      }),
    );
    expect(extracted.pages).toEqual([]);
    expect(performance.now() - started).toBeLessThan(1500);
    // Valid slides still read the same: the id after other attributes, and text with attributes on its tag.
    const real = extractPptx(
      zipSync({
        "ppt/presentation.xml": strToU8(`<p:presentation><p:sldIdLst><p:sldId id="256" r:id="rId9"/></p:sldIdLst></p:presentation>`),
        "ppt/_rels/presentation.xml.rels": strToU8(`<Relationships><Relationship Type="x" Id="rId9" Target="slides/slide1.xml"/></Relationships>`),
        "ppt/slides/slide1.xml": strToU8(`<p:sld><a:t xml:space="preserve">lavoro</a:t></p:sld>`),
      }),
    );
    expect(real.pages[0]?.text).toBe("lavoro");
  });

  it("adds each slide's speaker notes to its passage, found through the slide's relationships", () => {
    const notesType = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide";
    const shape = (placeholder: string, text: string) =>
      `<p:sp><p:nvSpPr><p:nvPr><p:ph type="${placeholder}" idx="1"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`;
    const extracted = extractPptx(
      zipSync({
        "ppt/presentation.xml": strToU8(
          `<p:presentation><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId3"/><p:sldId id="258" r:id="rId4"/></p:sldIdLst></p:presentation>`,
        ),
        "ppt/_rels/presentation.xml.rels": strToU8(
          `<Relationships><Relationship Id="rId2" Target="slides/slide1.xml"/><Relationship Id="rId3" Target="slides/slide2.xml"/><Relationship Id="rId4" Target="/ppt/slides/slide3.xml"/></Relationships>`,
        ),
        "ppt/slides/slide1.xml": strToU8(`<p:sld><a:t>Primo principio</a:t></p:sld>`),
        // The notes part is named by a relative target, next to a layout relationship that is not notes.
        "ppt/slides/_rels/slide1.xml.rels": strToU8(
          `<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="${notesType}" Target="../notesSlides/notesSlide7.xml"/></Relationships>`,
        ),
        "ppt/slideLayouts/slideLayout1.xml": strToU8(`<p:sldLayout><a:t>Titolo del layout</a:t></p:sldLayout>`),
        // The slide picture, the page number, header, footer and date are not the speaker's notes.
        "ppt/notesSlides/notesSlide7.xml": strToU8(
          `<p:notes><p:cSld><p:spTree>${shape("sldImg", "")}${shape("body", "Il calore Q &amp; il lavoro L")}${shape("body", "cambiano l&apos;energia interna.")}${shape("sldNum", "1")}${shape("ftr", "Fisica tecnica")}${shape("dt", "15/10")}${shape("hdr", "Lezione 3")}</p:spTree></p:cSld></p:notes>`,
        ),
        // A slide without notes reads as before.
        "ppt/slides/slide2.xml": strToU8(`<p:sld><a:t>Secondo principio</a:t></p:sld>`),
        // A slide with only notes still gets a passage, and an absolute target resolves from the archive root.
        "ppt/slides/slide3.xml": strToU8(`<p:sld></p:sld>`),
        "ppt/slides/_rels/slide3.xml.rels": strToU8(
          `<Relationships><Relationship Id="rId1" Target="/ppt/notesSlides/notesSlide1.xml" Type="${notesType}"/></Relationships>`,
        ),
        "ppt/notesSlides/notesSlide1.xml": strToU8(`<p:notes>${shape("body", "Spiegare il ciclo di Carnot.")}</p:notes>`),
      }),
    );
    expect(extracted.pages).toEqual([
      {
        text: "Primo principio\n\nSpeaker notes: Il calore Q & il lavoro L cambiano l'energia interna.",
        locator: { slide: 1 },
        section: "slide 1",
      },
      { text: "Secondo principio", locator: { slide: 2 }, section: "slide 2" },
      { text: "Speaker notes: Spiegare il ciclo di Carnot.", locator: { slide: 3 }, section: "slide 3" },
    ]);
  });

  it("reads hostile notes parts in linear time", () => {
    const started = performance.now();
    const extracted = extractPptx(
      zipSync({
        "ppt/presentation.xml": strToU8(`<p:presentation><p:sldIdLst><p:sldId r:id="rId1"/></p:sldIdLst></p:presentation>`),
        "ppt/_rels/presentation.xml.rels": strToU8(`<Relationships><Relationship Id="rId1" Target="slides/slide1.xml"/></Relationships>`),
        "ppt/slides/slide1.xml": strToU8(`<p:sld><a:t>forza</a:t></p:sld>`),
        "ppt/slides/_rels/slide1.xml.rels": strToU8(
          `${"<Relationship ".repeat(60_000)}<Relationship Type="x/notesSlide" Target="../notesSlides/notesSlide1.xml"/>`,
        ),
        "ppt/notesSlides/notesSlide1.xml": strToU8(`${"<p:sp ".repeat(60_000)}<a:t>nota</a:t></p:sp>`),
      }),
    );
    expect(extracted.pages[0]?.text).toBe("forza\n\nSpeaker notes: nota");
    expect(performance.now() - started).toBeLessThan(1500);
  });

  it("names a PDF locked with a password, and reads it with the right one", async () => {
    // pdf.js takes over the bytes it is given, so each read gets its own copy.
    const locked = () => lockedPdf("energia interna e calore", "polito2026");
    // The bytes are really encrypted: the text is not in the file as written.
    expect(Buffer.from(locked()).toString("latin1")).not.toContain("energia");
    await expect(extractPdf(locked())).rejects.toThrow("pdf-password-required");
    await expect(extractPdf(locked(), "sbagliata")).rejects.toThrow("pdf-password-wrong");
    const extracted = await extractPdf(locked(), "polito2026");
    expect(extracted.pages[0]?.text).toBe("energia interna e calore");
  });

  it("splits markdown on headings", () => {
    const extracted = extractPlain("# Energia\n\nIl calore.\n\n# Lavoro\n\nIl lavoro.", true);
    expect(extracted.pages).toHaveLength(2);
    expect(extracted.pages[1]?.section).toBe("Lavoro");
  });

  it("stores a scanned PDF as needing OCR and keeps its text out", async () => {
    const dir = tempDir("pyxis-pdf-");
    const file = join(dir, "scan.pdf");
    writeFileSync(file, blankPdf());
    const db = openDatabase(":memory:");
    await sourceImports(db, dir).file(file);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM passages`).get()).toEqual({ n: 0 });
    expect(listSources(db)[0]?.status).toBe("needs-ocr");
  });

  it("indexes a 600-page PDF", async () => {
    const extracted = await extractPdf(
      manyPagePdf(600, "energia interna del sistema termodinamico"),
    );
    expect(extracted.scanned).toBe(false);
    expect(extracted.pages).toHaveLength(600);
    expect(extracted.pages[599]?.text).toContain("600");
  });
});

describe("documents that are partly or wholly scanned", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const workspace = (name: string) => {
    const dir = mkdtempSync(join(tmpdir(), name));
    dirs.push(dir);
    return dir;
  };
  const text = "Il primo principio della termodinamica lega calore, lavoro ed energia interna.";
  // One page with a text layer and two scanned pages: most pages are thin, so the PDF counts as a scan.
  const mixed: ExtractedDocument = {
    pages: [
      { text, locator: { page: 1 }, section: "p. 1" },
      { text: "", locator: { page: 2 }, section: "p. 2" },
      { text: "12", locator: { page: 3 }, section: "p. 3" },
    ],
    scanned: true,
  };
  const scan: ExtractedDocument = {
    pages: [{ text: "", locator: { page: 1 }, section: "p. 1" }],
    scanned: true,
  };
  const pagesOf = (db: ReturnType<typeof openDatabase>, sourceId: string) =>
    db
      .prepare(
        `SELECT DISTINCT json_extract(locator_json, '$.page') AS page FROM passages
         WHERE source_id = ? AND version = (SELECT MAX(version) FROM source_documents WHERE source_id = ?)`,
      )
      .all(sourceId, sourceId);

  it("keeps the text pages of a mixed PDF and leaves only the thin pages to OCR", () => {
    const dir = workspace("pyxis-mixed-");
    const db = openDatabase(":memory:");
    const stored = storeExtracted(db, dir, {
      title: "Termodinamica", kind: "pdf", mime: "application/pdf", ext: ".pdf",
      bytes: new Uint8Array([1]), extracted: mixed,
    });
    expect(listSources(db)[0]?.status).toBe("needs-ocr");
    expect(pagesOf(db, stored.sourceId)).toEqual([{ page: 1 }]);
  });

  it("keeps the text pages of a mixed PDF that replaces a file", () => {
    const dir = workspace("pyxis-mixed-replace-");
    const db = openDatabase(":memory:");
    const stored = storeExtracted(db, dir, {
      title: "Vecchio", kind: "text", mime: "text/plain", ext: ".txt",
      bytes: new Uint8Array([1]), extracted: extractPlain("Testo precedente della fonte, abbastanza lungo.", false),
    });
    addDocumentVersion(db, dir, stored.sourceId, {
      title: "Nuovo", mime: "application/pdf", ext: ".pdf", bytes: new Uint8Array([2]), extracted: mixed,
    });
    expect(pagesOf(db, stored.sourceId)).toEqual([{ page: 1 }]);
    expect(listSources(db)[0]?.status).toBe("needs-ocr");
  });

  it("lists the sections of the current version only, not of every saved version", () => {
    const dir = workspace("pyxis-section-count-");
    const db = openDatabase(":memory:");
    const stored = storeExtracted(db, dir, {
      title: "Dispensa", kind: "text", mime: "text/markdown", ext: ".md",
      bytes: new Uint8Array([1]),
      extracted: extractPlain(
        [
          "# Calore\nPrimo paragrafo sul calore e sul lavoro, abbastanza lungo.",
          "# Energia\nSecondo paragrafo sull energia interna del sistema.",
          "# Entropia\nTerzo paragrafo sull entropia e sul secondo principio.",
        ].join("\n\n"),
        true,
      ),
    });
    expect(listSources(db)[0]?.sections).toBe(3);
    addDocumentVersion(db, dir, stored.sourceId, {
      title: "Dispensa", mime: "text/markdown", ext: ".md", bytes: new Uint8Array([2]),
      extracted: extractPlain("# Calore\nUna versione più breve, con una sola sezione.", true),
    });
    expect(listSources(db)[0]?.sections).toBe(1);
  });

  it("lists distinct sections like the source panel, not passages, and one section as one", () => {
    const dir = workspace("pyxis-section-figure-");
    const db = openDatabase(":memory:");
    const body = "Il calore passa dal corpo più caldo a quello più freddo finché le temperature si eguagliano.";
    const page = (n: number, section: string) => ({ text: `${body} ${n}`, locator: { page: n }, section });
    const stored = storeExtracted(db, dir, {
      title: "Dispensa", kind: "pdf", mime: "application/pdf", ext: ".pdf", bytes: new Uint8Array([1]),
      extracted: {
        pages: [page(1, "Calore"), page(2, "Calore"), page(3, "Calore"), page(4, "Entropia")],
        scanned: false,
      },
    });
    const passages = db.prepare(`SELECT COUNT(*) AS n FROM passages WHERE source_id = ?`).get(stored.sourceId) as { n: number };
    expect(passages.n).toBeGreaterThan(2);
    expect(listSources(db)[0]?.sections).toBe(2);
    expect(sourceDetails(db, stored.sourceId)?.sections).toBe(2);

    // A version with one section: the label reads "1 sezione", from a count of 1.
    addDocumentVersion(db, dir, stored.sourceId, {
      title: "Dispensa", mime: "application/pdf", ext: ".pdf", bytes: new Uint8Array([2]),
      extracted: { pages: [page(1, "Calore"), page(2, "Calore")], scanned: false },
    });
    expect(listSources(db)[0]?.sections).toBe(1);
    expect(sourceDetails(db, stored.sourceId)?.sections).toBe(1);

    // Passages with no section fall back to the pages they came from, in the list and the panel alike.
    db.prepare(`UPDATE passages SET section_path = NULL WHERE source_id = ?`).run(stored.sourceId);
    expect(listSources(db)[0]?.sections).toBe(2);
    expect(sourceDetails(db, stored.sourceId)?.sections).toBe(2);
  });

  it("refuses a replacement with no text and keeps the version in use", () => {
    const dir = workspace("pyxis-scan-replace-");
    const db = openDatabase(":memory:");
    const stored = storeExtracted(db, dir, {
      title: "Vecchio", kind: "text", mime: "text/plain", ext: ".txt",
      bytes: new Uint8Array([1]), extracted: extractPlain("Testo precedente della fonte, abbastanza lungo.", false),
    });
    expect(() =>
      addDocumentVersion(db, dir, stored.sourceId, {
        title: "Scansione", mime: "application/pdf", ext: ".pdf", bytes: new Uint8Array([2]), extracted: scan,
      }),
    ).toThrow("replace-no-text");
    expect(listSources(db)[0]).toMatchObject({ title: "Vecchio", status: "ready", kind: "text" });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM source_documents WHERE source_id = ?`).get(stored.sourceId)).toEqual({ n: 1 });
  });
});
