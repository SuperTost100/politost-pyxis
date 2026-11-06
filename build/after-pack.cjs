const { execFileSync } = require("node:child_process");
const { closeSync, existsSync, lstatSync, mkdtempSync, openSync, readSync, readdirSync, rmSync } = require("node:fs");
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
//     On Linux the binding needs libonnxruntime.so.1 (its SONAME, found through RUNPATH $ORIGIN). The versioned
//     libonnxruntime.so.1.x.y next to it is the CUDA build that the package's install script downloads, and nothing
//     loads it.
//   better-sqlite3: prebuilds/<platform>-<arch>.node only.
function pruneUnpacked(unpackedModules, platform, arch) {
  const onnx = join(unpackedModules, "onnxruntime-node/bin/napi-v3");
  keepOnly(onnx, platform);
  keepOnly(join(onnx, platform), arch);
  const target = join(onnx, platform, arch);
  for (const name of readdirSync(target)) {
    if (
      /providers_(?:cuda|tensorrt|shared)|^DirectML\.|^libonnxruntime\.so\.\d+\.\d+\.\d+$/i.test(
        name,
      )
    )
      rmSync(join(target, name), { force: true });
  }
  if (!existsSync(join(target, "onnxruntime_binding.node")))
    throw new Error(`onnxruntime binding missing for ${platform}-${arch}`);
  if (platform === "linux" && !existsSync(join(target, "libonnxruntime.so.1")))
    throw new Error(`libonnxruntime.so.1 missing for ${platform}-${arch}`);

  const sqlite = join(unpackedModules, "better-sqlite3");
  const prebuild = `${platform}-${arch}.node`;
  keepOnly(join(sqlite, "prebuilds"), prebuild);
  if (!existsSync(join(sqlite, "prebuilds", prebuild)))
    throw new Error(`better-sqlite3 prebuild missing for ${platform}-${arch}`);
}

// SwiftShader is Chromium's software fallback for WebGL. Pyxis draws no WebGL and every Mac has Metal, so the Mac
// bundle leaves out the library and the ICD file that points to it. Linux and Windows keep it for VMs and CI. A missing
// file means Electron moved it, and the build fails so the rule gets updated.
function dropSwiftShader(app) {
  const libraries = join(
    app,
    "Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries",
  );
  for (const name of ["libvk_swiftshader.dylib", "vk_swiftshader_icd.json"]) {
    const file = join(libraries, name);
    if (!existsSync(file)) throw new Error(`SwiftShader file missing: ${file}`);
    rmSync(file);
  }
}

// Finder metadata on macOS can make codesign reject the packaged bundle.
// Sign a private metadata-free copy, including the app's declared entitlements.
// A build started by hand in CI sets PYXIS_MAC_IDENTITY to the Developer ID in a keychain the workflow made, and the
// App Store Connect key in APPLE_API_KEY (a .p8 file), APPLE_API_KEY_ID and APPLE_API_ISSUER. The app is then signed
// with that identity under the hardened runtime, notarized and stapled, so it opens on the first double-click. Without
// them, as on pull requests and on devbox, it is signed ad hoc as before.
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
  dropSwiftShader(app);
  const temporary = mkdtempSync(join(tmpdir(), "pyxis-sign-"));
  const clean = join(temporary, name);
  try {
    execFileSync("ditto", ["--norsrc", app, clean]);
    const identity = process.env.PYXIS_MAC_IDENTITY;
    const entitlements = join(context.packager.projectDir, "build/entitlements.mac.plist");
    if (identity) {
      // Notarization needs every binary signed with the Developer ID, a secure timestamp and the hardened runtime.
      // codesign --deep misses binaries outside the usual places, such as a framework's Libraries folder or Squirrel's
      // ShipIt, so each one is signed, deepest first, then the app.
      for (const target of [...signOrder(clean), clean])
        execFileSync(
          "codesign",
          ["--sign", identity, "--force", "--timestamp", "--options", "runtime", "--entitlements", entitlements, target],
          { stdio: "inherit" },
        );
    } else
      execFileSync(
        "codesign",
        ["--sign", "-", "--force", "--deep", "--timestamp=none", "--entitlements", entitlements, clean],
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
    if (identity) notarize(app, temporary);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
};

const MACH_O = new Set(["feedface", "feedfacf", "cefaedfe", "cffaedfe", "cafebabe", "bebafeca"]);

/** Whether a file is a Mach-O binary or a universal one, by its first four bytes. */
function isMachO(file) {
  const fd = openSync(file, "r");
  try {
    const head = Buffer.alloc(4);
    return readSync(fd, head, 0, 4, 0) === 4 && MACH_O.has(head.toString("hex"));
  } finally {
    closeSync(fd);
  }
}

/**
 * Everything inside `app` that needs its own signature, in the order to sign it: Mach-O files, then the frameworks and
 * helper apps that hold them, deepest first, so each bundle is signed after its contents. Symbolic links are skipped:
 * a framework's links point at files already listed under Versions.
 */
function signOrder(app) {
  const found = [];
  const walk = (directory, depth) => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      const entry = lstatSync(path);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        walk(path, depth + 1);
        if (/\.(framework|app)$/.test(name)) found.push({ path, depth: depth + 1 });
      } else if (entry.isFile() && isMachO(path)) found.push({ path, depth: depth + 1 });
    }
  };
  walk(app, 0);
  return found.sort((a, b) => b.depth - a.depth).map((target) => target.path);
}

/**
 * Sends the signed app to Apple's notary service and staples the ticket to it, before electron-builder puts it in the
 * disk image. notarytool waits for the verdict; anything but Accepted stops the build, with Apple's log.
 */
function notarize(app, temporary) {
  const { APPLE_API_KEY: key, APPLE_API_KEY_ID: keyId, APPLE_API_ISSUER: issuer } = process.env;
  if (!key || !keyId || !issuer) throw new Error("Notarization needs APPLE_API_KEY, APPLE_API_KEY_ID and APPLE_API_ISSUER");
  const zip = join(temporary, "notarize.zip");
  execFileSync("ditto", ["-c", "-k", "--keepParent", app, zip]);
  const auth = ["--key", key, "--key-id", keyId, "--issuer", issuer];
  const result = JSON.parse(
    execFileSync("xcrun", ["notarytool", "submit", zip, ...auth, "--wait", "--output-format", "json"], {
      encoding: "utf8",
    }),
  );
  if (result.status !== "Accepted") {
    if (result.id) execFileSync("xcrun", ["notarytool", "log", result.id, ...auth], { stdio: "inherit" });
    throw new Error(`Notarization ended as ${result.status}`);
  }
  execFileSync("xcrun", ["stapler", "staple", app], { stdio: "inherit" });
}

module.exports.pruneUnpacked = pruneUnpacked;
module.exports.FUSES = FUSES;
module.exports.dropSwiftShader = dropSwiftShader;
module.exports.signOrder = signOrder;
