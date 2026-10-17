import { createRequire } from "node:module";

// Usage: node scripts/packaged-fuses.mjs <packaged executable> [--allow-inspect]
// Fails unless the packaged app has the fuses build/after-pack.cjs sets. With --allow-inspect it then turns the
// --inspect fuse back on in that copy, because Playwright attaches to the main process through --inspect. CI does
// this only after the installers are built, so they keep the fuse off.
const require = createRequire(import.meta.url);
const { FUSES } = require("../build/after-pack.cjs");
const { FuseV1Options, flipFuses, getCurrentFuseWire } =
  require("@electron/fuses");

const [app, flag] = process.argv.slice(2);
if (!app || (flag && flag !== "--allow-inspect"))
  throw new Error(
    "Usage: node scripts/packaged-fuses.mjs <packaged executable> [--allow-inspect]",
  );
const wire = await getCurrentFuseWire(app);
for (const [option, enabled] of Object.entries(FUSES)) {
  if (option === "version") continue;
  // The wire stores each fuse as the character "0" (off) or "1" (on).
  const actual = String.fromCharCode(wire[option]);
  const expected = enabled ? "1" : "0";
  if (actual !== expected)
    throw new Error(
      `${FuseV1Options[option]} is "${actual}", expected "${expected}", in ${app}`,
    );
  console.log(`${FuseV1Options[option]}: ${enabled ? "on" : "off"}`);
}
if (flag)
  await flipFuses(app, {
    version: FUSES.version,
    [FuseV1Options.EnableNodeCliInspectArguments]: true,
    // Flipping a fuse changes the binary, so macOS needs a fresh ad-hoc signature to launch it.
    resetAdHocDarwinSignature: process.platform === "darwin",
  });
