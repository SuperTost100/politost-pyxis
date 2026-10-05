// Names the module that faulted in a Crashpad minidump, without a debugger and without printing any memory or registers.
//
//   node scripts/minidump-fault.mjs <dir-or-.dmp> [...]      (a folder is searched for *.dmp, recursively)
//
// Prints, per dump: the exception code, the access type and target address of an access violation, the faulting thread,
// the faulting address as `module+offset` (or "outside every module", which is JIT or WebAssembly code, or a heap address),
// and up to 24 module+offset values found on the faulting thread's stack. The stack list is a scan for values that point
// into a module, not an unwound stack: it can hold stale entries, so read it as "which modules were nearby".
// Also prints thread names/start address, unloaded modules and fault-page flags when present. No memory is printed; dumps stay local.
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

  const stringAt = (rva) => {
    const bytes = view.getUint32(rva, true);
    if (bytes > 4096) throw new Error("oversized diagnostic name");
    let text = "";
    for (let at = rva + 4; at < rva + 4 + bytes; at += 2) text += String.fromCharCode(view.getUint16(at, true));
    return text.replace(/[\r\n\x00-\x1f]/g, "?");
  };
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

  const names = streams.get(24);
  if (names) {
    const named = [];
    for (let i = 0, t = names.rva + 4; i < view.getUint32(names.rva, true); i += 1, t += 12) {
      const id = view.getUint32(t, true);
      const name = stringAt(Number(view.getBigUint64(t + 4, true)));
      if (id === threadId) out.push(`  faulting thread name: ${name}`);
      named.push(name);
    }
    out.push(`  thread names: ${[...new Set(named)].slice(0, 32).join(", ")}`);
  }
  const threadInfo = streams.get(17);
  if (threadInfo) {
    const header = view.getUint32(threadInfo.rva, true);
    const entry = view.getUint32(threadInfo.rva + 4, true);
    if (header < 12 || entry < 64) throw new Error("invalid thread info");
    for (let i = 0, t = threadInfo.rva + header; i < view.getUint32(threadInfo.rva + 8, true); i += 1, t += entry)
      if (view.getUint32(t, true) === threadId) out.push(`  thread start: ${where(view.getBigUint64(t + 48, true))}; flags ${hex(view.getUint32(t + 4, true))}`);
  } else out.push("  no thread-info stream");
  const unloaded = streams.get(14);
  if (unloaded) {
    const header = view.getUint32(unloaded.rva, true);
    const entry = view.getUint32(unloaded.rva + 4, true);
    if (header < 12 || entry < 24) throw new Error("invalid unloaded-module info");
    for (let i = 0, t = unloaded.rva + header; i < view.getUint32(unloaded.rva + 8, true); i += 1, t += entry) {
      const base = view.getBigUint64(t, true);
      const size = BigInt(view.getUint32(t + 8, true));
      const name = basename(stringAt(view.getUint32(t + 20, true)).replaceAll("\\", "/"));
      out.push(`  unloaded ${name}: ${hex(base)}..${hex(base + size)}${address >= base && address < base + size ? " CONTAINS FAULT ADDRESS" : ""}`);
    }
  } else out.push("  no unloaded-module stream");
  const memoryInfo = streams.get(16);
  if (memoryInfo) {
    const header = view.getUint32(memoryInfo.rva, true);
    const entry = view.getUint32(memoryInfo.rva + 4, true);
    if (header < 16 || entry < 48) throw new Error("invalid memory info");
    for (let i = 0, t = memoryInfo.rva + header; i < Number(view.getBigUint64(memoryInfo.rva + 8, true)); i += 1, t += entry) {
      const base = view.getBigUint64(t, true);
      const size = view.getBigUint64(t + 24, true);
      if (address >= base && address < base + size) out.push(`  fault page: base ${hex(base)}, allocation ${hex(view.getBigUint64(t + 8, true))}, state ${hex(view.getUint32(t + 32, true))}, protect ${hex(view.getUint32(t + 36, true))}, type ${hex(view.getUint32(t + 40, true))}`);
    }
  } else out.push("  no memory-info stream");

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
