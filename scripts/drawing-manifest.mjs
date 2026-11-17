// Run by hand when a file of the drawing pack changes: `node scripts/drawing-manifest.mjs`.
// Edit the file's name and URL in resources/drawing-manifest.json first, and raise the manifest's version. The script
// fetches every file the manifest names, writes its size and SHA-256 back, and puts the licence texts found inside
// each wheel into resources/third-party-notices.json. Review the diff before committing it: the hashes it writes are
// the ones every workspace will trust.
// A new graphviz.js starts with the constants GRAPHVIZ, WRAPPER and EXPAT below, which no download updates, and ends with a read of the notices it writes.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { unzipSync, strFromU8 } from "fflate";

const manifestPath = "resources/drawing-manifest.json";

// The licence texts of the pack's files that are not wheels, with the places they were read from. A wheel carries its own
// texts, which this script extracts; these files do not, so each is named here with its upstream and pinned by version.
// Graphviz (inside the WebAssembly of @hpcc-js/wasm-graphviz) is under the Eclipse Public License 2.0, which asks that the
// licence text and where the source can be had come with the program, so a statement of that is written from this table.
// `Graphviz.version()` says 16.1.0 for @hpcc-js/wasm-graphviz 1.30.0. The build also links Expat, whose version it does not state.
const GRAPHVIZ = { version: "16.1.0", commit: "e41c710710be080ad37af1b51c6e2f8beffa9ee5" };
const WRAPPER = { name: "@hpcc-js/wasm-graphviz", version: "1.30.0" };
const EXPAT = { release: "R_2_10_0", commit: "a70841d9ffa64ddde29ab824ed6305035ebe4c47" };
const NOTICES = {
  "graphviz.js": [
    {
      name: WRAPPER.name,
      version: WRAPPER.version,
      license: "Apache-2.0",
      texts: [
        { file: "LICENSE", source: `https://cdn.jsdelivr.net/npm/${WRAPPER.name}@${WRAPPER.version}/LICENSE` },
      ],
    },
    {
      name: "Graphviz",
      version: GRAPHVIZ.version,
      license: "EPL-2.0",
      texts: [
        { file: "LICENSE", source: `https://gitlab.com/graphviz/graphviz/-/raw/${GRAPHVIZ.commit}/LICENSE` },
        {
          file: "SOURCE",
          source: `https://gitlab.com/graphviz/graphviz/-/tree/${GRAPHVIZ.commit}`,
          text: [
            `Graphviz ${GRAPHVIZ.version} is made available under the terms of the Eclipse Public License, Version 2.0, whose text is above.`,
            `Its source code is available from https://gitlab.com/graphviz/graphviz (tag ${GRAPHVIZ.version}, commit ${GRAPHVIZ.commit}).`,
            `Pyxis downloads it compiled to WebAssembly by ${WRAPPER.name} ${WRAPPER.version}, whose build files are at https://github.com/hpcc-systems/hpcc-js-wasm.`,
            "Pyxis does not change it.",
            "",
          ].join("\n"),
        },
      ],
    },
    {
      name: "Expat (linked into Graphviz's WebAssembly build)",
      version: `not stated by the build; text of release ${EXPAT.release}`,
      license: "MIT",
      texts: [
        { file: "COPYING", source: `https://raw.githubusercontent.com/libexpat/libexpat/${EXPAT.commit}/expat/COPYING` },
      ],
    },
  ],
};
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
    const sources = NOTICES[file.name];
    if (!sources) throw new Error(`No notice sources for ${file.name}: add them to NOTICES.`);
    for (const source of sources) {
      const texts = [];
      for (const text of source.texts) {
        let body = text.text;
        if (body === undefined) {
          const reply = await fetch(text.source, { signal: AbortSignal.timeout(60_000) });
          if (!reply.ok) throw new Error(`HTTP ${reply.status}: ${text.source}`);
          body = await reply.text();
        }
        texts.push({ file: text.file, text: body, source: text.source, sha256: sha256(Buffer.from(body)), artifactSha256: file.sha256 });
      }
      const record = { name: source.name, version: source.version, license: source.license, texts, runtime: true };
      const at = notices.findIndex((notice) => notice.name === record.name);
      if (at >= 0) notices[at] = record;
      else notices.push(record);
    }
    console.log(`${file.name}: pinned, ${sources.map((source) => source.name).join(", ")}.`);
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
