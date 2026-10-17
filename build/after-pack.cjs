const { execFileSync } = require("node:child_process");
const { existsSync, mkdtempSync, readdirSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
// Comes with electron-builder.
const { FuseV1Options, FuseVersion } = require("@electron/fuses");

// Another process can't run the app's binary as Node, give it NODE_OPTIONS or --inspect, or make it load a modified
// app.asar (checked on macOS and Windows) or an app folder next to it. Nothing in the app runs itself as Node:
// core is a utilityProcess and the other workers are worker threads. These are flipped here, before the macOS signature below; electron-builder's electronFuses option flips them
// after this hook, which would break that signature.
const FUSES = {
  version: FuseVersion.V1,
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
};

// electron-builder's Arch enum: 1 is x64 and 3 is arm64. Other values (universal, ia32) are not built and keep every binary.
const ARCHES = { 1: "x64", 3: "arm64" };

function keepOnly(directory, keep) {
  for (const name of readdirSync(directory)) {
    if (name !== keep)
      rmSync(join(directory, name), { recursive: true, force: true });
  }
}

// Native packages ship binaries for every platform. Everything is unpacked from the asar, so what the target does not
// load can be deleted here, before the app is signed and compressed. A missing file the app needs fails the build.
//   onnxruntime-node: bin/napi-v3/<platform>/<arch> only, without the CUDA, TensorRT and DirectML providers. The
//     embedder asks for device "cpu"; on Windows onnxruntime.dll delay-loads DirectML.dll, so nothing resolves it.
//   better-sqlite3: prebuilds/<platform>-<arch>.node only.
function pruneUnpacked(unpackedModules, platform, arch) {
  const onnx = join(unpackedModules, "onnxruntime-node/bin/napi-v3");
  keepOnly(onnx, platform);
  keepOnly(join(onnx, platform), arch);
  const target = join(onnx, platform, arch);
  for (const name of readdirSync(target)) {
    if (/providers_(?:cuda|tensorrt|shared)|^DirectML\./i.test(name))
      rmSync(join(target, name), { force: true });
  }
  if (!existsSync(join(target, "onnxruntime_binding.node")))
    throw new Error(`onnxruntime binding missing for ${platform}-${arch}`);

  const sqlite = join(unpackedModules, "better-sqlite3");
  const prebuild = `${platform}-${arch}.node`;
  keepOnly(join(sqlite, "prebuilds"), prebuild);
  if (!existsSync(join(sqlite, "prebuilds", prebuild)))
    throw new Error(`better-sqlite3 prebuild missing for ${platform}-${arch}`);
}

// Finder metadata on macOS can make codesign reject the packaged bundle.
// Sign a private metadata-free copy, including the app's declared entitlements.
module.exports = async function afterPack(context) {
  const arch = ARCHES[context.arch];
  if (arch)
    pruneUnpacked(
      join(
        context.packager.getResourcesDir(context.appOutDir),
        "app.asar.unpacked/node_modules",
      ),
      context.electronPlatformName,
      arch,
    );
  await context.packager.addElectronFuses(context, FUSES);
  if (context.electronPlatformName !== "darwin") return;
  const name = `${context.packager.appInfo.productFilename}.app`;
  const app = join(context.appOutDir, name);
  const temporary = mkdtempSync(join(tmpdir(), "pyxis-sign-"));
  const clean = join(temporary, name);
  try {
    execFileSync("ditto", ["--norsrc", app, clean]);
    execFileSync(
      "codesign",
      [
        "--sign",
        "-",
        "--force",
        "--deep",
        "--timestamp=none",
        "--entitlements",
        join(context.packager.projectDir, "build/entitlements.mac.plist"),
        clean,
      ],
      { stdio: "inherit" },
    );
    execFileSync("codesign", ["--verify", "--deep", "--strict", clean], {
      stdio: "inherit",
    });
    rmSync(app, { recursive: true, force: true });
    execFileSync("ditto", ["--norsrc", clean, app]);
    execFileSync("xattr", ["-cr", app]);
    execFileSync("codesign", ["--verify", "--deep", "--strict", app], {
      stdio: "inherit",
    });
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
};

module.exports.pruneUnpacked = pruneUnpacked;
module.exports.FUSES = FUSES;
