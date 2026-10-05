// Names the module that faulted in a Crashpad minidump, without a debugger and without printing any memory or registers.
//
//   node scripts/minidump-fault.mjs <dir-or-.dmp> [...]      (a folder is searched for *.dmp, recursively)
//
// Prints, per dump: the exception code, the access type and target address of an access violation, the faulting thread,
// the faulting address as `module+offset` (or "outside every module", which is JIT or WebAssembly code, or a heap address),
// and up to 24 module+offset values found on the faulting thread's stack. The stack list is a scan for values that point
// into a module, not an unwound stack: it can hold stale entries, so read it as "which modules were nearby".
// Nothing else from the dump is printed, and the dump is never uploaded or copied.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

const find = (path) =>
  statSync(path).isDirectory()
    ? readdirSync(path).flatMap((name) => find(join(path, name)))
    : path.endsWith(".dmp") ? [path] : [];

const hex = (value) => `0x${value.toString(16)}`;

function analyse(file) {
  if (statSync(file).size > 64 * 1024 * 1024) return `${basename(file)}: dump exceeds diagnostic size cap`;
  const buf = readFileSync(file);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (buf.length < 32 || view.getUint32(0, true) !== 0x504d444d) return `${basename(file)}: not a minidump`;
  const streams = new Map();
  for (let i = 0, at = view.getUint32(12, true); i < view.getUint32(8, true); i += 1, at += 12)
    streams.set(view.getUint32(at, true), { size: view.getUint32(at + 4, true), rva: view.getUint32(at + 8, true) });

  const modules = [];
  const list = streams.get(4);
  if (list) {
    for (let i = 0, at = list.rva + 4; i < view.getUint32(list.rva, true); i += 1, at += 108) {
      const nameAt = view.getUint32(at + 20, true);
      const chars = view.getUint32(nameAt, true) / 2;
      let name = "";
      for (let c = 0; c < chars; c += 1) name += String.fromCharCode(view.getUint16(nameAt + 4 + c * 2, true));
      modules.push({ base: view.getBigUint64(at, true), size: BigInt(view.getUint32(at + 8, true)), name: basename(name.replaceAll("\\", "/")) });
    }
  }
  const where = (address) => {
    const module = modules.find((m) => address >= m.base && address < m.base + m.size);
    return module ? `${module.name}+${hex(address - module.base)}` : `${hex(address)} (outside every module)`;
  };

  const out = [`${basename(file)}: ${modules.length} modules`];
  const exception = streams.get(6);
  if (!exception) return [...out, "  no exception stream"].join("\n");
  const at = exception.rva;
  const threadId = view.getUint32(at, true);
  const code = view.getUint32(at + 8, true);
  const address = view.getBigUint64(at + 24, true);
  const parameters = view.getUint32(at + 32, true);
  out.push(`  exception ${hex(code)} on thread ${threadId}`, `  at ${where(address)}`);
  if (code === 0xc0000005 && parameters >= 2) {
    const kind = ["read", "write", "", "", "", "", "", "", "execute"][Number(view.getBigUint64(at + 40, true))] ?? "access";
    out.push(`  access violation: ${kind} of ${hex(view.getBigUint64(at + 48, true))}`);
  }

  const threads = streams.get(3);
  if (threads) {
    for (let i = 0, t = threads.rva + 4; i < view.getUint32(threads.rva, true); i += 1, t += 48) {
      if (view.getUint32(t, true) !== threadId) continue;
      const start = view.getBigUint64(t + 24, true);
      const size = view.getUint32(t + 32, true);
      const rva = view.getUint32(t + 36, true);
      const seen = new Set();
      for (let o = 0; o + 8 <= size && seen.size < 24; o += 8) {
        const value = view.getBigUint64(rva + o, true);
        const module = modules.find((m) => value >= m.base && value < m.base + m.size);
        if (module) seen.add(`${module.name}+${hex(value - module.base)}`);
      }
      out.push(`  stack scan (nearest first, ${hex(start)}..): ${[...seen].join(", ") || "none"}`);
    }
  }
  out.push(`  ${streams.has(24) ? "thread names present" : "no thread names"}; threads: ${threads ? view.getUint32(threads.rva, true) : 0}`);
  return out.join("\n");
}

const files = process.argv.slice(2).filter(existsSync).flatMap(find);
if (!files.length) console.log("no .dmp files found");
for (const file of files) {
  try { console.log(analyse(file)); }
  catch { console.log(`${basename(file)}: malformed minidump`); process.exitCode = 1; }
}
