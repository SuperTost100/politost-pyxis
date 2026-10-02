import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkClaim, type CheckClaim } from "./check";
import { runtimeRequest } from "./runtime-client";
import { runPython } from "./python";

export function toolHandlers() {
  return {
    check(input: CheckClaim) {
      return checkClaim(input);
    },
    runtime() {
      return runtimeRequest("status", {});
    },
    python(input: { code: string }) {
      return runPython(input.code);
    },
    stagePng(input: { dataUrl: string }) {
      const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(
        input.dataUrl,
      );
      if (!match?.[1]) throw new Error("png-invalid");
      const bytes = Buffer.from(match[1], "base64");
      const signature = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ]);
      if (bytes.length < 32 || !bytes.subarray(0, 8).equals(signature)) {
        throw new Error("png-invalid");
      }
      const path = join(
        tmpdir(),
        `pyxis-board-${Date.now()}-${randomBytes(4).toString("hex")}.png`,
      );
      writeFileSync(path, bytes);
      return { path };
    },
  };
}
