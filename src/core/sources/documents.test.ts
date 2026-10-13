import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import {
  addDocumentVersion,
  blankPdf,
  extractPdf,
  extractPlain,
  extractPptx,
  importDocumentFile,
  manyPagePdf,
  onePagePdf,
  storeExtracted,
  type ExtractedDocument,
} from "./documents";
import { listSources } from "./smartbook";

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

  it("splits markdown on headings", () => {
    const extracted = extractPlain("# Energia\n\nIl calore.\n\n# Lavoro\n\nIl lavoro.", true);
    expect(extracted.pages).toHaveLength(2);
    expect(extracted.pages[1]?.section).toBe("Lavoro");
  });

  it("stores a scanned PDF as needing OCR and keeps its text out", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pyxis-pdf-"));
    const file = join(dir, "scan.pdf");
    writeFileSync(file, blankPdf());
    const db = openDatabase(":memory:");
    const imported = await importDocumentFile(db, dir, file);
    expect(imported.passages).toBe(0);
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
