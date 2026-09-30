import { parentPort, workerData } from "node:worker_threads";
import { backupWorkspace, restoreWorkspace } from "../core/share/backup";

const data = workerData as { op?: string; workspace?: string; zip?: string };

try {
  if (!data.workspace || !data.zip) throw new Error("backup-failed");
  if (data.op === "backup") backupWorkspace(data.workspace, data.zip);
  else if (data.op === "restore") restoreWorkspace(data.zip, data.workspace);
  else throw new Error("backup-failed");
  parentPort?.postMessage({ ok: true });
} catch (err) {
  parentPort?.postMessage({
    ok: false,
    message: err instanceof Error ? err.message : "backup-failed",
  });
}
