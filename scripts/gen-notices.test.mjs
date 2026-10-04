import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
const run = promisify(execFile);
const script = join(dirname(fileURLToPath(import.meta.url)), "gen-notices.mjs");
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pyxis-notices-"));
  const fontDir = join(root, "src/renderer/src/design-system/fonts");
  await mkdir(fontDir, { recursive: true });
  await writeFile(join(fontDir, "Figtree-OFL.txt"), "Figtree OFL");
  await writeFile(join(fontDir, "JetBrainsMono-OFL.txt"), "JetBrains OFL");
  await writeFile(join(root, "LICENSE"), "Pyxis MIT");
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      version: "1.2.3",
      license: "MIT",
      dependencies: { first: "1.0.0" },
    }),
  );
  return root;
}
async function pkg(root, name, metadata, text = "MIT license text") {
  const folder = join(root, "node_modules", name);
  await mkdir(folder, { recursive: true });
  await writeFile(
    join(folder, "package.json"),
    JSON.stringify({ name, version: "1.0.0", license: "MIT", ...metadata }),
  );
  await writeFile(join(folder, "LICENSE"), text);
  return folder;
}
test("notices follow the installed production, optional and peer closure, retaining duplicate versions", async () => {
  const root = await fixture();
  try {
    const first = await pkg(root, "first", {
      dependencies: { shared: "1.0.0" },
      optionalDependencies: { missing: "1.0.0", opt: "1.0.0" },
      peerDependencies: { peer: "1.0.0" },
    });
    await mkdir(join(first, "lib-vendor/d3-array"), { recursive: true });
    await writeFile(
      join(first, "lib-vendor/d3-array/LICENSE"),
      "D3 ISC copyright",
    );
    await writeFile(
      join(first, "lib-vendor/d3-array/code.js"),
      Buffer.from([0, 1]),
    );
    await pkg(root, "shared", {});
    await pkg(first, "shared", { version: "2.0.0" });
    await pkg(root, "opt", { dependencies: { shared: "1.0.0" } });
    await pkg(root, "peer", {});
    await pkg(root, "unrelated-dev", {});
    await run(process.execPath, [script, root]);
    const file = join(
      root,
      "src/renderer/src/generated/third-party-notices.json",
    );
    const bytes = await readFile(file, "utf8");
    const data = JSON.parse(bytes);
    assert.deepEqual(
      data.filter((p) => p.name === "shared").map((p) => p.version),
      ["1.0.0", "2.0.0"],
    );
    assert.equal(
      data.some((p) => p.name === "unrelated-dev"),
      false,
    );
    assert.equal(data.filter((p) => p.license === "OFL-1.1").length, 2);
    assert.equal(
      data
        .find((p) => p.name === "first")
        .texts.find((p) => p.file === "LICENSE").text,
      "MIT license text",
    );
    assert.equal(
      data
        .find((p) => p.name === "first")
        .texts.find((p) => p.file === "lib-vendor/d3-array/LICENSE").text,
      "D3 ISC copyright",
    );
    await run(process.execPath, [script, root]);
    assert.equal(await readFile(file, "utf8"), bytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("notice generation refuses binary license files", async () => {
  const root = await fixture();
  try {
    await pkg(root, "first", {}, Buffer.from([0, 1, 2]));
    await assert.rejects(
      run(process.execPath, [script, root]),
      /Binary notice refused/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("explicit bundled notice files cannot resolve outside the project", async () => {
  const root = await fixture();
  try {
    await pkg(root, "first", {});
    const outside = join(root, "private");
    await writeFile(outside, "not a license");
    const font = join(
      root,
      "src/renderer/src/design-system/fonts/Figtree-OFL.txt",
    );
    await rm(font);
    await symlink(outside, font);
    await assert.rejects(
      run(process.execPath, [script, root]),
      /Notice escapes package/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("supplementary texts are hash checked and apply only to an installed version or declared runtime", async () => {
  const root = await fixture();
  try {
    const folder = await pkg(root, "first", {});
    await rm(join(folder, "LICENSE"));
    const text = "Copyright upstream. MIT license.";
    const entry = {
      file: "LICENSE",
      source: "https://example.org/pinned/LICENSE",
      text,
      sha256: createHash("sha256").update(text).digest("hex"),
    };
    const resource = join(root, "resources/third-party-notices.json");
    await mkdir(dirname(resource), { recursive: true });
    await writeFile(
      resource,
      JSON.stringify([
        { name: "first", version: "1.0.0", license: "MIT", texts: [entry] },
        { name: "first", version: "2.0.0", license: "MIT", texts: [entry] },
        {
          name: "Python",
          version: "3.14.2",
          license: "Python-2.0",
          runtime: true,
          texts: [entry],
        },
      ]),
    );
    await run(process.execPath, [script, root]);
    const notices = JSON.parse(
      await readFile(
        join(root, "src/renderer/src/generated/third-party-notices.json"),
      ),
    );
    assert.equal(notices.filter((p) => p.name === "first").length, 1);
    assert.match(
      notices.find((p) => p.name === "first").texts[0].text,
      /Copyright upstream/,
    );
    assert.equal(
      notices.some((p) => p.name === "Python"),
      true,
    );
    await writeFile(
      resource,
      JSON.stringify([
        {
          name: "first",
          version: "1.0.0",
          license: "MIT",
          texts: [{ ...entry, text: "changed" }],
        },
      ]),
    );
    await assert.rejects(
      run(process.execPath, [script, root]),
      /Invalid supplementary text/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a native notice inventory refuses changed installed component versions", async () => {
  const root = await fixture();
  try {
    const folder = await pkg(root, "first", {});
    await writeFile(
      join(folder, "versions.json"),
      JSON.stringify({ vips: "8.17.3" }),
    );
    const text = "Native copyright and license";
    const resource = join(root, "resources/third-party-notices.json");
    await mkdir(dirname(resource), { recursive: true });
    await writeFile(
      resource,
      JSON.stringify([
        {
          name: "first",
          version: "1.0.0",
          license: "MIT",
          nativeVersions: { vips: "8.17.3" },
          texts: [
            {
              file: "LICENSE",
              source: "https://example.org/pinned/LICENSE",
              text,
              sha256: createHash("sha256").update(text).digest("hex"),
            },
          ],
        },
      ]),
    );
    await run(process.execPath, [script, root]);
    await writeFile(
      join(folder, "versions.json"),
      JSON.stringify({ vips: "8.18.0" }),
    );
    await assert.rejects(
      run(process.execPath, [script, root]),
      /Native notice inventory mismatch/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
