import { describe, expect, it } from "vitest";
import type { RestoreOutcome } from "../core/share/backup";
import {
  commitRestore,
  RestoreRecoveryRequired,
  type RestoreCommitSteps,
} from "./restore-commit";

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
    const full = () => new Error("ENOSPC: no space left");
    const t = steps([busy(), busy(), full(), full()]);
    await expect(commitRestore(t.run)).rejects.toThrow("restore-rolled-back");
    // Core must not keep serving a copy the next launch would roll back.
    expect(t.log).toEqual([
      "commit",
      "wait",
      "commit",
      "wait",
      "commit",
      "stop",
      "commit",
      "recover",
      "start",
    ]);
  });

  it("commits once core has stopped and let go of its files", async () => {
    const t = steps([busy(), busy(), busy(), true]);
    expect(await commitRestore(t.run)).toEqual({ cleanupComplete: true });
    expect(t.log.slice(-3)).toEqual(["stop", "commit", "start"]);
  });

  it("keeps the restored workspace when recovery finds the commit had been recorded", async () => {
    const t = steps([busy(), busy(), busy(), busy()], "kept");
    expect(await commitRestore(t.run)).toEqual({ cleanupComplete: true });
    expect(t.log.slice(-3)).toEqual(["commit", "recover", "start"]);
  });

  it("keeps core stopped when the rollback fails too", async () => {
    // Windows refuses the rollback's first rename, so the uncommitted restored copy is still the live folder.
    const t = steps(
      [busy(), busy(), busy(), busy()],
      Object.assign(new Error("EPERM: operation not permitted, rename"), {
        code: "EPERM",
      }),
    );
    const error = await commitRestore(t.run).catch((e: Error) => e);
    expect(error).toBeInstanceOf(RestoreRecoveryRequired);
    expect((error as Error).message).toBe("restore-recovery-required");
    expect(t.log).not.toContain("start");
    expect(t.log.at(-1)).toBe("recover");
  });

  it("does not commit, roll back or start core when the running one could not be stopped", async () => {
    const t = steps([busy(), busy(), busy()]);
    t.run.stopCore = async () => {
      t.log.push("stop");
      throw new Error("core-busy");
    };
    await expect(commitRestore(t.run)).rejects.toBeInstanceOf(
      RestoreRecoveryRequired,
    );
    expect(t.log.slice(-1)).toEqual(["stop"]);
  });
});
