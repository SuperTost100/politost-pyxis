/**
 * The main window's Content Security Policy. Main sends it as a response header (the pyxis-app protocol with every
 * file of the built page, the session hook with the dev server's), and the built index.html also carries it as a
 * meta tag, so the page keeps it whichever scheme or session serves the file. `'self'` is pyxis-app://app for the
 * built page. The development variant adds the Vite server's origin and its HMR WebSocket.
 */
export function rendererCsp(devOrigin?: string): string {
  const dev = devOrigin ? ` ${devOrigin}` : "";
  return [
    `default-src 'self'${dev}`,
    `script-src 'self'${dev}`,
    `style-src 'self' 'unsafe-inline'${dev}`,
    `img-src 'self' data: blob: pyxis-blob:${dev}`,
    `font-src 'self' data:${dev}`,
    `connect-src 'self' pyxis-blob:${dev}${devOrigin ? " ws: wss:" : ""}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-src 'none'",
  ].join("; ");
}
