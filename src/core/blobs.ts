import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { blobParts } from "../shared/blob-path";

export type BlobRecord = {
  sha: string;
  file: string;
  mime: string;
};

function location(
  workspace: string,
  sha: string,
): { file: string; meta: string } {
  const [folder, dir, name] = blobParts(sha);
  const blobsRoot = join(workspace, folder);
  const file = join(blobsRoot, dir, name);
  if (!file.startsWith(blobsRoot + sep)) throw new Error("path-escape");
  return { file, meta: `${file}.json` };
}

export function putBlob(
  workspace: string,
  bytes: Uint8Array,
  mime: string,
  ext: string,
): string {
  const sha = createHash("sha256").update(bytes).digest("hex");
  const { file, meta } = location(workspace, sha);
  mkdirSync(join(file, ".."), { recursive: true });
  if (!existsSync(file)) writeFileSync(file, bytes);
  if (!existsSync(meta)) writeFileSync(meta, JSON.stringify({ mime, ext }));
  return sha;
}

export function readBlob(workspace: string, sha: string): BlobRecord {
  const { file, meta } = location(workspace, sha);
  const parsed = JSON.parse(readFileSync(meta, "utf8")) as { mime?: unknown };
  const mime =
    typeof parsed.mime === "string" ? parsed.mime : "application/octet-stream";
  return { sha, file, mime };
}
