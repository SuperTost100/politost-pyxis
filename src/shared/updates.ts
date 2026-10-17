export type UpdateView = {
  state: "unpublished" | "current" | "available" | "failed";
  current: string;
  checkedAt?: number;
  release?: { version: string; url: string; notes: string };
};

/** How a verified installer reaches the student: the step Pyxis took and what is left for them. */
export type UpdateHandover =
  /** macOS: the disk image is open; the student drags Pyxis to Applications. */
  | "dmg-opened"
  /** macOS: a Finder window shows the new app next to a link to Applications; the student drags it across. */
  | "app-opened"
  /** Windows: the installer is ready to start once Pyxis closes. */
  | "exe-ready"
  /** Linux AppImage: the new file replaced the running one; a restart uses it. */
  | "appimage-replaced"
  /** Linux AppImage in a folder Pyxis cannot write: the verified file is shown in its folder. */
  | "appimage-folder"
  /** Linux .deb: the verified package is shown in its folder for the software installer. */
  | "deb-shown";

export type UpdateInstallError =
  | "network"
  | "not-newer"
  | "no-asset"
  | "no-checksum"
  | "too-large"
  | "mismatch"
  | "blocked"
  | "disk"
  | "handover";

export type UpdateInstallView =
  | { state: "idle" }
  | { state: "downloading"; version: string; received: number; total: number }
  | { state: "verified"; version: string; handover: UpdateHandover }
  | { state: "failed"; error: UpdateInstallError };

export type UpdateFinishResult = "done" | "workspace-busy" | "jobs-running";

/**
 * Whether Pyxis may close for an update now. A backup, restore, move or wipe must finish first. Running or queued jobs
 * stop and resume at the next start, so they only need the student's confirmation.
 */
export function finishBlock(input: {
  workspaceBusy: boolean;
  activeJobs: number;
  confirmed: boolean;
}): Exclude<UpdateFinishResult, "done"> | null {
  if (input.workspaceBusy) return "workspace-busy";
  if (input.activeJobs > 0 && !input.confirmed) return "jobs-running";
  return null;
}
