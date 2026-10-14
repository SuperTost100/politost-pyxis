import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  open,
  rename,
  rm,
  type FileHandle,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  finishBlock,
  type UpdateFinishResult,
  type UpdateInstallError,
  type UpdateInstallView,
} from "../shared/updates";
import { latestRelease, newerStable, readCapped } from "./updates";

/** The largest installer Pyxis downloads. The 0.2.3 AppImage is 528 MB. */
export const MAX_INSTALLER_BYTES = 1024 * 1024 * 1024;
const MAX_SUMS_BYTES = 64 * 1024;
/** A download that receives nothing for this long is stopped as a network failure. */
const IDLE_TIMEOUT = 30_000;
const PROGRESS_INTERVAL = 100;
const ASSET_HOSTS = new Set([
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
]);

export class InstallError extends Error {
  constructor(readonly code: UpdateInstallError) {
    super(`update-${code}`);
  }
}

export type InstallKind = "dmg" | "exe" | "appimage" | "deb";
export type InstallTarget = {
  platform: string;
  arch: string;
  /** `$APPIMAGE`: the running AppImage file, set by the AppImage runtime. */
  appImage?: string;
};

/**
 * The release asset that installs this copy of Pyxis. GitHub turns the spaces in electron-builder's file names into
 * dots, so these are the names on the release page. Windows on Arm and Linux on Arm have no build.
 */
export function installerAsset(
  tag: string,
  target: InstallTarget,
): { name: string; kind: InstallKind } | null {
  const version = tag.replace(/^v/, "");
  if (target.platform === "darwin") {
    if (target.arch === "arm64")
      return { name: `PoliTost.Pyxis-${version}-arm64.dmg`, kind: "dmg" };
    if (target.arch === "x64")
      return { name: `PoliTost.Pyxis-${version}.dmg`, kind: "dmg" };
    return null;
  }
  if (target.arch !== "x64") return null;
  if (target.platform === "win32")
    return { name: `PoliTost.Pyxis.Setup.${version}.exe`, kind: "exe" };
  if (target.platform === "linux")
    return target.appImage
      ? { name: `PoliTost.Pyxis-${version}.AppImage`, kind: "appimage" }
      : { name: `politost-pyxis_${version}_amd64.deb`, kind: "deb" };
  return null;
}

/**
 * Checksums by asset name from a `sha256sum` listing. A name listed with spaces is matched to GitHub's dotted asset
 * name. A name listed twice with different checksums is dropped, so neither line vouches for the file.
 */
export function parseSha256Sums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  const conflicted = new Set<string>();
  for (const line of text.split("\n")) {
    const match = line.replace(/\r$/, "").match(/^([0-9a-fA-F]{64}) [ *](.+)$/);
    if (!match) continue;
    const name = match[2]!.replaceAll(" ", ".");
    const hash = match[1]!.toLowerCase();
    if (sums.has(name) && sums.get(name) !== hash) conflicted.add(name);
    sums.set(name, hash);
  }
  for (const name of conflicted) sums.delete(name);
  return sums;
}

function parsedHttps(url: string): URL | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" &&
      !parsed.port &&
      !parsed.username &&
      !parsed.password
      ? parsed
      : null;
  } catch {
    return null;
  }
}

/** True for `https://github.com/<repository>/releases/download/<tag>/<name>` and nothing else. */
export function releaseDownloadUrl(
  url: string,
  repository: string,
  name: string,
): boolean {
  const parsed = parsedHttps(url);
  if (!parsed || parsed.hostname !== "github.com") return false;
  const prefix = `/${repository}/releases/download/`.toLowerCase();
  if (!parsed.pathname.toLowerCase().startsWith(prefix)) return false;
  const rest = parsed.pathname.slice(prefix.length).split("/");
  try {
    return (
      rest.length === 2 &&
      rest[0] !== "" &&
      decodeURIComponent(rest[1]!) === name
    );
  } catch {
    return false;
  }
}

/** True for the hosts GitHub redirects a release download to. */
export function releaseAssetRedirect(url: string): boolean {
  const parsed = parsedHttps(url);
  return !!parsed && ASSET_HOSTS.has(parsed.hostname);
}

/**
 * Requests a release asset of `repository`, following redirects by hand so each hop can be checked: the first URL must
 * be the repository's download URL for `name`, and every redirect must go to GitHub's release-asset hosts over HTTPS.
 */
export async function fetchReleaseFile(
  url: string,
  name: string,
  input: { repository: string; fetch: typeof fetch; signal: AbortSignal },
): Promise<Response> {
  if (!releaseDownloadUrl(url, input.repository, name))
    throw new InstallError("blocked");
  let current = url;
  for (let hop = 0; hop < 4; hop++) {
    const response = await input.fetch(current, {
      headers: { "User-Agent": "PoliTost-Pyxis" },
      redirect: "manual",
      signal: input.signal,
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get("location");
      let next = "";
      try {
        next = new URL(location ?? "", current).href;
      } catch {
        throw new InstallError("blocked");
      }
      if (!location || !releaseAssetRedirect(next))
        throw new InstallError("blocked");
      current = next;
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new InstallError("network");
    }
    return response;
  }
  throw new InstallError("blocked");
}

/**
 * Streams `response` to `<dest>.part` while hashing it, then renames it to `dest` only if the byte count equals `size`
 * and the SHA-256 equals `sha256`. Any failure, cancellation included, deletes the partial file.
 */
export async function downloadVerified(input: {
  response: Response;
  dest: string;
  size: number;
  sha256: string;
  signal: AbortSignal;
  max?: number;
  onProgress?: (received: number) => void;
}): Promise<void> {
  const max = input.max ?? MAX_INSTALLER_BYTES;
  if (input.size > max) {
    await input.response.body?.cancel();
    throw new InstallError("too-large");
  }
  const declared = input.response.headers.get("content-length");
  if (declared != null && Number(declared) !== input.size) {
    await input.response.body?.cancel();
    throw new InstallError("mismatch");
  }
  if (!input.response.body) throw new InstallError("network");
  const part = `${input.dest}.part`;
  const hash = createHash("sha256");
  let received = 0;
  let file: FileHandle | undefined;
  try {
    file = await open(part, "w");
    const reader = input.response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.length;
        if (received > max) throw new InstallError("too-large");
        if (received > input.size) throw new InstallError("mismatch");
        hash.update(value);
        await file.write(value);
        input.onProgress?.(received);
      }
    } finally {
      await reader.cancel();
    }
    await file.close();
    file = undefined;
    if (received !== input.size || hash.digest("hex") !== input.sha256)
      throw new InstallError("mismatch");
    await rename(part, input.dest);
  } catch (error) {
    await file?.close();
    await rm(part, { force: true });
    throw error;
  }
}

/** The student-facing reason for a failed download. System errors such as ENOSPC or EACCES come from the disk. */
function failure(error: unknown): UpdateInstallError {
  if (error instanceof InstallError) return error.code;
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^E[A-Z]+$/.test(code)
    ? "disk"
    : "network";
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/**
 * Puts a verified AppImage at `target`: copies it into the same folder, checks the copy against `sha256`, marks it
 * executable and renames it over the old file in one step. The running copy keeps its open file until Pyxis restarts.
 */
export async function replaceAppImage(
  source: string,
  target: string,
  sha256: string,
): Promise<void> {
  const temporary = join(
    dirname(target),
    `.${basename(target)}.update-${randomUUID()}`,
  );
  try {
    await copyFile(source, temporary, constants.COPYFILE_EXCL);
    if ((await sha256File(temporary)) !== sha256)
      throw new InstallError("mismatch");
    await chmod(temporary, 0o755);
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/**
 * The in-app update download. It runs only when the student starts it, takes the asset for this computer from the
 * latest stable release, checks it against the release's SHA256SUMS and then hands it over: macOS opens the disk image,
 * an AppImage replaces itself, a .deb is shown in its folder, and the Windows installer waits until Pyxis closes.
 */
export function updateInstaller(deps: {
  repository: string | null;
  current: string;
  /** A private folder for downloads. It is emptied when Pyxis starts and before each download. */
  dir: string;
  target: InstallTarget;
  fetch?: typeof fetch;
  emit: (view: UpdateInstallView) => void;
  openPath: (path: string) => Promise<string>;
  showItemInFolder: (path: string) => void;
  launch: (path: string) => Promise<void>;
  relaunch: (path: string) => void;
  quit: () => void;
  max?: number;
}) {
  const fetcher = deps.fetch ?? fetch;
  let view: UpdateInstallView = { state: "idle" };
  let controller: AbortController | null = null;
  let verified: { path: string; kind: InstallKind } | null = null;
  let cleared = rm(deps.dir, { recursive: true, force: true });

  function set(next: UpdateInstallView) {
    view = next;
    deps.emit(next);
  }

  async function download(signal: AbortSignal): Promise<void> {
    if (!deps.repository) throw new InstallError("no-asset");
    const repository = deps.repository;
    let release;
    try {
      release = await latestRelease(repository, fetcher);
    } catch {
      throw new InstallError("network");
    }
    if (!release || !newerStable(release.tag, deps.current))
      throw new InstallError("not-newer");
    const tag = release.tag;
    const pick = installerAsset(tag, deps.target);
    const asset = pick && release.assets.find((a) => a.name === pick.name);
    if (!pick || !asset) throw new InstallError("no-asset");
    if (asset.size > (deps.max ?? MAX_INSTALLER_BYTES))
      throw new InstallError("too-large");
    const sumsAsset = release.assets.find((a) => a.name === "SHA256SUMS");
    if (!sumsAsset) throw new InstallError("no-checksum");
    set({ state: "downloading", version: tag, received: 0, total: asset.size });

    const sumsSignal = AbortSignal.any([signal, AbortSignal.timeout(7000)]);
    const sumsResponse = await fetchReleaseFile(sumsAsset.url, "SHA256SUMS", {
      repository,
      fetch: fetcher,
      signal: sumsSignal,
    });
    const sha256 = parseSha256Sums(
      (await readCapped(sumsResponse, MAX_SUMS_BYTES)).toString("utf8"),
    ).get(asset.name);
    if (!sha256) throw new InstallError("no-checksum");

    await cleared;
    await rm(deps.dir, { recursive: true, force: true });
    await mkdir(deps.dir, { recursive: true });
    const idle = new AbortController();
    let timer = setTimeout(() => idle.abort(), IDLE_TIMEOUT);
    const both = AbortSignal.any([signal, idle.signal]);
    const dest = join(deps.dir, asset.name);
    // At most one progress update per interval, and the latest count always arrives, even when the bytes pause.
    let shown = 0;
    let latest = 0;
    let pending: ReturnType<typeof setTimeout> | undefined;
    const show = () => {
      pending = undefined;
      shown = Date.now();
      set({
        state: "downloading",
        version: tag,
        received: latest,
        total: asset.size,
      });
    };
    try {
      const response = await fetchReleaseFile(asset.url, asset.name, {
        repository,
        fetch: fetcher,
        signal: both,
      });
      await downloadVerified({
        response,
        dest,
        size: asset.size,
        sha256,
        signal: both,
        max: deps.max,
        onProgress: (received) => {
          clearTimeout(timer);
          timer = setTimeout(() => idle.abort(), IDLE_TIMEOUT);
          latest = received;
          const wait = shown + PROGRESS_INTERVAL - Date.now();
          if (wait <= 0) show();
          else pending ??= setTimeout(show, wait);
        },
      });
    } catch (error) {
      if (idle.signal.aborted && !signal.aborted)
        throw new InstallError("network");
      throw error;
    } finally {
      clearTimeout(timer);
      clearTimeout(pending);
    }
    verified = { path: dest, kind: pick.kind };
    if (pick.kind === "dmg") {
      if (await deps.openPath(dest)) throw new InstallError("handover");
      return set({ state: "verified", version: tag, handover: "dmg-opened" });
    }
    if (pick.kind === "deb") {
      deps.showItemInFolder(dest);
      return set({ state: "verified", version: tag, handover: "deb-shown" });
    }
    if (pick.kind === "appimage") {
      try {
        await replaceAppImage(dest, deps.target.appImage!, sha256);
      } catch {
        deps.showItemInFolder(dest);
        return set({
          state: "verified",
          version: tag,
          handover: "appimage-folder",
        });
      }
      await rm(dest, { force: true });
      verified = { path: deps.target.appImage!, kind: "appimage" };
      return set({
        state: "verified",
        version: tag,
        handover: "appimage-replaced",
      });
    }
    set({ state: "verified", version: tag, handover: "exe-ready" });
  }

  return {
    state: () => view,
    async start(): Promise<void> {
      if (view.state === "downloading") return;
      controller = new AbortController();
      const signal = controller.signal;
      verified = null;
      set({ state: "downloading", version: "", received: 0, total: 0 });
      try {
        await download(signal);
      } catch (error) {
        verified = null;
        // Nothing half-downloaded stays behind, whatever stopped the download.
        cleared = rm(deps.dir, { recursive: true, force: true });
        await cleared;
        if (signal.aborted) set({ state: "idle" });
        else set({ state: "failed", error: failure(error) });
      } finally {
        controller = null;
      }
    },
    /** Stops a running download, or clears a finished or failed one. */
    cancel(): void {
      if (controller) controller.abort();
      else set({ state: "idle" });
    },
    /** Opens the disk image again, or shows the downloaded file in its folder again. */
    async reveal(): Promise<void> {
      if (view.state !== "verified" || !verified) return;
      if (verified.kind === "dmg") {
        if (await deps.openPath(verified.path))
          throw new Error("update-handover");
      } else deps.showItemInFolder(verified.path);
    },
    /**
     * Closes Pyxis to finish an update: starts the Windows installer first, or restarts into the replaced AppImage.
     * Workspace work must finish first and running jobs need the student's confirmation.
     */
    async finish(input: {
      workspaceBusy: boolean;
      activeJobs: number;
      confirmed: boolean;
    }): Promise<UpdateFinishResult> {
      const blocked = finishBlock(input);
      if (blocked) return blocked;
      if (view.state !== "verified" || !verified)
        throw new Error("update-not-ready");
      if (view.handover === "exe-ready") {
        try {
          await deps.launch(verified.path);
        } catch {
          set({ state: "failed", error: "handover" });
          return "done";
        }
      } else if (view.handover === "appimage-replaced")
        deps.relaunch(verified.path);
      else if (view.handover !== "dmg-opened")
        throw new Error("update-not-ready");
      deps.quit();
      return "done";
    },
  };
}
