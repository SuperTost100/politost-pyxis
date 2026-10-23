import { createReadStream } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { inside } from "../core/path-inside";
import { Readable } from "node:stream";
import { protocol } from "electron";
import { blobParts } from "../shared/blob-path";

async function mimeOf(metaPath: string): Promise<string> {
  try {
    const parsed = JSON.parse(await readFile(metaPath, "utf8")) as {
      mime?: unknown;
    };
    if (
      typeof parsed.mime === "string" &&
      /^[\w.+-]+\/[\w.+-]+$/.test(parsed.mime)
    ) {
      return parsed.mime;
    }
  } catch {
    // Missing metadata still serves the bytes.
  }
  return "application/octet-stream";
}

/**
 * The answer to one `pyxis-blob:` request. The file streams from disk, so opening a large PDF neither holds it whole in
 * main's memory nor blocks the menu, window events and IPC while it is read. The renderer fetches whole files (the PDF
 * viewer and OCR read the full body), so Range requests are not served.
 */
export async function blobResponse(workspace: string, url: string): Promise<Response> {
  let sha = "";
  try {
    sha = new URL(url).hostname;
  } catch {
    return new Response("bad request", { status: 400 });
  }
  let parts: [string, string, string];
  try {
    parts = blobParts(sha);
  } catch {
    return new Response("bad request", { status: 400 });
  }
  const root = join(workspace, parts[0]);
  const file = join(root, parts[1], parts[2]);
  try {
    const resolvedRoot = await realpath(root);
    const resolved = await realpath(file);
    if (!inside(resolvedRoot, resolved)) {
      return new Response("forbidden", { status: 403 });
    }
    const info = await stat(resolved);
    if (!info.isFile()) return new Response("not found", { status: 404 });
    const body = Readable.toWeb(createReadStream(resolved)) as ReadableStream<Uint8Array>;
    return new Response(body, {
      headers: {
        "content-type": await mimeOf(`${file}.json`),
        "content-length": String(info.size),
      },
    });
  } catch {
    return new Response("not found", { status: 404 });
  }
}

export function registerBlobProtocol(workspace: string | (() => string)): void {
  protocol.handle("pyxis-blob", (request) =>
    blobResponse(typeof workspace === "function" ? workspace() : workspace, request.url),
  );
}
