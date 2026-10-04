import { parentPort, workerData } from "node:worker_threads";
import {
  backupWorkspace,
  restoreWorkspace,
  commitWorkspaceRestore,
  recoverInterruptedRestore,
} from "../core/share/backup";

const data = workerData as { op?: string; workspace?: string; zip?: string };

try {
  if (!data.workspace) throw new Error("backup-failed");
  if (data.op === "recover") {
    recoverInterruptedRestore(data.workspace);
    parentPort?.postMessage({ ok: true });
  } else if (data.op === "commit") {
    parentPort?.postMessage({
      ok: true,
      cleanupComplete: commitWorkspaceRestore(data.workspace),
    });
  } else {
    if (!data.zip) throw new Error("backup-failed");
    if (data.op === "backup") backupWorkspace(data.workspace, data.zip);
    else if (data.op === "restore")
      restoreWorkspace(data.zip, data.workspace, { deferCommit: true });
    else throw new Error("backup-failed");
    parentPort?.postMessage({ ok: true });
  }
} catch (err) {
  parentPort?.postMessage({
    ok: false,
    message: err instanceof Error ? err.message : "backup-failed",
  });
}
