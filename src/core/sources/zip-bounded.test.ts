import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { extractDocx, extractPptx } from "./documents";
import { parseSmartbook } from "./smartbook";
import { openZip } from "./zip-bounded";

const MIB = 1024 * 1024;
const small = { maxEntries: 50, maxEntryBytes: MIB, maxTotalBytes: MIB };

/** Rewrites the sizes every header declares, local and central, so the archive claims to be tiny. */
function lieAboutSizes(zip: Uint8Array): Uint8Array {
  const out = Buffer.from(zip);
  for (let i = 0; i + 30 <= out.length; i += 1) {
    if (out.readUInt32LE(i) === 0x04034b50) out.writeUInt32LE(10, i + 22);
    if (out.readUInt32LE(i) === 0x02014b50) out.writeUInt32LE(10, i + 24);
  }
  return out;
}

/** The same archive with its one entry listed a second time under another name, pointing at the same compressed bytes. */
function overlap(zip: Uint8Array): Uint8Array {
  const buf = Buffer.from(zip);
  const eocd = buf.length - 22;
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const cd = buf.subarray(cdOffset, eocd);
  const twin = Buffer.from(cd);
  twin.write("b", 46);
  const tail = Buffer.from(buf.subarray(eocd));
  tail.writeUInt16LE(2, 8);
  tail.writeUInt16LE(2, 10);
  tail.writeUInt32LE(cd.length * 2, 12);
  return Buffer.concat([buf.subarray(0, cdOffset), cd, twin, tail]);
}

const zeros = (mib: number) => new Uint8Array(mib * MIB);

describe("bounded zip reader", () => {
  it("reads stored and deflated entries, and nothing it was not asked for", () => {
    const zip = openZip(
      zipSync({
        "a.txt": [strToU8("stored"), { level: 0 }],
        "b/c.xml": strToU8("deflated ".repeat(50)),
      }),
      small,
    );
    expect(zip.names.sort()).toEqual(["a.txt", "b/c.xml"]);
    expect(Buffer.from(zip.read("a.txt")!).toString()).toBe("stored");
    expect(Buffer.from(zip.read("b/c.xml")!).toString()).toBe(
      "deflated ".repeat(50),
    );
    expect(zip.read("missing")).toBeUndefined();
  });

  it("counts the real output, so a header that declares 10 bytes cannot hide a bomb", () => {
    const bomb = lieAboutSizes(zipSync({ "bomb.xml": zeros(8) }));
    expect(bomb.length).toBeLessThan(20_000);
    expect(() => openZip(bomb, small).read("bomb.xml")).toThrow(
      "archive-too-large",
    );
  });

  it("shares one total across entries, so overlapping entries cannot multiply one compressed run", () => {
    const twice = overlap(zipSync({ a: new Uint8Array(700 * 1024) }));
    const zip = openZip(twice, small);
    expect(zip.names).toEqual(["a", "b"]);
    expect(zip.read("a")!.length).toBe(700 * 1024);
    expect(() => zip.read("b")).toThrow("archive-too-large");
  });

  it("refuses an entry count past the limit, and bytes that are not an archive", () => {
    const many = zipSync(
      Object.fromEntries(
        Array.from({ length: 6 }, (_, i) => [`f${i}`, strToU8("x")]),
      ),
    );
    expect(() => openZip(many, { ...small, maxEntries: 5 })).toThrow(
      "archive-too-large",
    );
    expect(() =>
      openZip(strToU8("not a zip at all, just text"), small),
    ).toThrow("archive-corrupt");
    expect(() => openZip(new Uint8Array(4), small)).toThrow("archive-corrupt");
  });

  it("refuses an encrypted entry", () => {
    const zip = Buffer.from(zipSync({ a: strToU8("secret") }));
    zip.writeUInt16LE(zip.readUInt16LE(8) | 1, 6);
    const cd = zip.readUInt32LE(zip.length - 22 + 16);
    zip.writeUInt16LE(zip.readUInt16LE(cd + 8) | 1, cd + 8);
    expect(() => openZip(zip, small)).toThrow("archive-unsupported");
  });
});

const docxParts = {
  "[Content_Types].xml":
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  "_rels/.rels":
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  "word/document.xml":
    '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>L\'energia interna cresce con il calore</w:t></w:r></w:p><w:p><w:r><w:t>Il lavoro compiuto dal gas</w:t></w:r></w:p></w:body></w:document>',
};
const docx = (extra: Record<string, Uint8Array> = {}) =>
  zipSync({
    ...Object.fromEntries(
      Object.entries(docxParts).map(([name, text]) => [name, strToU8(text)]),
    ),
    ...extra,
  });

describe("office extraction under the zip bound", () => {
  it("still reads a real-shaped .docx, through an archive of this app's own making", async () => {
    const extracted = await extractDocx(docx());
    expect(extracted.pages.map((page) => page.text).join("\n")).toContain(
      "energia interna cresce con il calore",
    );
    expect(extracted.pages.map((page) => page.text).join("\n")).toContain(
      "Il lavoro compiuto dal gas",
    );
  });

  it("never inflates a picture, so a bomb in the media folder costs nothing", async () => {
    // A media member that would blow every limit, with a header that claims 10 bytes.
    const bombed = lieAboutSizes(docx({ "word/media/bomb.bin": zeros(70) }));
    const started = Date.now();
    const result = await extractDocx(bombed);
    expect(result.pages[0]?.text).toContain("energia");
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("refuses a .docx whose text part inflates past the limit, whatever its header says", async () => {
    const bomb = lieAboutSizes(docx({ "word/document.xml": zeros(65) }));
    expect(bomb.length).toBeLessThan(300_000);
    await expect(extractDocx(bomb)).rejects.toThrow("archive-too-large");
  }, 30_000);

  it("refuses a .pptx slide that inflates past the limit, whatever its header says", () => {
    const bomb = lieAboutSizes(
      zipSync({
        "ppt/presentation.xml": strToU8(
          '<p:presentation><p:sldIdLst><p:sldId r:id="rId1"/></p:sldIdLst></p:presentation>',
        ),
        "ppt/_rels/presentation.xml.rels": strToU8(
          '<Relationships><Relationship Id="rId1" Target="slides/slide1.xml"/></Relationships>',
        ),
        "ppt/slides/slide1.xml": zeros(65),
      }),
    );
    expect(() => extractPptx(bomb)).toThrow("archive-too-large");
  });

  it("refuses a smartbook member that inflates past the limit, whatever its header says", () => {
    const bomb = lieAboutSizes(
      zipSync({
        "smartbook.json": strToU8(
          JSON.stringify({
            id: "x",
            title: "X",
            chapters: [{ number: 1, title: "Uno", file: "uno.md" }],
          }),
        ),
        "chapters/uno.md": zeros(65),
      }),
    );
    expect(() => parseSmartbook(bomb)).toThrow("archive-too-large");
  });
});
