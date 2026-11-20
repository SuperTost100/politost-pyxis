import { coreExited, coreStopping } from "./core-stop";

/** The part of Electron's UtilityProcess the retry looks at. */
type CoreProcess = Parameters<typeof coreExited>[0];

type CoreRetryDeps = {
  /** A backup, restore, move or wipe that stopped core on purpose and starts it again itself. */
  blocked(): boolean;
  current(): CoreProcess | null;
  /** Starts a new core. */
  start(): Promise<void>;
};

/**
 * What the Retry button does. The notice appears as soon as startup gives up on a core and ends it, but the process
 * can take a while to go. A press in that time waits for the exit and then starts the new core, because dropping it
 * would leave the notice up with nothing left to press. The new core starts only after the old one has exited, as it
 * could otherwise open pyxis.db while the old one still holds it.
 *
 * A running core that nobody is stopping is a healthy one, and Retry leaves it alone. Presses made while a retry is
 * waiting or starting share it, so they cannot start two cores.
 */
export function createCoreRetry({
  blocked,
  current,
  start,
}: CoreRetryDeps): () => Promise<void> {
  let running: Promise<void> | null = null;

  const mayStart = () => {
    if (blocked()) return false;
    const child = current();
    return !child || coreExited(child);
  };

  async function retry(): Promise<void> {
    const child = current();
    // shortcut: a core that outlasts the stop's 15 s limit leaves the notice up, and a press then does nothing; upgrade if that is ever seen.
    if (child && !coreExited(child))
      await coreStopping(child)?.catch(() => undefined);
    if (mayStart()) await start();
  }

  return () => {
    running ??= retry().finally(() => {
      running = null;
    });
    return running;
  };
}
