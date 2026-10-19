import { useRunTmpdir } from "./run-tmpdir";

// Playwright awaits the returned function after the last spec. Specs and the apps they launch inherit TMPDIR.
export default function globalSetup(): () => void {
  return useRunTmpdir();
}
