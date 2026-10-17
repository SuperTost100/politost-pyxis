import { rmSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import {
  backupWorkspace,
  hasActiveJobs,
  hasStudyData,
  restoreWorkspace,
  commitWorkspaceRestore,
  recoverInterruptedRestore,
  verifyBackupArchive,
} from "../core/share/backup";

const data = workerData as {
  op?: string;
  workspace?: string;
  zip?: string;
  /** op "verify": the archives to check. */
  zips?: string[];
  /** Automatic backups: one Int32 that main sets to 1 to stop the copy. */
  stop?: SharedArrayBuffer;
  waitForJobs?: boolean;
  /** Automatic backups: skip a workspace with no study data yet. */
  requireData?: boolean;
};

try {
  if (data.op === "verify") {
    // Reads archives only; no workspace is involved.
    parentPort?.postMessage({
      ok: true,
      verified: (data.zips ?? []).map((zip) => verifyBackupArchive(zip)),
    });
  } else if (!data.workspace) throw new Error("backup-failed");
  else if (data.op === "recover") {
    parentPort?.postMessage({
      ok: true,
      outcome: recoverInterruptedRestore(data.workspace),
    });
  } else if (data.op === "commit") {
    parentPort?.postMessage({
      ok: true,
      cleanupComplete: commitWorkspaceRestore(data.workspace),
    });
  } else {
    if (!data.zip) throw new Error("backup-failed");
    if (data.op === "backup") backupWorkspace(data.workspace, data.zip);
    else if (data.op === "live-backup") {
      if (data.requireData && !hasStudyData(data.workspace))
        throw new Error("backup-empty");
      if (data.waitForJobs && hasActiveJobs(data.workspace))
        throw new Error("backup-jobs-active");
      const flag = data.stop ? new Int32Array(data.stop) : undefined;
      backupWorkspace(data.workspace, data.zip, {
        live: true,
        stopped: () => (flag ? Atomics.load(flag, 0) === 1 : false),
        onTemporary: (temporary) => parentPort?.postMessage({ temporary }),
      });
      // A broken archive must not stand among the backups worth keeping, so it is removed and the backup fails.
      if (!verifyBackupArchive(data.zip)) {
        rmSync(data.zip, { force: true });
        throw new Error("backup-unverified");
      }
    } else if (data.op === "restore")
      restoreWorkspace(data.zip, data.workspace, { deferCommit: true });
    else throw new Error("backup-failed");
    parentPort?.postMessage({ ok: true });
  }
} catch (err) {
  parentPort?.postMessage({
    ok: false,
    message: err instanceof Error ? err.message : "backup-failed",
    code:
      err && typeof err === "object" && "code" in err
        ? String(err.code)
        : undefined,
  });
}
