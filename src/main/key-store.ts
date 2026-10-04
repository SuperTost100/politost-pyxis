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
    writeFileSync(file, JSON.stringify(ciphertext), {
      mode: 0o600,
      flag: "wx",
    });
    const fd = openSync(file, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(file, path);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
