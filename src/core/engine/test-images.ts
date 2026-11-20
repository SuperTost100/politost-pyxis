import { onTestFinished } from "vitest";
import { getFunnel, type ProviderId } from "./funnel";

/**
 * Tests only. Makes a provider refuse image attachments until the test ends, as a tool whose CLI takes none would. No tool
 * does today (cli-funnel 1.0 gives Antigravity images over ACP), but the rule that follows from `capabilities.images`
 * stays for the next one.
 */
export function refuseImages(provider: ProviderId): void {
  const capabilities = getFunnel().providers[provider]!.capabilities as { images?: boolean };
  const before = capabilities.images;
  capabilities.images = false;
  onTestFinished(() => {
    capabilities.images = before;
  });
}
