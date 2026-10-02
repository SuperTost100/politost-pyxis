import {
  checkClaimSchema,
  type MathCheck as CheckClaim,
} from "../../shared/math-check";
import { runtimeRequest } from "./runtime-client";
export type { CheckClaim };
export type CheckState = "verified" | "failed" | "none";
export async function checkClaim(
  input: CheckClaim,
): Promise<{ state: CheckState; reason?: string }> {
  const claim = checkClaimSchema.safeParse(input);
  if (!claim.success)
    return { state: "none", reason: "unsupported-expression" };
  try {
    return (await runtimeRequest("check", claim.data)) as {
      state: CheckState;
      reason?: string;
    };
  } catch {
    return { state: "none", reason: "runtime-unavailable" };
  }
}
