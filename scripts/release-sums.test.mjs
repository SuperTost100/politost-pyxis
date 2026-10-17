import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assetName, mergeSums, requiredAssets } from "./release-sums.mjs";

const sha = (text) => createHash("sha256").update(text).digest("hex");

// What the four packaging jobs upload, with electron-builder's spaced names.
const targets = {
  "pyxis-mac-arm64": [
    "PoliTost Pyxis-1.2.3-arm64.dmg",
    "PoliTost Pyxis-1.2.3-arm64.dmg.blockmap",
    "PoliTost Pyxis-1.2.3-arm64-mac.zip",
  ],
  "pyxis-mac-x64": ["PoliTost Pyxis-1.2.3.dmg", "PoliTost Pyxis-1.2.3-mac.zip"],
  "pyxis-windows-x64": ["PoliTost Pyxis Setup 1.2.3.exe"],
  "pyxis-linux-x64": [
    "PoliTost Pyxis-1.2.3.AppImage",
    "politost-pyxis_1.2.3_amd64.deb",
  ],
};

async function artifacts(change = () => {}) {
  const root = await mkdtemp(join(tmpdir(), "pyxis-release-sums-"));
  const folders = [];
  for (const [target, names] of Object.entries(targets)) {
    const folder = join(root, target);
    await mkdir(folder);
    const files = Object.fromEntries(names.map((name) => [name, name]));
    const sums = names.map((name) => `${sha(name)}  ${name}`);
    change(target, files, sums);
    for (const [name, text] of Object.entries(files))
      await writeFile(join(folder, name), text);
    await writeFile(join(folder, "SHA256SUMS"), sums.join("\n") + "\n");
    folders.push(folder);
  }
  return { root, folders };
}

test("merges every target's checksums under GitHub's dotted asset names", async () => {
  const { root, folders } = await artifacts();
  try {
    const lines = (await mergeSums(folders, "1.2.3")).split("\n");
    assert.deepEqual(lines, [
      `${sha("PoliTost Pyxis-1.2.3-arm64-mac.zip")}  PoliTost.Pyxis-1.2.3-arm64-mac.zip`,
      `${sha("PoliTost Pyxis-1.2.3-arm64.dmg")}  PoliTost.Pyxis-1.2.3-arm64.dmg`,
      `${sha("PoliTost Pyxis-1.2.3-arm64.dmg.blockmap")}  PoliTost.Pyxis-1.2.3-arm64.dmg.blockmap`,
      `${sha("PoliTost Pyxis-1.2.3-mac.zip")}  PoliTost.Pyxis-1.2.3-mac.zip`,
      `${sha("PoliTost Pyxis-1.2.3.AppImage")}  PoliTost.Pyxis-1.2.3.AppImage`,
      `${sha("PoliTost Pyxis-1.2.3.dmg")}  PoliTost.Pyxis-1.2.3.dmg`,
      `${sha("PoliTost Pyxis Setup 1.2.3.exe")}  PoliTost.Pyxis.Setup.1.2.3.exe`,
      `${sha("politost-pyxis_1.2.3_amd64.deb")}  politost-pyxis_1.2.3_amd64.deb`,
      "",
    ]);
    for (const name of requiredAssets("1.2.3"))
      assert.ok(
        lines.some((line) => line.endsWith(`  ${name}`)),
        name,
      );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses sums that would make the in-app download fail or vouch for the wrong bytes", async () => {
  const cases = [
    // A file rewritten after its job wrote the sums, like a dmg converted without updating them.
    [
      (target, files) => {
        if (target === "pyxis-mac-arm64")
          files["PoliTost Pyxis-1.2.3-arm64.dmg"] = "converted";
      },
      /PoliTost Pyxis-1.2.3-arm64.dmg has SHA-256/,
    ],
    // A file uploaded without a line.
    [
      (target, files) => {
        if (target === "pyxis-linux-x64") files["extra.blockmap"] = "x";
      },
      /extra.blockmap has no checksum line/,
    ],
    // A target whose installer is missing altogether.
    [
      (target, files, sums) => {
        if (target !== "pyxis-windows-x64") return;
        delete files["PoliTost Pyxis Setup 1.2.3.exe"];
        sums.length = 0;
      },
      /no checksum for PoliTost.Pyxis.Setup.1.2.3.exe/,
    ],
    // Two targets uploading the same name.
    [
      (target, files, sums) => {
        if (target !== "pyxis-mac-x64") return;
        files["PoliTost Pyxis-1.2.3.AppImage"] =
          "PoliTost Pyxis-1.2.3.AppImage";
        sums.push(
          `${sha("PoliTost Pyxis-1.2.3.AppImage")}  PoliTost Pyxis-1.2.3.AppImage`,
        );
      },
      /PoliTost.Pyxis-1.2.3.AppImage is listed twice/,
    ],
    [
      (target, files, sums) => {
        if (target === "pyxis-linux-x64") sums.push("not a checksum");
      },
      /not a checksum line/,
    ],
  ];
  for (const [change, message] of cases) {
    const { root, folders } = await artifacts(change);
    try {
      await assert.rejects(mergeSums(folders, "1.2.3"), message);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("asset names keep only what GitHub keeps", () => {
  assert.equal(
    assetName("PoliTost Pyxis Setup 1.2.3.exe"),
    "PoliTost.Pyxis.Setup.1.2.3.exe",
  );
  for (const name of ["../SHA256SUMS", "Pyxis ü.dmg", ".hidden"])
    assert.throws(() => assetName(name), /unexpected characters/);
});
