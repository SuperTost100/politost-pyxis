import {
  readFile,
  readdir,
  realpath,
  stat,
  mkdir,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const root = process.argv[2]
  ? resolve(process.argv[2])
  : resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_FILE = 2 * 1024 * 1024;
const MAX_TOTAL = 32 * 1024 * 1024;
const MAX_PACKAGES = 4000;
let total = 0;

async function textFile(path, packageRoot, maxFile = MAX_FILE) {
  const canonical = await realpath(path);
  const rel = relative(await realpath(packageRoot), canonical);
  if (rel.startsWith(`..${sep}`) || rel === "..")
    throw new Error(`Notice escapes package: ${basename(path)}`);
  const info = await stat(canonical);
  if (!info.isFile() || info.size > maxFile)
    throw new Error(`Invalid or oversized notice: ${basename(path)}`);
  total += info.size;
  if (total > MAX_TOTAL) throw new Error("Third-party notices exceed 32 MiB");
  const data = await readFile(canonical);
  if (data.includes(0))
    throw new Error(`Binary notice refused: ${basename(path)}`);
  return new TextDecoder("utf-8", { fatal: true })
    .decode(data)
    .replace(/\r\n?/g, "\n");
}

async function json(path, maxFile = MAX_FILE) {
  return JSON.parse(
    await textFile(path, await realpath(dirname(path)), maxFile),
  );
}

const safeName = /^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i;
async function packageAt(name, from) {
  if (!safeName.test(name)) throw new Error("Invalid dependency package name");
  let folder = from;
  for (;;) {
    const candidate = join(folder, "node_modules", name, "package.json");
    try {
      await stat(candidate);
      return await realpath(dirname(candidate));
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
    }
    const parent = dirname(folder);
    if (parent === folder) return null;
    folder = parent;
  }
}

const noticeName =
  /^(?:licen[cs]e|copying|copyright|notice|third[_ -]?party(?:[_ -]?(?:licen[cs]es?|notices?))?)(?:[._ -].*)?$/i;
const legalFolder =
  /^(?:licen[cs]es?|legal|notices?|third[_ -]?party[_ -]?notices?|lib-vendor)$/i;
async function licenseTexts(folder) {
  const texts = [];
  async function scan(current, depth) {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort(
      (a, b) => a.name.localeCompare(b.name, "en"),
    )) {
      const path = join(current, entry.name);
      if (
        entry.isDirectory() &&
        depth < 2 &&
        (legalFolder.test(entry.name) || basename(current) === "lib-vendor")
      )
        await scan(path, depth + 1);
      else if (
        entry.isFile() &&
        (noticeName.test(entry.name) ||
          (depth > 0 &&
            !relative(folder, current).split(sep).includes("lib-vendor")))
      ) {
        if (texts.length >= 256)
          throw new Error("Too many notice files in one package");
        texts.push({
          file: relative(folder, path).split(sep).join("/"),
          text: await textFile(path, folder),
        });
      }
    }
  }
  await scan(folder, 0);
  return texts;
}

function licenseOf(pkg) {
  const value = pkg.license ?? pkg.licenses;
  if (typeof value === "string") return value;
  if (Array.isArray(value))
    return value
      .map((item) =>
        typeof item === "string" ? item : (item?.type ?? "Unspecified"),
      )
      .join(" OR ");
  return typeof value?.type === "string" ? value.type : "Unspecified";
}

const app = await json(join(root, "package.json"));
const visited = new Set();
const records = new Map();
const installedRoots = new Map();
const missing = new Set();
async function visit(name, from, optional = false) {
  const folder = await packageAt(name, from);
  if (!folder) {
    if (optional) return;
    throw new Error(`Required production dependency not installed: ${name}`);
  }
  if (visited.has(folder)) return;
  visited.add(folder);
  if (visited.size > MAX_PACKAGES)
    throw new Error("Too many production dependencies");
  const pkg = await json(join(folder, "package.json"));
  const key = `${pkg.name}@${pkg.version}`;
  if (typeof pkg.name !== "string" || typeof pkg.version !== "string")
    throw new Error("Missing package name/version");
  const texts = await licenseTexts(folder);
  const license = licenseOf(pkg);
  const existing = records.get(key);
  if (existing && JSON.stringify(existing.texts) !== JSON.stringify(texts))
    throw new Error(`Different licenses for duplicate package: ${key}`);
  records.set(key, { name: pkg.name, version: pkg.version, license, texts });
  installedRoots.set(key, [...(installedRoots.get(key) ?? []), folder]);
  if (!texts.length) missing.add(key);
  const optionalNames = new Set(Object.keys(pkg.optionalDependencies ?? {}));
  for (const dep of Object.keys(pkg.dependencies ?? {}).sort())
    await visit(dep, folder, optionalNames.has(dep));
  for (const dep of [...optionalNames].sort()) await visit(dep, folder, true);
  // Installed peers are shipped by the application, even when the package does
  // not list them as its own production dependency.
  for (const dep of Object.keys(pkg.peerDependencies ?? {}).sort())
    await visit(dep, folder, true);
}
for (const name of Object.keys(app.dependencies ?? {}).sort())
  await visit(name, root, !!app.optionalDependencies?.[name]);
for (const name of Object.keys(app.optionalDependencies ?? {}).sort())
  await visit(name, root, true);

for (const [name, file] of [
  ["Figtree", "Figtree-OFL.txt"],
  ["JetBrains Mono", "JetBrainsMono-OFL.txt"],
]) {
  const folder = join(root, "src/renderer/src/design-system/fonts");
  records.set(`font:${name}`, {
    name,
    version: "Fontsource 5.3.0",
    license: "OFL-1.1",
    texts: [{ file, text: await textFile(join(folder, file), folder) }],
  });
}
// Version-pinned upstream texts fill omissions in published packages and cover
// the separately downloaded Python runtime/model. Builds make no requests.
const supplementalPath = join(root, "resources/third-party-notices.json");
let supplements = [];
try {
  supplements = await json(supplementalPath, MAX_TOTAL);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
if (!Array.isArray(supplements) || supplements.length > MAX_PACKAGES)
  throw new Error("Invalid supplementary notices");
for (const notice of supplements) {
  if (
    typeof notice.name !== "string" ||
    typeof notice.version !== "string" ||
    typeof notice.license !== "string" ||
    !Array.isArray(notice.texts) ||
    !notice.texts.length ||
    notice.texts.length > 256
  )
    throw new Error("Invalid supplementary notice");
  const key = `${notice.name}@${notice.version}`;
  const existing = records.get(key);
  if (!existing && !notice.runtime) continue; // Another platform/version is not shipped.
  if (notice.nativeVersions) {
    const sorted = (value) =>
      JSON.stringify(
        Object.entries(value).sort(([a], [b]) => a.localeCompare(b, "en")),
      );
    for (const folder of installedRoots.get(key) ?? []) {
      if (
        sorted(await json(join(folder, "versions.json"))) !==
        sorted(notice.nativeVersions)
      )
        throw new Error(`Native notice inventory mismatch: ${key}`);
    }
  }
  const texts = notice.texts.map((file) => {
    if (
      typeof file.file !== "string" ||
      typeof file.text !== "string" ||
      typeof file.source !== "string" ||
      !/^https:\/\//.test(file.source) ||
      file.text.includes("\0") ||
      Buffer.byteLength(file.text) > MAX_FILE ||
      createHash("sha256").update(file.text).digest("hex") !== file.sha256
    )
      throw new Error(`Invalid supplementary text: ${key}`);
    total += Buffer.byteLength(file.text);
    if (total > MAX_TOTAL) throw new Error("Third-party notices exceed 32 MiB");
    return {
      file: file.file,
      text: `Source: ${file.source}\nSHA-256: ${file.sha256}${file.artifactSha256 ? `\nArchive SHA-256: ${file.artifactSha256}` : ""}\n\n${file.text}`,
    };
  });
  records.set(key, {
    name: notice.name,
    version: notice.version,
    license: existing?.license ?? notice.license,
    texts: [...(existing?.texts ?? []), ...texts],
  });
  missing.delete(key);
}
const notices = [...records.values()].sort(
  (a, b) =>
    a.name.localeCompare(b.name, "en") ||
    a.version.localeCompare(b.version, "en"),
);
const ownLicense = await textFile(join(root, "LICENSE"), root);
const output = {
  application: {
    name: "PoliTost Pyxis",
    version: app.version,
    license: app.license,
    text: ownLicense,
  },
  notices,
};
const generated = join(root, "src/renderer/src/generated");
await mkdir(generated, { recursive: true });
await mkdir(join(root, "docs"), { recursive: true });
await writeFile(
  join(generated, "build-info.json"),
  JSON.stringify(output.application, null, 2) + "\n",
);
await writeFile(
  join(generated, "third-party-notices.json"),
  JSON.stringify(notices, null, 2) + "\n",
);
await writeFile(
  join(root, "docs/THIRD-PARTY-NOTICES.txt"),
  [
    `${output.application.name} ${app.version}`,
    ownLicense,
    "Installed production packages, bundled fonts and separately downloaded runtime/model notices. Generated by scripts/gen-notices.mjs.",
    ...notices.flatMap((notice) => [
      "=".repeat(72),
      `${notice.name} ${notice.version}\nLicense metadata: ${notice.license}`,
      ...(notice.texts.length
        ? notice.texts.map((file) => `--- ${file.file} ---\n${file.text}`)
        : [
            "No license or notice text was included in this installed package.",
          ]),
    ]),
  ].join("\n\n") + "\n",
);
console.log(
  `Generated notices for ${notices.length} packages/fonts; ${missing.size} packages have metadata only.`,
);
if (missing.size)
  console.log(`Metadata-only packages: ${[...missing].sort().join(", ")}`);
