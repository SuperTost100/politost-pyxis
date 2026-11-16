import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

/**
 * A local server that stands in for the CDNs the packs come from, for the end-to-end runs (PYXIS_E2E_PACK_BASE, see
 * `fileUrl` in src/main/runtime-pack.ts). It serves the pinned fixtures of `.tmp/<pack>/` as `/<pack>/<file>`, and a spec
 * decides what each file does: `hold` makes a request wait until it is let go, `fail` answers 503, `tamper` changes one
 * byte of the file so its hash no longer matches. No real network is touched.
 */
export async function packServer() {
  /** Every request, in order, as `<pack>/<file>`. */
  const requests: string[] = [];
  const hold = new Set<string>();
  const fail = new Set<string>();
  const tamper = new Set<string>();
  const server = createServer((request, response) => {
    const match = /^\/(pyodide|drawing)\/([^/]+)$/.exec(request.url ?? "");
    if (!match) return void response.writeHead(404).end();
    const [, pack, name] = match as unknown as [string, string, string];
    requests.push(`${pack}/${name}`);
    const path = join(process.cwd(), ".tmp", pack, name);
    const answer = () => {
      if (fail.has(name)) return void response.writeHead(503).end();
      if (!existsSync(path)) return void response.writeHead(404).end();
      const bytes = Buffer.from(readFileSync(path));
      if (tamper.has(name)) bytes[Math.floor(bytes.length / 2)] = bytes[Math.floor(bytes.length / 2)]! ^ 0xff;
      response.writeHead(200, { "content-type": "application/octet-stream" }).end(bytes);
    };
    // A held request answers when its file is let go, and not at all when the client gave up first.
    let closed = false;
    request.on("close", () => {
      closed = true;
    });
    const wait = () => {
      if (closed) return;
      if (hold.has(name)) return void setTimeout(wait, 25);
      answer();
    };
    wait();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    base: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    requests,
    hold,
    fail,
    tamper,
    close: () => {
      // Chromium and the app keep connections alive, and close() alone would wait for them.
      server.closeAllConnections();
      server.close();
    },
  };
}
