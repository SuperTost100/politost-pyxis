import { writeFileAtomic } from "../core/atomic-write";

/** Ciphertext only. A failed write leaves the previous key file intact. */
export function writeKeyStore(
  path: string,
  ciphertext: Record<string, string>,
): void {
  writeFileAtomic(path, JSON.stringify(ciphertext));
}
