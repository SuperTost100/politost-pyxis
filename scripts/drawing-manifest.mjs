// Run by hand when a file of the drawing pack changes: `node scripts/drawing-manifest.mjs`.
// Edit the file's name and URL in resources/drawing-manifest.json first, and raise the manifest's version. The script
// fetches every file the manifest names, writes its size and SHA-256 back, and puts the licence texts found inside
// each wheel into resources/third-party-notices.json. Review the diff before committing it: the hashes it writes are
// the ones every workspace will trust.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { unzipSync, strFromU8 } from "fflate";

const manifestPath = "resources/drawing-manifest.json";
const noticesPath = "resources/third-party-notices.json";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const LICENCE_FILE = /\.dist-info\/(licenses\/.+|(LICEN[CS]E|COPYING|NOTICE)[^/]*)$/i;

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const notices = JSON.parse(await readFile(noticesPath, "utf8"));
for (const file of manifest.files) {
  if (!/^https:\/\//.test(file.url)) throw new Error(`Not an https URL: ${file.name}`);
  const response = await fetch(file.url, { signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${file.url}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  file.size = bytes.length;
  file.sha256 = sha256(bytes);
  if (!file.name.endsWith(".whl")) {
    console.log(`${file.name}: pinned. It is not a wheel, so add its notice by hand.`);
    continue;
  }
  const entries = unzipSync(bytes, {
    filter: (entry) => LICENCE_FILE.test(entry.name) || entry.name.endsWith(".dist-info/METADATA"),
  });
  const metadata = Object.entries(entries).find(([name]) => name.endsWith("/METADATA"));
  if (!metadata) throw new Error(`No METADATA in ${file.name}`);
  const field = (name) =>
    new RegExp(`^${name}: (.+)$`, "m").exec(strFromU8(metadata[1]).split(/\r?\n\r?\n/)[0])?.[1]?.trim();
  const texts = Object.entries(entries)
    .filter(([name]) => LICENCE_FILE.test(name))
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([name, text]) => ({
      file: name,
      text: strFromU8(text),
      source: file.url,
      sha256: sha256(text),
      artifactSha256: file.sha256,
    }));
  if (!texts.length) throw new Error(`No licence text in ${file.name}`);
  const record = {
    name: `Python: ${field("Name")}`,
    version: field("Version"),
    license: field("License-Expression") ?? field("License") ?? "See upstream license text",
    texts,
    runtime: true,
  };
  // One record per package: a new version replaces the old one, and a new package goes after the other wheels.
  const at = notices.findIndex((notice) => notice.name === record.name);
  if (at >= 0) notices[at] = record;
  else notices.splice(notices.findLastIndex((notice) => notice.name.startsWith("Python: ")) + 1, 0, record);
  console.log(`${file.name}: pinned, ${record.license}, ${texts.length} licence text(s).`);
}
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
await writeFile(noticesPath, `${JSON.stringify(notices, null, 2)}\n`);
