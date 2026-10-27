// Writes the notice records of the @napi-rs/canvas platform packages into resources/third-party-notices.json.
//
// Each platform package ships one native binary with Skia, the C libraries Skia vendors and the Rust crates the addon
// is built from, but no notice text beyond its package.json. Its sbom.cdx.json lists those components at exact
// versions. This script reads that SBOM from every platform package Pyxis packages, fetches each component's license
// and notice files from a pinned source, and stores them as supplementary texts that scripts/gen-notices.mjs checks and
// copies into the notices. It is run by hand after a canvas update and needs the network; builds never run it.
//
// Usage: node scripts/canvas-notices.mjs
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const resourcePath = join(root, "resources/third-party-notices.json");
// The targets electron-builder packages (docs/notices.md).
const platforms = ["darwin-arm64", "darwin-x64", "linux-x64-gnu", "win32-x64-msvc"];
const MAX_TEXT = 2 * 1024 * 1024;
// gen-notices.mjs refuses a supplementary record with more texts than this, so a long list is split across records.
const TEXTS_PER_RECORD = 256;
const legalName = /^(licen[cs]e|copying|copyright|notice|unlicense|patents)([-._][^/]*)?$/i;
const skippedDirectory = /(^|\/)(tests?|testdata|test_data|examples?|benches|fuzz)\//i;
// Files a component's own license points to under another name.
const extraFiles = {
  freetype: ["docs/FTL.TXT"],
  "libjpeg-turbo": ["README.ijg"],
};

async function download(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} for ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

/** Reads a gzipped tar archive into path -> contents, for regular files only. */
function untar(gzipped) {
  const data = gunzipSync(gzipped);
  const files = new Map();
  let offset = 0;
  let longName = null;
  while (offset + 512 <= data.length) {
    const header = data.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start, end) => header.subarray(start, end).toString("utf8").replace(/\0[\s\S]*$/, "");
    const size = Number.parseInt(field(124, 136).trim() || "0", 8);
    if (!Number.isSafeInteger(size)) throw new Error("Unreadable tar entry size");
    const type = String.fromCharCode(header[156] || 48);
    const body = data.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === "L") {
      longName = body.toString("utf8").replace(/\0[\s\S]*$/, "");
      continue;
    }
    if (type === "x") {
      longName = /\d+ path=([^\n]*)\n/.exec(body.toString("utf8"))?.[1] ?? longName;
      continue;
    }
    const prefix = field(345, 500);
    const name = longName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
    longName = null;
    if (type === "0" || type === "\0") files.set(name, body);
  }
  return files;
}

function asText(data, label) {
  if (data.length > MAX_TEXT || data.includes(0)) throw new Error(`Not a notice text: ${label}`);
  return new TextDecoder("utf-8", { fatal: true }).decode(data).replace(/\r\n?/g, "\n");
}

function text(file, source, data, artifactSha256) {
  const body = asText(data, file);
  return { file, source, sha256: sha256(body), ...(artifactSha256 ? { artifactSha256 } : {}), text: body };
}

/** The legal files of a downloaded crate, checked against the SBOM's hash of the .crate archive. */
async function crateTexts(component) {
  const hash = component.hashes?.find((entry) => entry.alg === "SHA-256")?.content;
  if (!hash) throw new Error(`No hash for crate ${component.name}`);
  const source = `https://static.crates.io/crates/${component.name}/${component.name}-${component.version}.crate`;
  const archive = await download(source);
  if (sha256(archive) !== hash) throw new Error(`Hash mismatch for crate ${component.name}@${component.version}`);
  const top = `${component.name}-${component.version}/`;
  const files = untar(archive);
  const texts = [];
  for (const [path, data] of [...files].sort(([a], [b]) => a.localeCompare(b, "en"))) {
    if (!path.startsWith(top)) continue;
    const inner = path.slice(top.length);
    if (inner.split("/").length > 4 || skippedDirectory.test(inner)) continue;
    if (!legalName.test(inner.split("/").pop())) continue;
    texts.push(text(`${component.name} ${component.version}: ${inner}`, `${source}#${inner}`, data, hash));
  }
  if (texts.length) return texts;
  // Some crates publish without their repository's license file. cargo records the commit it packaged from, so the
  // file comes from the repository root at that commit.
  const vcs = files.get(`${top}.cargo_vcs_info.json`);
  const manifest = files.get(`${top}Cargo.toml`)?.toString("utf8") ?? "";
  const commit = vcs ? JSON.parse(vcs.toString("utf8")).git?.sha1 : undefined;
  const repository = /^repository\s*=\s*"https:\/\/github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?\/?"/m.exec(manifest)?.[1];
  if (!commit || !/^[0-9a-f]{40}$/.test(commit) || !repository)
    throw new Error(`No license file and no pinned repository for crate ${component.name}@${component.version}`);
  const listing = await (await fetch(`https://api.github.com/repos/${repository}/contents/?ref=${commit}`)).json();
  if (!Array.isArray(listing)) throw new Error(`Could not list ${repository} at ${commit}`);
  for (const entry of listing.filter((item) => item.type === "file" && legalName.test(item.name))) {
    const url = `https://raw.githubusercontent.com/${repository}/${commit}/${entry.name}`;
    texts.push(text(`${component.name} ${component.version}: ${entry.name} (repository)`, url, await download(url)));
  }
  if (!texts.length) throw new Error(`No license file for crate ${component.name}@${component.version}`);
  return texts;
}

async function gitilesFile(repository, commit, path) {
  const encoded = await download(`${repository}/+/${commit}/${path}?format=TEXT`);
  return Buffer.from(encoded.toString("ascii"), "base64");
}

/** The legal files of a library Skia vendors, read from its repository at the pinned commit. */
async function vendoredTexts(component) {
  const repository = component.properties?.find((entry) => entry.name === "cdx:skia:repositoryUrl")?.value;
  const commit = component.version;
  if (!repository?.startsWith("https://") || !/^[0-9a-f]{40}$/.test(commit))
    throw new Error(`No pinned source for ${component.name}`);
  const listing = JSON.parse(
    (await download(`${repository}/+/${commit}/?format=JSON&recursive=1`)).toString("utf8").replace(/^\)\]\}'\n/, ""),
  );
  const paths = listing.entries
    .filter((entry) => entry.type === "blob")
    .map((entry) => entry.name)
    .filter((path) => path.split("/").length <= 2 && !skippedDirectory.test(path) && legalName.test(path.split("/").pop()));
  for (const extra of extraFiles[component.name] ?? []) if (!paths.includes(extra)) paths.push(extra);
  if (!paths.length) throw new Error(`No license file found for ${component.name}`);
  const texts = [];
  for (const path of paths.sort((a, b) => a.localeCompare(b, "en")))
    texts.push(text(`${component.name}: ${path}`, `${repository}/+/${commit}/${path}`, await gitilesFile(repository, commit, path)));
  return texts;
}

const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
const version = lock.packages["node_modules/@napi-rs/canvas"]?.version;
if (!version) throw new Error("@napi-rs/canvas is not in package-lock.json");
const canvasTag = `v${version}`;
const tag = await (await fetch(`https://api.github.com/repos/Brooooooklyn/canvas/git/ref/tags/${canvasTag}`)).json();
const tagObject = tag.object.type === "tag"
  ? (await (await fetch(tag.object.url)).json()).object
  : tag.object;
const canvasCommit = tagObject.sha;
const skia = await (await fetch(`https://api.github.com/repos/Brooooooklyn/canvas/contents/skia?ref=${canvasTag}`)).json();
if (!/^[0-9a-f]{40}$/.test(canvasCommit) || !/^[0-9a-f]{40}$/.test(skia.sha ?? ""))
  throw new Error(`Could not pin canvas ${canvasTag} or its Skia submodule`);
const canvasLicense = `https://raw.githubusercontent.com/Brooooooklyn/canvas/${canvasCommit}/LICENSE`;
const skiaLicense = `https://raw.githubusercontent.com/google/skia/${skia.sha}/LICENSE`;
const common = [
  text("LICENSE", canvasLicense, await download(canvasLicense)),
  text("Skia LICENSE", skiaLicense, await download(skiaLicense)),
];

const cache = new Map();
const records = [];
for (const platform of platforms) {
  const name = `@napi-rs/canvas-${platform}`;
  const entry = lock.packages[`node_modules/${name}`];
  if (entry?.version !== version) throw new Error(`${name}@${version} is not in package-lock.json`);
  const tarball = await download(entry.resolved);
  const [algorithm, digest] = entry.integrity.split("-");
  if (createHash(algorithm).update(tarball).digest("base64") !== digest) throw new Error(`Integrity mismatch for ${name}`);
  const sbom = JSON.parse(asText(untar(tarball).get("package/sbom.cdx.json") ?? Buffer.alloc(0), "sbom"));
  const texts = [...common];
  const components = sbom.components
    .filter((component) => component.type === "library")
    .sort((a, b) => a.name.localeCompare(b.name, "en") || a.version.localeCompare(b.version, "en"));
  for (const component of components) {
    // The addon's own crate; its license is the package LICENSE above.
    if (component.name === "canvas" && !component.hashes) continue;
    const key = component.purl;
    if (!cache.has(key)) {
      const found = key.startsWith("pkg:cargo/") ? await crateTexts(component) : await vendoredTexts(component);
      cache.set(key, found);
    }
    texts.push(...cache.get(key));
  }
  for (let start = 0; start < texts.length; start += TEXTS_PER_RECORD)
    records.push({ name, version, license: "MIT", texts: texts.slice(start, start + TEXTS_PER_RECORD) });
  console.log(`${name}@${version}: ${components.length} components, ${texts.length} texts`);
}

const existing = JSON.parse(await readFile(resourcePath, "utf8"));
const kept = existing.filter((record) => !record.name.startsWith("@napi-rs/canvas-"));
const at = existing.findIndex((record) => record.name.startsWith("@napi-rs/canvas-"));
kept.splice(at < 0 ? kept.length : at, 0, ...records);
await writeFile(resourcePath, `${JSON.stringify(kept, null, 2)}\n`);
