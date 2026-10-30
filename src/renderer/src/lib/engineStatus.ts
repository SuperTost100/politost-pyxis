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
