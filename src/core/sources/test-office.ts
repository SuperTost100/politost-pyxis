import { strToU8, zipSync } from "fflate";

/**
 * Small Word and PowerPoint files for tests, with pictures in them. A picture is the bytes of a PNG or JPEG; its paragraph
 * or slide holds nothing else, as in notes made of pasted slides or photographed pages.
 */

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const IMAGE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image";

const drawing = (rel: string, id: number) =>
  `<w:drawing><wp:inline><wp:extent cx="5400000" cy="2800000"/><wp:docPr id="${id}" name="Picture ${id}"/><a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="${rel}"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>`;

/** A .docx of `parts` in order: a string is a paragraph of text, bytes are a picture in a paragraph of its own. */
export function docxOf(parts: Array<string | Uint8Array>): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  const rels: string[] = [];
  const body = parts
    .map((part, index) => {
      if (typeof part === "string") return `<w:p><w:r><w:t xml:space="preserve">${part}</w:t></w:r></w:p>`;
      const n = rels.length + 1;
      files[`word/media/image${n}.png`] = part;
      rels.push(`<Relationship Id="rIdImg${n}" Type="${IMAGE}" Target="media/image${n}.png"/>`);
      return `<w:p/><w:p><w:r>${drawing(`rIdImg${n}`, index + 1)}</w:r></w:p>`;
    })
    .join("");
  return zipSync({
    "[Content_Types].xml": strToU8(
      `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    ),
    "_rels/.rels": strToU8(
      `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/></Relationships>`,
    ),
    "word/document.xml": strToU8(
      `<?xml version="1.0"?><w:document xmlns:w="${W}" xmlns:r="${R}" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>${body}<w:sectPr/></w:body></w:document>`,
    ),
    "word/_rels/document.xml.rels": strToU8(
      `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join("")}</Relationships>`,
    ),
    ...files,
  });
}

/** A .pptx of `slides` in order, each with its text, its pictures and its speaker notes. */
export function pptxOf(slides: Array<{ text?: string; pictures?: Uint8Array[]; notes?: string }>): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  let picture = 0;
  slides.forEach((slide, index) => {
    const n = index + 1;
    const rels: string[] = [];
    const shapes = (slide.pictures ?? []).map((bytes, at) => {
      picture += 1;
      files[`ppt/media/image${picture}.png`] = bytes;
      rels.push(`<Relationship Id="rIdP${at + 1}" Type="${IMAGE}" Target="../media/image${picture}.png"/>`);
      return `<p:pic><p:blipFill><a:blip r:embed="rIdP${at + 1}"/></p:blipFill></p:pic>`;
    });
    files[`ppt/slides/slide${n}.xml`] = strToU8(
      `<p:sld><p:cSld><p:spTree>${slide.text ? `<p:sp><p:txBody><a:p><a:r><a:t>${slide.text}</a:t></a:r></a:p></p:txBody></p:sp>` : ""}${shapes.join("")}</p:spTree></p:cSld></p:sld>`,
    );
    if (slide.notes) {
      rels.push(`<Relationship Id="rIdN" Type="${R}/notesSlide" Target="../notesSlides/notesSlide${n}.xml"/>`);
      files[`ppt/notesSlides/notesSlide${n}.xml`] = strToU8(
        `<p:notes><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${slide.notes}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>`,
      );
    }
    if (rels.length) files[`ppt/slides/_rels/slide${n}.xml.rels`] = strToU8(`<Relationships>${rels.join("")}</Relationships>`);
  });
  return zipSync({
    "ppt/presentation.xml": strToU8(
      `<p:presentation><p:sldIdLst>${slides.map((_, index) => `<p:sldId r:id="rId${index + 1}"/>`).join("")}</p:sldIdLst></p:presentation>`,
    ),
    "ppt/_rels/presentation.xml.rels": strToU8(
      `<Relationships>${slides.map((_, index) => `<Relationship Id="rId${index + 1}" Target="slides/slide${index + 1}.xml"/>`).join("")}</Relationships>`,
    ),
    ...files,
  });
}
