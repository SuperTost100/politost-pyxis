import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import {
  blankPdf,
  extractPdf,
  extractPlain,
  extractPptx,
  importDocumentFile,
  manyPagePdf,
  onePagePdf,
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
