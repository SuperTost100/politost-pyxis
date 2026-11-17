/**
 * What the app does when its main window goes, decided from that window and not from how many windows exist. The drawing
 * window and the Python window are hidden, stay open after they answer so the next request finds them ready, and are the
 * app's own: counting them made a closed main window leave Pyxis running on Windows and Linux (`window-all-closed` never
 * came), and on macOS made a click on the dock icon find "a window" and open none.
 */

/** Whether closing the main window ends the app: on Windows and Linux it does, on macOS the app outlives its window. */
export function endsWithMainWindow(platform: string): boolean {
  return platform !== "darwin";
}

/**
 * Whether a main window has to be made now (the dock icon clicked, a plan file opened): the app has none, or the one it
 * had is destroyed, and startup has made its first. Before that startup is on its way to the window (it may still be
 * copying an old profile's settings, in a hidden window of its own) and makes it itself, so no other path makes one.
 */
export function needsMainWindow(main: { isDestroyed(): boolean } | null, startupDone: boolean): boolean {
  return windowAction(main, startupDone) === "create";
}

/**
 * What a request that needs the main window does: `use` the one there is, `create` one (startup is done and there is
 * none), or `wait`, because startup has not made its first yet and makes it itself, with what was asked kept for it.
 */
export function windowAction(main: { isDestroyed(): boolean } | null, startupDone: boolean): "use" | "create" | "wait" {
  if (main !== null && !main.isDestroyed()) return "use";
  return startupDone ? "create" : "wait";
}

/**
 * Tests only: the file `PYXIS_E2E_FIRST_WINDOW_HOLD` names, while startup has to wait for it to go before it makes its
 * first window. Nothing outside a run with PYXIS_E2E=1 reads it.
 */
export function firstWindowHold(env: Record<string, string | undefined>): string | undefined {
  return env["PYXIS_E2E"] === "1" ? env["PYXIS_E2E_FIRST_WINDOW_HOLD"] : undefined;
}
