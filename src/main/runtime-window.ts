import type { BrowserWindow, Session } from "electron";

/**
 * What every window that runs untrusted work has in common. The session refuses every request the window's own host
 * does not list, so nothing reaches the network (the page's CSP says the same, but the session does not depend on it),
 * refuses every permission and every download, and the window refuses every navigation and every new window.
 *
 * The request filter sees only what goes through the network loader. A page can also reach out where it never passes,
 * and the policy of the page does not govern either: WebRTC opens its own sockets (UDP to a STUN or TURN server), and
 * `<link rel=preconnect>` and `dns-prefetch` are the network stack's own work, with a connection or a DNS lookup and no
 * request. So the session goes through a proxy that is not there (a SOCKS proxy at port 0 of this machine, with
 * the loopback rule off so that this machine's own addresses are not left out): whatever the network stack opens for this
 * window goes to a port nothing listens on, and a name is looked up by that proxy and never by this machine. WebRTC is
 * set (in `lockWindow`) to use no UDP that does not go through it. `observe` hears every URL the filter is asked about.
 */
export async function lockSession(
  partition: Session,
  allows: (url: string) => boolean,
  observe?: (url: string) => void,
): Promise<void> {
  partition.webRequest.onBeforeRequest((details, callback) => {
    observe?.(details.url);
    callback({ cancel: !allows(details.url) });
  });
  partition.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );
  partition.setPermissionCheckHandler(() => false);
  partition.setDevicePermissionHandler?.(() => false);
  partition.on?.("will-download", (event) => event.preventDefault());
  await partition.setProxy({
    mode: "fixed_servers",
    proxyRules: DEAD_PROXY,
    proxyBypassRules: "<-loopback>",
  });
}

/**
 * No process can listen on port 0 (binding to it asks the system for any free port), and a connection to it fails (checked on
 * Linux), so nothing can receive what the network stack sends here. The discard port, 9, was refused too, but on
 * Windows any local process may listen on it. A SOCKS proxy resolves names itself, so this machine looks up none.
 */
export const DEAD_PROXY = "socks5://127.0.0.1:0";

export function lockWindow(created: BrowserWindow): void {
  const contents = created.webContents;
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  // No UDP that does not go through the proxy, which is none: WebRTC can gather no candidate and send no datagram.
  contents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
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
