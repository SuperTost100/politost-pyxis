const { execFileSync } = require("node:child_process");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

// Finder metadata on macOS can make codesign reject the packaged bundle.
// Sign a private metadata-free copy, including the app's declared entitlements.
module.exports = async function afterPack(context) {
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
