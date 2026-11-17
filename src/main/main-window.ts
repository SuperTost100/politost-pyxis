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

/** Whether the app has no main window and one has to be made (the dock icon clicked, a plan file opened). */
export function needsMainWindow(main: { isDestroyed(): boolean } | null): boolean {
  return main === null || main.isDestroyed();
}
