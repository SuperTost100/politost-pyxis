import type { BrowserWindow, Session } from "electron";

/**
 * What every window that runs untrusted work has in common. The session refuses every request the window's own host
 * does not list, so nothing reaches the network (the page's CSP says the same, but the session does not depend on it),
 * refuses every permission and every download, and the window refuses every navigation and every new window.
 */
export function lockSession(partition: Session, allows: (url: string) => boolean): void {
  partition.webRequest.onBeforeRequest((details, callback) =>
    callback({ cancel: !allows(details.url) }),
  );
  partition.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );
  partition.setPermissionCheckHandler(() => false);
  partition.setDevicePermissionHandler?.(() => false);
  partition.on?.("will-download", (event) => event.preventDefault());
}

export function lockWindow(created: BrowserWindow): void {
  const contents = created.webContents;
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  for (const event of ["will-navigate", "will-redirect", "will-frame-navigate"] as const)
    contents.on(event as "will-navigate", (details: { preventDefault: () => void }) => details.preventDefault());
}

// The sandbox never navigates, so a main frame that is destroyed or detached means its renderer is gone. Electron can
// dispose the frame before isCrashed() turns true and before render-process-gone.
export function rendererGone(target: BrowserWindow): boolean {
  if (target.isDestroyed() || target.webContents.isDestroyed() || target.webContents.isCrashed()) return true;
  const frame = target.webContents.mainFrame;
  return !frame || frame.isDestroyed() || frame.detached;
}
