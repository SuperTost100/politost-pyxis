import type { ElectronApplication } from "@playwright/test";
import { execFileSync } from "node:child_process";

/** `started`: when the process started, in ms. Windows only, where a parent ID can outlive its parent (see descendants). */
type PyxisProcess = {
  pid: number;
  ppid: number;
  command: string;
  started?: number;
};

/** Every process on the machine with its parent and command line. */
function processTable(): PyxisProcess[] {
  if (process.platform === "win32") {
    const out = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)`t$($_.ParentProcessId)`t$(if ($_.CreationDate) { ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() })`t$($_.CommandLine)" }',
      ],
      { encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
    );
    return out
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [pid, ppid, started, ...command] = line.split("\t");
        return {
          pid: Number(pid),
          ppid: Number(ppid),
          started: started ? Number(started) : undefined,
          command: command.join("\t"),
        };
      });
  }
  const out = execFileSync("ps", ["-A", "-o", "pid=,ppid=,args="], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return out
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(\d+)\s(.*)$/.exec(line))
    .filter((match) => match !== null)
    .map((match) => ({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      command: match[3]!,
    }));
}

/** Pyxis's main process and every process under it: renderer, GPU, network service, core, crash handler. */
async function processTree(app: ElectronApplication): Promise<PyxisProcess[]> {
  const main = await app.evaluate(() => process.pid);
  return descendants(processTable(), main);
}

/**
 * The process `root` and everything under it. Windows keeps a process's parent ID after the parent exits and reuses
 * IDs, so system processes started at boot can name a dead parent whose ID Pyxis now has. A child is never older than
 * its parent, which tells them apart. POSIX hands orphans to init, so there the parent ID is always live.
 */
export function descendants(
  table: PyxisProcess[],
  root: number,
): PyxisProcess[] {
  const tree = table.filter((proc) => proc.pid === root);
  for (let i = 0; i < tree.length; i++) {
    const parent = tree[i]!;
    tree.push(
      ...table.filter(
        (proc) =>
          proc.ppid === parent.pid &&
          (proc.started === undefined ||
            parent.started === undefined ||
            proc.started >= parent.started),
      ),
    );
  }
  return tree;
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** "1234 renderer", "1234 utility node.mojom.NodeService" (core), or the start of any other command line. */
function describe(proc: PyxisProcess): string {
  const type =
    /--type=(\S+)/.exec(proc.command)?.[1] ?? proc.command.slice(0, 160);
  const service = /--utility-sub-type=(\S+)/.exec(proc.command)?.[1];
  return [proc.pid, type, service].filter(Boolean).join(" ");
}

/**
 * Quits Pyxis and waits for every process it started to exit, since any of them can hold files in the workspace or the
 * profile. Fails naming the processes still running `limit` ms after app.close() returned.
 */
export async function quitPyxis(app: ElectronApplication, limit = 10_000) {
  const tree = await processTree(app);
  await app.close();
  const closed = Date.now();
  let left = tree;
  for (;;) {
    left = left.filter((proc) => running(proc.pid));
    if (!left.length || Date.now() - closed > limit) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (left.length)
    throw new Error(
      `Pyxis processes still running ${limit / 1000} s after quitting: ${left.map(describe).join(", ")}`,
    );
}
