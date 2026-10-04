import { readFileSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { protocol } from "electron";
import { blobParts } from "../shared/blob-path";

function mimeOf(metaPath: string): string {
  try {
    const parsed = JSON.parse(readFileSync(metaPath, "utf8")) as {
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

export function registerBlobProtocol(workspace: string | (() => string)): void {
  protocol.handle("pyxis-blob", (request) => {
    let sha = "";
    try {
      sha = new URL(request.url).hostname;
    } catch {
      return new Response("bad request", { status: 400 });
    }
    let parts: [string, string, string];
    try {
      parts = blobParts(sha);
    } catch {
      return new Response("bad request", { status: 400 });
    }
    const root = join(
      typeof workspace === "function" ? workspace() : workspace,
      parts[0],
    );
    const file = join(root, parts[1], parts[2]);
    try {
      const resolvedRoot = realpathSync(root);
      const resolved = realpathSync(file);
      if (
        resolved !== resolvedRoot &&
        !resolved.startsWith(resolvedRoot + sep)
      ) {
        return new Response("forbidden", { status: 403 });
      }
      const body = readFileSync(resolved);
      return new Response(new Uint8Array(body), {
        headers: { "content-type": mimeOf(`${file}.json`) },
      });
    } catch {
      return new Response("not found", { status: 404 });
    }
  });
}
