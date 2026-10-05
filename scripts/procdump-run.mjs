// Runs an Electron repro with Sysinternals ProcDump attached to the utility process only (Windows, diagnostic).
//
//   node scripts/procdump-run.mjs <procdump64.exe> <dump-dir> <electron args...>
//   node scripts/procdump-run.mjs .tmp/procdump/procdump64.exe .tmp/ci-crashes/procdump scripts/repro-core-sequence.mjs --runs=10
//
// The repro (repro-core-sequence.mjs) writes the utility's pid on `spawn` and holds the utility until this script writes
// <dump-dir>/handshake.go after ProcDump reports that it is monitoring. An unconfirmed attach fails the diagnostic.
// ProcDump runs as `-accepteula -e -n 1 <pid> <dump-dir>`: a mini dump at the first UNHANDLED (second-chance) exception, and
// nothing for first-chance exceptions that V8 or Chromium handle themselves (documented: learn.microsoft.com/sysinternals/downloads/procdump).
// A debugger attached to a process makes Windows hand it the second-chance exception before any unhandled-exception filter
// (Crashpad's) runs, so a dump here does not depend on Crashpad or WER. If the utility still exits 0xC0000005 and no dump
// appears after a confirmed attach, inspect debugger output before inferring an explicit exit.
// The dump stays in <dump-dir>; read it with scripts/minidump-fault.mjs and never upload it. The utility's progress log is
// <dump-dir>/utility.log; its last lines are printed at the end.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

const [procdump, dumpDir, ...electronArgs] = process.argv.slice(2);
if (!procdump || !dumpDir || !electronArgs.length) throw new Error("usage: procdump-run.mjs <procdump64.exe> <dump-dir> <electron args...>");
const dir = resolve(dumpDir);
const handshake = join(dir, "handshake");
const utilityLog = join(dir, "utility.log");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const note = (line) => console.log(`procdump-run: ${line}`);
mkdirSync(dir, { recursive: true });
for (const file of [`${handshake}.pid`, `${handshake}.go`, utilityLog]) rmSync(file, { force: true });

const electron = spawn(createRequire(import.meta.url)("electron"), electronArgs, {
  stdio: "inherit",
  env: { ...process.env, PYXIS_REPRO_HANDSHAKE: handshake, PYXIS_REPRO_LOG: utilityLog },
});
const electronExit = new Promise((done) => electron.once("exit", (code) => done(code ?? 1)));

let pid;
for (let waited = 0; !pid && waited < 30000; waited += 50) {
  const text = existsSync(`${handshake}.pid`) ? readFileSync(`${handshake}.pid`, "utf8").trim() : "";
  if (/^\d+$/.test(text)) pid = text;
  else await sleep(50);
}
if (!pid) {
  note("no utility pid within 30 s");
  electron.kill();
  process.exit(1);
}

const monitor = spawn(resolve(procdump), ["-accepteula", "-e", "-n", "1", pid, dir], { stdio: ["ignore", "pipe", "pipe"] });
let released = false;
let attachConfirmed = false;
const release = (why) => {
  if (released) return;
  released = true;
  writeFileSync(`${handshake}.go`, "");
  note(`released utility ${pid}: ${why}`);
};
let output = "";
const watch = (stream) => stream.on("data", (chunk) => {
  // ProcDump writes UTF-16LE to redirected streams; its readiness banner is ASCII.
  const text = chunk.toString("latin1").replaceAll("\0", "");
  process.stdout.write(text);
  output = (output + text).slice(-4096);
  if (/Press Ctrl-C/i.test(output)) { attachConfirmed = true; release("ProcDump is monitoring"); }
});
watch(monitor.stdout);
watch(monitor.stderr);
const monitorExit = new Promise((done) => monitor.once("exit", (code) => {
  if (!attachConfirmed) electron.kill();
  done(code);
}));
const readyTimer = setTimeout(() => {
  if (attachConfirmed) return;
  note("ProcDump attach was not confirmed in 15 s; refusing to run the sequence");
  monitor.kill();
  electron.kill();
}, 15000);

const code = await electronExit;
clearTimeout(readyTimer);
note(`electron exited ${code} (0x${(code >>> 0).toString(16)})`);
const monitorCode = await Promise.race([monitorExit, sleep(120000).then(() => "timeout")]);
if (monitorCode === "timeout") monitor.kill();
note(`ProcDump finished: ${monitorCode}; dumps: ${readdirSync(dir).filter((name) => name.endsWith(".dmp")).join(", ") || "none"}`);
if (existsSync(utilityLog)) console.log(`procdump-run: last utility log lines\n${readFileSync(utilityLog, "utf8").trim().split("\n").slice(-12).join("\n")}`);
process.exit(attachConfirmed ? code : 1);
