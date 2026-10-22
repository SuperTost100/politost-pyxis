import { createHash } from "node:crypto";

// PDF files built in code for tests: no fixture file to keep, and offsets are computed.

/** A one-page PDF whose only text is `label`. Offsets are computed. */
export function onePagePdf(label: string): Uint8Array {
  const safe = label.replace(/[()\\]/g, "");
  const stream = `BT /F1 18 Tf 20 100 Td (${safe}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  return pdfBytes(objects);
}

export function manyPagePdf(count: number, label: string): Uint8Array {
  const safe = label.replace(/[()\\]/g, "");
  const fontId = count + 3;
  const kids = Array.from(
    { length: count },
    (_, index) => `${index + 3} 0 R`,
  ).join(" ");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Count ${count} /Kids [${kids}] >>`,
  ];
  for (let page = 1; page <= count; page += 1) {
    const contentId = fontId + page;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents ${contentId} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`,
    );
  }
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  for (let page = 1; page <= count; page += 1) {
    const stream = `BT /F1 12 Tf 20 100 Td (${safe} ${page}) Tj ET`;
    objects.push(
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    );
  }
  return pdfBytes(objects);
}

/** The padding string of the PDF standard security handler. */
const PDF_PAD = Buffer.from(
  "28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a",
  "hex",
);

function rc4(key: Uint8Array, data: Uint8Array): Buffer {
  const box = Array.from({ length: 256 }, (_, index) => index);
  for (let i = 0, j = 0; i < 256; i += 1) {
    j = (j + box[i]! + key[i % key.length]!) & 255;
    [box[i], box[j]] = [box[j]!, box[i]!];
  }
  const out = Buffer.alloc(data.length);
  for (let n = 0, i = 0, j = 0; n < data.length; n += 1) {
    i = (i + 1) & 255;
    j = (j + box[i]!) & 255;
    [box[i], box[j]] = [box[j]!, box[i]!];
    out[n] = data[n]! ^ box[(box[i]! + box[j]!) & 255]!;
  }
  return out;
}

/**
 * A one-page PDF whose only text is `label`, locked with `password` by the standard 40-bit RC4 handler (revision 2),
 * the oldest scheme pdf.js reads. Opening it asks for the password.
 */
export function lockedPdf(label: string, password: string): Uint8Array {
  const md5 = (...parts: Uint8Array[]) => createHash("md5").update(Buffer.concat(parts)).digest();
  const padded = (text: string) => Buffer.concat([Buffer.from(text, "latin1"), PDF_PAD]).subarray(0, 32);
  const id = Buffer.from("7079786973206c6f636b656420706466", "hex");
  const owner = rc4(md5(padded(`${password}-owner`)).subarray(0, 5), padded(password));
  const permissions = Buffer.from([0xfc, 0xff, 0xff, 0xff]);
  const key = md5(padded(password), owner, permissions, id).subarray(0, 5);
  const user = rc4(key, PDF_PAD);
  const safe = label.replace(/[()\\]/g, "");
  // Only the page's content stream holds a string to hide. Its key also mixes in its object number, 4.
  const stream = rc4(
    md5(key, Buffer.from([4, 0, 0, 0, 0])).subarray(0, 10),
    Buffer.from(`BT /F1 12 Tf 20 100 Td (${safe}) Tj ET`, "latin1"),
  ).toString("latin1");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Filter /Standard /V 1 /R 2 /O <${owner.toString("hex")}> /U <${user.toString("hex")}> /P -4 >>`,
  ];
  return pdfBytes(objects, `/Encrypt 6 0 R /ID [<${id.toString("hex")}> <${id.toString("hex")}>]`);
}

export function blankPdf(): Uint8Array {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] >>",
  ];
  return pdfBytes(objects);
}

/** Builds the file from objects written as Latin-1 text, so binary stream bytes keep their values and offsets. */
function pdfBytes(objects: string[], trailer = ""): Uint8Array {
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = body.length;
  let table = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    table += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  body += table;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${trailer ? ` ${trailer}` : ""} >>\nstartxref\n${xref}\n%%EOF`;
  return new Uint8Array(Buffer.from(body, "latin1"));
}
