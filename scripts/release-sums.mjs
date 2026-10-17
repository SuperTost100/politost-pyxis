import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Merges the SHA256SUMS that each CI packaging job writes into the one file a release carries. Every listed file is
// hashed again, every file next to a SHA256SUMS must be listed, and every installer the in-app updater downloads must
// have a line. Names are written as GitHub's asset names, with the spaces turned into dots.

/** The installers src/main/update-install.ts looks for on a release, by their asset names. */
export function requiredAssets(version) {
  return [
    `PoliTost.Pyxis-${version}-arm64-mac.zip`,
    `PoliTost.Pyxis-${version}-mac.zip`,
    `PoliTost.Pyxis-${version}-arm64.dmg`,
    `PoliTost.Pyxis-${version}.dmg`,
    `PoliTost.Pyxis.Setup.${version}.exe`,
    `PoliTost.Pyxis-${version}.AppImage`,
    `politost-pyxis_${version}_amd64.deb`,
  ];
}

/** GitHub stores an uploaded file's spaces as dots. Other characters it would also rename are refused. */
export function assetName(name) {
  const dotted = name.replaceAll(" ", ".");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(dotted))
    throw new Error(`unexpected characters in ${JSON.stringify(name)}`);
  return dotted;
}

function sha256(file) {
  return new Promise((done, fail) => {
    const hash = createHash("sha256");
    createReadStream(file)
      .on("error", fail)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => done(hash.digest("hex")));
  });
}

/** The merged SHA256SUMS text for the per-target folders, each holding its installers and their SHA256SUMS. */
export async function mergeSums(folders, version) {
  const merged = new Map();
  for (const folder of folders) {
    const lines = (await readFile(join(folder, "SHA256SUMS"), "utf8"))
      .split("\n")
      .filter(Boolean);
    const listed = new Set();
    for (const line of lines) {
      const match = line.match(/^([0-9a-f]{64}) {2}(.+)$/);
      if (!match) throw new Error(`${folder}: not a checksum line: ${line}`);
      const [, hash, name] = match;
      const asset = assetName(name);
      if (merged.has(asset)) throw new Error(`${asset} is listed twice`);
      const actual = await sha256(join(folder, name));
      if (actual !== hash)
        throw new Error(`${folder}: ${name} has SHA-256 ${actual}`);
      merged.set(asset, hash);
      listed.add(name);
    }
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (entry.name !== "SHA256SUMS" && !listed.has(entry.name))
        throw new Error(`${folder}: ${entry.name} has no checksum line`);
    }
  }
  const missing = requiredAssets(version).filter((name) => !merged.has(name));
  if (missing.length) throw new Error(`no checksum for ${missing.join(", ")}`);
  return [...merged.keys()]
    .sort()
    .map((name) => `${merged.get(name)}  ${name}\n`)
    .join("");
}

// node scripts/release-sums.mjs <output file> <folder>...
if (import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [output, ...folders] = process.argv.slice(2);
  if (!output || folders.length === 0)
    throw new Error("usage: release-sums.mjs <output file> <folder>...");
  const { version } = JSON.parse(await readFile("package.json", "utf8"));
  const text = await mergeSums(folders, version);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, text);
  process.stdout.write(text);
}
