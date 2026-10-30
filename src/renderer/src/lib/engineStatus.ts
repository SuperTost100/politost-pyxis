/** The fields of an `engines.overview` row that decide what the student sees. */
export type EngineState = {
  kind: "cli" | "api";
  installed: boolean;
  loggedIn: boolean;
  refused: boolean;
  disabled: boolean;
};

export type EngineStatus = {
  /** The row's tone, shown with an icon and a word. */
  tone: "ok" | "warn" | "error" | "idle";
  /** The word, as a translation key. */
  label: string;
  /** What the row's button does: sign in, install, or nothing to fix. */
  fix: "signIn" | "install" | null;
};

/**
 * One reading of an engine's state for setup and Settings: ready, signed out, sign-in refused (the CLI says signed in
 * but the provider turned a call away), not installed, or not offered by this build.
 */
export function engineStatus(row: EngineState): EngineStatus {
  if (row.disabled)
    return { tone: "idle", label: "engines.unavailable", fix: null };
  if (!row.installed)
    return {
      tone: "idle",
      label: "engines.notInstalled",
      fix: row.kind === "cli" ? "install" : null,
    };
  if (row.refused)
    return { tone: "error", label: "engines.state.refused", fix: "signIn" };
  if (!row.loggedIn)
    return {
      tone: "warn",
      label: "engines.state.signedOut",
      fix: row.kind === "cli" ? "signIn" : null,
    };
  return { tone: "ok", label: "engines.state.ready", fix: null };
}

type ChoiceRow = EngineState & { id: string };

/**
 * The engines the student can tick: every CLI this build offers, installed or not, and each API provider whose key is
 * saved. `keys` are the saved vendors, such as "openai".
 */
export function choiceRows<T extends ChoiceRow>(
  rows: readonly T[],
  keys: readonly string[],
): T[] {
  return rows.filter(
    (row) =>
      !row.disabled &&
      (row.kind === "cli" ||
        keys.includes(row.id === "anthropic-api" ? "anthropic" : "openai")),
  );
}

/**
 * Where "I choose" starts: every engine that is ready, API providers included, so nothing changes until a box is
 * unticked. With none ready, the installed ones.
 */
export function chosenStart(rows: readonly ChoiceRow[]): string[] {
  const ready = rows.filter((row) => row.installed && row.loggedIn);
  return (ready.length ? ready : rows.filter((row) => row.installed)).map(
    (row) => row.id,
  );
}
