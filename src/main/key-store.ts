import {
  closeSync,
  fsyncSync,
  mkdtempSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

/** Ciphertext only. A failed write leaves the previous key file intact. */
export function writeKeyStore(
  path: string,
  ciphertext: Record<string, string>,
): void {
  const temporary = mkdtempSync(join(dirname(path), ".keys-"));
  const file = join(temporary, "keys.json");
  try {
    const fd = openSync(file, "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify(ciphertext));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(file, path);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
