import type { ElectronApplication } from "@playwright/test";
import { execFileSync } from "node:child_process";

type Proc = { pid: number; ppid: number; command: string };

/** Every process on the machine with its parent and command line. */
export function processTable(): Proc[] {
  if (process.platform === "win32") {
    const out = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.CommandLine)" }',
      ],
      { encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
    );
    return out
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [pid, ppid, ...rest] = line.split("\t");
        return { pid: Number(pid), ppid: Number(ppid), command: rest.join("\t") };
      });
  }
  const out = execFileSync("ps", ["-A", "-o", "pid=,ppid=,args="], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return out
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s(.*)$/.exec(line)!;
      return { pid: Number(match[1]), ppid: Number(match[2]), command: match[3]! };
    });
}

/** Pyxis's main process and every process under it: renderer, GPU, network, core. */
export async function pyxisProcesses(app: ElectronApplication): Promise<Proc[]> {
  const main = await app.evaluate(() => process.pid);
  const table = processTable();
  const tree = table.filter((proc) => proc.pid === main);
  for (let i = 0; i < tree.length; i++)
    tree.push(...table.filter((proc) => proc.ppid === tree[i]!.pid));
  return tree;
}

const short = (proc: Proc) =>
  `${proc.pid} (parent ${proc.ppid}) ${proc.command.slice(0, 240)}`;

/**
 * Closes Pyxis and logs, for diagnosis, which of its processes are still alive after app.close() resolved and when each
 * one went away.
 */
export async function closeAndTrace(app: ElectronApplication, label: string) {
  const before = await pyxisProcesses(app);
  console.log(
    `[exit-trace] ${label}: ${before.length} processes before close\n  ${before.map(short).join("\n  ")}`,
  );
  const started = Date.now();
  await app.close();
  console.log(`[exit-trace] ${label}: app.close() took ${Date.now() - started} ms`);
  let alive = before;
  const closedAt = Date.now();
  while (alive.length && Date.now() - closedAt < 30_000) {
    const now = processTable();
    const still = alive.filter((proc) =>
      now.some((p) => p.pid === proc.pid && p.command === proc.command),
    );
    for (const gone of alive.filter((proc) => !still.includes(proc)))
      console.log(
        `[exit-trace] ${label}: +${Date.now() - closedAt} ms gone ${short(gone)}`,
      );
    alive = still;
    if (alive.length) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (alive.length)
    console.log(
      `[exit-trace] ${label}: STILL ALIVE 30 s after close:\n  ${alive.map(short).join("\n  ")}`,
    );
}
