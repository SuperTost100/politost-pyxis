import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { pruneUnpacked } = createRequire(import.meta.url)(
  "../build/after-pack.cjs",
);

// What the unpacked node_modules hold before pruning: every platform's binaries.
const onnxFiles = {
  "darwin/arm64": ["libonnxruntime.1.21.0.dylib", "onnxruntime_binding.node"],
  "darwin/x64": ["libonnxruntime.1.21.0.dylib", "onnxruntime_binding.node"],
  "linux/arm64": [
    "libonnxruntime.so.1",
    "libonnxruntime.so.1.21.0",
    "onnxruntime_binding.node",
  ],
  "linux/x64": [
    "libonnxruntime.so.1",
    "libonnxruntime.so.1.21.0",
    "libonnxruntime_providers_cuda.so",
    "libonnxruntime_providers_shared.so",
    "libonnxruntime_providers_tensorrt.so",
    "onnxruntime_binding.node",
  ],
  "win32/arm64": [
    "DirectML.dll",
    "onnxruntime.dll",
    "onnxruntime_binding.node",
  ],
  "win32/x64": ["DirectML.dll", "onnxruntime.dll", "onnxruntime_binding.node"],
};
const prebuilds = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "linuxmusl-arm64",
  "linuxmusl-x64",
  "win32-arm64",
  "win32-x64",
].map((name) => `${name}.node`);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pyxis-after-pack-"));
  for (const [target, files] of Object.entries(onnxFiles)) {
    const folder = join(root, "onnxruntime-node/bin/napi-v3", target);
    await mkdir(folder, { recursive: true });
    for (const file of files) await writeFile(join(folder, file), "x");
  }
  await mkdir(join(root, "better-sqlite3/prebuilds"), { recursive: true });
  for (const file of prebuilds)
    await writeFile(join(root, "better-sqlite3/prebuilds", file), "x");
  await mkdir(join(root, "better-sqlite3/lib"), { recursive: true });
  await writeFile(join(root, "better-sqlite3/lib/index.js"), "x");
  return root;
}

const expected = {
  "darwin arm64": [
    "darwin",
    "arm64",
    ["libonnxruntime.1.21.0.dylib", "onnxruntime_binding.node"],
  ],
  "darwin x64": [
    "darwin",
    "x64",
    ["libonnxruntime.1.21.0.dylib", "onnxruntime_binding.node"],
  ],
  "linux x64": [
    "linux",
    "x64",
    [
      "libonnxruntime.so.1",
      "libonnxruntime.so.1.21.0",
      "onnxruntime_binding.node",
    ],
  ],
  "win32 x64": [
    "win32",
    "x64",
    ["onnxruntime.dll", "onnxruntime_binding.node"],
  ],
};
for (const [label, [platform, arch, kept]] of Object.entries(expected)) {
  test(`pruning for ${label} keeps one onnxruntime-node build without GPU providers, and one sqlite prebuild`, async () => {
    const root = await fixture();
    try {
      pruneUnpacked(root, platform, arch);
      const bin = join(root, "onnxruntime-node/bin/napi-v3");
      assert.deepEqual(await readdir(bin), [platform]);
      assert.deepEqual(await readdir(join(bin, platform)), [arch]);
      assert.deepEqual((await readdir(join(bin, platform, arch))).sort(), kept);
      assert.deepEqual(await readdir(join(root, "better-sqlite3/prebuilds")), [
        `${platform}-${arch}.node`,
      ]);
      assert.deepEqual(await readdir(join(root, "better-sqlite3/lib")), [
        "index.js",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("pruning fails the build when the target's binaries are not there", async () => {
  const missing = [
    [
      "better-sqlite3/prebuilds/linux-x64.node",
      /better-sqlite3 prebuild missing/,
    ],
    [
      "onnxruntime-node/bin/napi-v3/linux/x64/onnxruntime_binding.node",
      /onnxruntime binding missing/,
    ],
  ];
  for (const [file, message] of missing) {
    const root = await fixture();
    try {
      await rm(join(root, file));
      assert.throws(() => pruneUnpacked(root, "linux", "x64"), message);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});
