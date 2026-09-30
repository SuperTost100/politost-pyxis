/** Relative pieces of a blob path. The hash is the only untrusted input. */
export function blobParts(sha: string): [string, string, string] {
  if (!/^[a-f0-9]{64}$/.test(sha)) throw new Error("bad-hash");
  return ["blobs", sha.slice(0, 2), sha];
}
