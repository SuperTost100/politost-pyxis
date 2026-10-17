import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const { dropSwiftShader, pruneUnpacked } = require("../build/after-pack.cjs");

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
    ["libonnxruntime.so.1", "onnxruntime_binding.node"],
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
    [
      "onnxruntime-node/bin/napi-v3/linux/x64/libonnxruntime.so.1",
      /libonnxruntime.so.1 missing/,
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

test("the Mac bundle drops SwiftShader and keeps the other Electron libraries", async () => {
  const app = await mkdtemp(join(tmpdir(), "pyxis-swiftshader-"));
  try {
    const libraries = join(
      app,
      "Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries",
    );
    await mkdir(libraries, { recursive: true });
    for (const name of [
      "libEGL.dylib",
      "libGLESv2.dylib",
      "libffmpeg.dylib",
      "libvk_swiftshader.dylib",
      "vk_swiftshader_icd.json",
    ])
      await writeFile(join(libraries, name), "x");
    dropSwiftShader(app);
    assert.deepEqual((await readdir(libraries)).sort(), [
      "libEGL.dylib",
      "libGLESv2.dylib",
      "libffmpeg.dylib",
    ]);
    // Run again, the files are gone: a bundle without them fails the build instead of passing silently.
    assert.throws(() => dropSwiftShader(app), /SwiftShader file missing/);
  } finally {
    await rm(app, { recursive: true, force: true });
  }
});

// The node_modules exclusions in electron-builder.yml, read and applied by electron-builder's own matcher.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const builderRequire = createRequire(require.resolve("electron-builder"));
const { getNodeModuleFileMatcher } = builderRequire(
  "app-builder-lib/out/fileMatcher",
);
const config = builderRequire("js-yaml").load(
  readFileSync(join(root, "electron-builder.yml"), "utf8"),
);
const shippedFilter = getNodeModuleFileMatcher(
  root,
  join(root, "app"),
  (pattern) => pattern,
  {},
  { config, debugLogger: { isEnabled: false } },
).createFilter();

/** Whether a path under node_modules ships: the file and every folder above it inside its package pass the filter. */
function ships(path) {
  const parts = path.split("/");
  const packageDepth = parts[1].startsWith("@") ? 3 : 2;
  for (let end = packageDepth + 1; end <= parts.length; end += 1) {
    const partial = parts.slice(0, end).join("/");
    const stat = {
      isDirectory: () => end < parts.length,
      moduleFullFilePath: partial,
    };
    if (!shippedFilter(join(root, partial), stat)) return false;
  }
  return true;
}

const tesseractCores = ["", "-simd", "-relaxedsimd"].flatMap((variant) => [
  `tesseract-core${variant}.js`,
  `tesseract-core${variant}.wasm`,
]);
const shipped = [
  // tesseract.js picks one of these by the CPU's SIMD support.
  ...tesseractCores.map((file) => `node_modules/tesseract.js-core/${file}`),
  "node_modules/tesseract.js-core/index.js",
  "node_modules/tesseract.js-core/package.json",
  "node_modules/tesseract.js-core/LICENSE",
  "node_modules/tesseract.js/src/worker-script/node/gunzip.js",
  // Main reads PDF text through the modern build, which loads its worker in the same thread.
  "node_modules/pdfjs-dist/build/pdf.mjs",
  "node_modules/pdfjs-dist/build/pdf.worker.mjs",
  "node_modules/pdfjs-dist/package.json",
  "node_modules/pdfjs-dist/LICENSE",
  // The embed worker is ESM, so Node resolves transformers' "node" + "import" export.
  "node_modules/@huggingface/transformers/dist/transformers.node.mjs",
  "node_modules/@huggingface/transformers/package.json",
  "node_modules/@huggingface/transformers/LICENSE",
  "node_modules/onnxruntime-node/dist/index.js",
  "node_modules/onnxruntime-common/dist/cjs/index.js",
  "node_modules/@mixmark-io/domino/lib/index.js",
  "node_modules/@mixmark-io/domino/LICENSE",
  "node_modules/css-what/dist/index.js",
  "node_modules/css-what/LICENSE",
];
const dropped = [
  // Browser builds with the wasm inlined as base64.
  ...[
    "",
    "-simd",
    "-relaxedsimd",
    "-lstm",
    "-simd-lstm",
    "-relaxedsimd-lstm",
  ].map(
    (variant) =>
      `node_modules/tesseract.js-core/tesseract-core${variant}.wasm.js`,
  ),
  // tesseract.js 7.0.0 never loads the LSTM-only cores; the next test checks that against the installed version.
  ...["", "-simd", "-relaxedsimd"].flatMap((variant) => [
    `node_modules/tesseract.js-core/tesseract-core${variant}-lstm.js`,
    `node_modules/tesseract.js-core/tesseract-core${variant}-lstm.wasm`,
  ]),
  // Only tesseract.js' browser gunzip imports zlibjs.
  "node_modules/zlibjs/bin/node-zlib.js",
  "node_modules/zlibjs/LICENSE",
  // main passes neither cMapUrl nor standardFontDataUrl.
  "node_modules/pdfjs-dist/cmaps/Adobe-Japan1-UCS2.bcmap",
  "node_modules/pdfjs-dist/standard_fonts/FoxitSans.pfb",
  "node_modules/pdfjs-dist/image_decoders/pdf.image_decoders.mjs",
  "node_modules/pdfjs-dist/web/pdf_viewer.mjs",
  "node_modules/pdfjs-dist/build/pdf.min.mjs",
  "node_modules/pdfjs-dist/build/pdf.worker.min.mjs",
  "node_modules/pdfjs-dist/build/pdf.sandbox.mjs",
  "node_modules/pdfjs-dist/build/pdf.sandbox.min.mjs",
  "node_modules/@huggingface/transformers/dist/transformers.node.cjs",
  "node_modules/@huggingface/transformers/dist/transformers.web.js",
  "node_modules/@huggingface/transformers/src/transformers.js",
  // onnxruntime-web and the packages only it depends on.
  "node_modules/onnxruntime-web/dist/ort.node.min.js",
  "node_modules/protobufjs/index.js",
  "node_modules/flatbuffers/js/flatbuffers.js",
  "node_modules/guid-typescript/dist/guid.js",
  "node_modules/long/index.js",
  "node_modules/platform/platform.js",
  // Build leftovers.
  "node_modules/@mixmark-io/domino/.yarn/releases/yarn-1.22.19.cjs",
  "node_modules/css-what/src/parse.ts",
];

test("electron-builder.yml ships the files the app loads", () => {
  assert.deepEqual(
    shipped.filter((path) => !ships(path)),
    [],
  );
});

test("electron-builder.yml leaves out the files the app never loads", () => {
  assert.deepEqual(
    dropped.filter((path) => ships(path)),
    [],
  );
});

// tesseract.js 7.0.0 hands its Node worker a boolean `lstmOnly`, and getCore compares it with OEM numbers, so the
// worker loads the full core even in LSTM-only mode. That is why the -lstm files can be left out, and why
// package.json pins tesseract.js exactly. This runs a real worker the way recognize.ts does and fails if the
// installed version requires a tesseract.js-core file that does not ship.
const tessdata =
  process.env.PYXIS_TEST_TESSDATA ?? join(root, ".tmp/tessdata-fast");
test(
  "tesseract.js loads only tesseract.js-core files that ship",
  {
    skip:
      !existsSync(join(tessdata, "eng.traineddata")) &&
      "the pinned tessdata (.tmp/tessdata-fast) is not on this machine; npm run test:fixtures downloads it",
  },
  async () => {
    const pin = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
      .dependencies["tesseract.js"];
    assert.equal(pin, require("tesseract.js/package.json").version);
    const folder = await mkdtemp(join(tmpdir(), "pyxis-tesseract-core-"));
    try {
      const log = join(folder, "requests.txt");
      const workerPath = join(folder, "worker.cjs");
      // The worker thread records every tesseract.js-core module it resolves, then runs tesseract.js' own worker script.
      await writeFile(
        workerPath,
        `const { registerHooks } = require("node:module");
const { appendFileSync } = require("node:fs");
registerHooks({
  resolve(specifier, context, next) {
    const result = next(specifier, context);
    if (specifier.startsWith("tesseract.js-core")) appendFileSync(${JSON.stringify(log)}, result.url + "\\n");
    return result;
  },
});
require(${JSON.stringify(require.resolve("tesseract.js/src/worker-script/node/index.js"))});
`,
      );
      const { createWorker } = require("tesseract.js");
      const worker = await createWorker("eng", 1, {
        workerPath,
        langPath: tessdata,
        cacheMethod: "none",
        gzip: false,
      });
      await worker.terminate();
      const loaded = readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((url) => relative(root, fileURLToPath(url)).replaceAll("\\", "/"));
      assert.ok(loaded.length > 0, "no tesseract.js-core module was loaded");
      for (const file of loaded) {
        assert.ok(ships(file), `${file} is loaded but does not ship`);
        const wasm = file.replace(/\.js$/, ".wasm");
        if (existsSync(join(root, wasm)))
          assert.ok(ships(wasm), `${wasm} is loaded but does not ship`);
      }
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  },
);
