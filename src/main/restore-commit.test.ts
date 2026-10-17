import { describe, expect, it } from "vitest";
import type { RestoreOutcome } from "../core/share/backup";
import { commitRestore, type RestoreCommitSteps } from "./restore-commit";

/** Records the order of the steps; each commit attempt takes the next outcome. */
function steps(
  commits: Array<boolean | Error>,
  recovered: RestoreOutcome | Error = "rolled-back",
) {
  const log: string[] = [];
  const run: RestoreCommitSteps = {
    commit: async () => {
      log.push("commit");
      const next = commits.shift() ?? new Error("no-more-commits");
      if (next instanceof Error) throw next;
      return next;
    },
    stopCore: async () => {
      log.push("stop");
    },
    recover: async () => {
      log.push("recover");
      if (recovered instanceof Error) throw recovered;
      return recovered;
    },
    startCore: async () => {
      log.push("start");
    },
    wait: async () => {
      log.push("wait");
    },
  };
  return { log, run };
}

const busy = () =>
  Object.assign(new Error("EBUSY: resource busy"), { code: "EBUSY" });

describe("commitRestore", () => {
  it("records the restore and reports whether the old copy is gone", async () => {
    const t = steps([true]);
    expect(await commitRestore(t.run)).toEqual({ cleanupComplete: true });
    const pending = steps([false]);
    expect(await commitRestore(pending.run)).toEqual({
      cleanupComplete: false,
    });
    expect(t.log).toEqual(["commit"]);
  });

  it("tries the commit again when a file was briefly held", async () => {
    const t = steps([busy(), true]);
    expect(await commitRestore(t.run)).toEqual({ cleanupComplete: true });
    expect(t.log).toEqual(["commit", "wait", "commit"]);
  });

  it("stops core and goes back to the old workspace when the commit keeps failing", async () => {
    const t = steps([busy(), busy(), new Error("ENOSPC: no space left")]);
    await expect(commitRestore(t.run)).rejects.toThrow("restore-rolled-back");
    // Core must not keep serving a copy the next launch would roll back.
    expect(t.log).toEqual([
      "commit",
      "wait",
      "commit",
      "wait",
      "commit",
      "stop",
      "recover",
      "start",
    ]);
  });

  it("keeps the restored workspace when recovery finds the commit had been recorded", async () => {
    const t = steps([busy(), busy(), busy()], "kept");
    expect(await commitRestore(t.run)).toEqual({ cleanupComplete: true });
    expect(t.log.slice(-3)).toEqual(["stop", "recover", "start"]);
  });

  it("still starts core when the rollback fails, and reports the rollback error", async () => {
    const t = steps(
      [busy(), busy(), busy()],
      new Error("backup-restore-recovery-required"),
    );
    await expect(commitRestore(t.run)).rejects.toThrow(
      "backup-restore-recovery-required",
    );
    expect(t.log.at(-1)).toBe("start");
  });

  it("does not start a second core when the running one could not be stopped", async () => {
    const t = steps([busy(), busy(), busy()]);
    t.run.stopCore = async () => {
      t.log.push("stop");
      throw new Error("core-busy");
    };
    await expect(commitRestore(t.run)).rejects.toThrow("core-busy");
    expect(t.log.slice(-1)).toEqual(["stop"]);
  });
});
