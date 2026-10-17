import type { RestoreOutcome } from "../core/share/backup";

export type RestoreCommitSteps = {
  /** Records the restore as kept. False: kept, but the old copy is not fully deleted yet. */
  commit: () => Promise<boolean>;
  stopCore: () => Promise<void>;
  recover: () => Promise<RestoreOutcome>;
  /** Starts core on whatever workspace recovery left, and says so itself when it can't. */
  startCore: () => Promise<void>;
  wait?: (ms: number) => Promise<void>;
};

const ATTEMPTS = 3;

/**
 * The last step of a restore, once core runs on the restored copy. Until the commit is recorded the next launch rolls
 * that copy back and deletes it, so core must not keep running on it. A commit that fails (a full disk, a journal file a
 * virus scanner holds on Windows) is tried again, then core stops, the commit gets one more try, and otherwise the old
 * workspace comes back at once. Throws `restore-rolled-back` when the student has the data from before the restore
 * again. Throws RestoreRecoveryRequired, with core not started, when core would not stop or the rollback failed too.
 */
export async function commitRestore(
  steps: RestoreCommitSteps,
): Promise<{ cleanupComplete: boolean }> {
  const wait =
    steps.wait ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let failure: unknown;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      return { cleanupComplete: await steps.commit() };
    } catch (error) {
      failure = error;
      if (attempt < ATTEMPTS) await wait(500 * attempt);
    }
  }
  try {
    await steps.stopCore();
  } catch (error) {
    // A core that did not stop is still using the restored copy; starting another one on the same folder would be worse.
    throw new RestoreRecoveryRequired(error);
  }
  let outcome: RestoreOutcome;
  try {
    // A stopped core has let go of its files, which is often what a Windows rename was waiting for.
    const cleanupComplete = await steps.commit();
    await steps.startCore();
    return { cleanupComplete };
  } catch (error) {
    failure = error;
  }
  try {
    outcome = await steps.recover();
  } catch (error) {
    // Neither kept nor rolled back: the live folder may still be the uncommitted copy. Core stays stopped, since the
    // next launch's recovery would delete whatever the student did in it.
    throw new RestoreRecoveryRequired(error);
  }
  await steps.startCore();
  // The journal rename landed but a later step failed, so recovery finished the commit instead.
  if (outcome !== "rolled-back") return { cleanupComplete: true };
  throw new Error("restore-rolled-back", { cause: failure });
}

/** The restore could be neither committed nor rolled back. Core must stay stopped until Pyxis restarts. */
export class RestoreRecoveryRequired extends Error {
  constructor(cause: unknown) {
    super("restore-recovery-required", { cause });
  }
}
