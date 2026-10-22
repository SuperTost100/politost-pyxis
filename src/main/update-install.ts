import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  finishBlock,
  type UpdateFinishResult,
  type UpdateInstallError,
  type UpdateInstallView,
} from "../shared/updates";
import {
  assemble,
  blockMapEnd,
  DiffError,
  downloadBytes,
  embeddedBlockMap,
  embeddedLength,
  gzipBlockMap,
  MAX_BLOCKMAP_BYTES,
  planDownload,
  readEmbeddedBlockMap,
  readRange,
} from "./update-diff";
import { latestRelease, newerStable, readCapped } from "./updates";
import { idleTimeout } from "../core/sources/public-fetch";

/** The largest installer Pyxis downloads. The 0.2.3 AppImage is 528 MB. */
const MAX_INSTALLER_BYTES = 1024 * 1024 * 1024;
const MAX_SUMS_BYTES = 64 * 1024;
/** A download that receives nothing for this long is stopped as a network failure. */
const IDLE_TIMEOUT = 30_000;
const PROGRESS_INTERVAL = 100;
const ASSET_HOSTS = new Set([
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
]);

class InstallError extends Error {
  constructor(readonly code: UpdateInstallError) {
    super(`update-${code}`);
  }
}

export type InstallKind = "dmg" | "zip" | "exe" | "appimage" | "deb";
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
 * The Mac zip of a release. Pyxis updates a Mac from the zip rather than the disk image because it keeps the zip it
 * installed, and the next update downloads only the blocks that changed since then.
 */
function macZipAsset(tag: string, arch: string): string | null {
  const version = tag.replace(/^v/, "");
  if (arch === "arm64") return `PoliTost.Pyxis-${version}-arm64-mac.zip`;
  if (arch === "x64") return `PoliTost.Pyxis-${version}-mac.zip`;
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
 * With `range`, every hop asks for bytes `[start, end)` only; the caller checks that the answer honors it.
 */
export async function fetchReleaseFile(
  url: string,
  name: string,
  input: {
    repository: string;
    fetch: typeof fetch;
    signal: AbortSignal;
    range?: [start: number, end: number];
  },
): Promise<Response> {
  if (!releaseDownloadUrl(url, input.repository, name))
    throw new InstallError("blocked");
  let current = url;
  for (let hop = 0; hop < 4; hop++) {
    const response = await input.fetch(current, {
      headers: {
        "User-Agent": "PoliTost-Pyxis",
        ...(input.range
          ? { Range: `bytes=${input.range[0]}-${input.range[1] - 1}` }
          : {}),
      },
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
 * latest stable release, checks it against the release's SHA256SUMS and then hands it over: macOS shows the new app
 * next to Applications (or opens the disk image of a release without a zip), an AppImage replaces itself, a .deb is
 * shown in its folder, and the Windows installer waits until Pyxis closes. An AppImage and a Mac zip download only the
 * blocks that changed when Pyxis has the previous file, and the whole file otherwise.
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
  /**
   * Starts the installer at `path` once Pyxis has exited, never before: the installer must not find Pyxis running.
   * Main starts it from the app's `quit` event, by its full path and without a shell.
   */
  launchAfterQuit: (path: string) => void;
  relaunch: (path: string) => void;
  quit: () => void;
  /**
   * macOS: a folder that keeps the last verified zip and its blockmap between updates, and unpacks a zip into a new
   * folder. Without both, a Mac downloads the disk image.
   */
  mac?: {
    keepDir: string;
    extractZip: (zip: string, folder: string) => Promise<void>;
  };
  max?: number;
  log?: (message: string) => void;
  /** Removes the downloads folder. Tests replace it to make removal fail the way Windows does (EBUSY, EPERM). */
  removeDir?: (path: string) => Promise<void>;
}) {
  const fetcher = deps.fetch ?? fetch;
  let view: UpdateInstallView = { state: "idle" };
  let controller: AbortController | null = null;
  let verified: { path: string; kind: InstallKind } | null = null;
  // Windows can refuse to remove a folder an antivirus scan or an open file still holds (EBUSY, EPERM). The folder is
  // emptied again before the next download, so a refusal is logged and never stops anything.
  const removeDir =
    deps.removeDir ?? ((path) => rm(path, { recursive: true, force: true }));
  const clear = () =>
    removeDir(deps.dir).catch((error: unknown) =>
      deps.log?.(
        `pyxis: downloads folder not cleared (${(error as { code?: string } | null)?.code ?? "unknown"})`,
      ),
    );
  let cleared = clear();
  let finishing = false;
  const keptZip = deps.mac && join(deps.mac.keepDir, `${deps.target.arch}.zip`);

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
    const assets = release.assets;
    const pick = installerAsset(tag, deps.target);
    const zipName =
      deps.mac && deps.target.platform === "darwin"
        ? macZipAsset(tag, deps.target.arch)
        : null;
    // A Mac takes the zip when the release has one with a checksum line, and the disk image otherwise.
    const candidates = [
      ...(zipName ? [{ name: zipName, kind: "zip" as const }] : []),
      ...(pick ? [pick] : []),
    ].flatMap((candidate) => {
      const asset = assets.find((a) => a.name === candidate.name);
      return asset ? [{ asset, kind: candidate.kind }] : [];
    });
    if (candidates.length === 0) throw new InstallError("no-asset");
    const sumsAsset = assets.find((a) => a.name === "SHA256SUMS");
    if (!sumsAsset) throw new InstallError("no-checksum");
    set({
      state: "downloading",
      version: tag,
      received: 0,
      total: candidates[0]!.asset.size,
    });

    const sumsSignal = AbortSignal.any([signal, AbortSignal.timeout(7000)]);
    const sumsResponse = await fetchReleaseFile(sumsAsset.url, "SHA256SUMS", {
      repository,
      fetch: fetcher,
      signal: sumsSignal,
    });
    const sums = parseSha256Sums(
      (await readCapped(sumsResponse, MAX_SUMS_BYTES)).toString("utf8"),
    );
    const chosen = candidates.find(({ asset }) => sums.has(asset.name));
    if (!chosen) throw new InstallError("no-checksum");
    const { asset, kind } = chosen;
    const sha256 = sums.get(asset.name)!;
    if (asset.size > (deps.max ?? MAX_INSTALLER_BYTES))
      throw new InstallError("too-large");

    await cleared;
    await removeDir(deps.dir);
    await mkdir(deps.dir, { recursive: true });
    // The idle limit covers network reads only. Every response and every chunk of one restarts it; local file work
    // keeps it from running. The differential attempt and the whole-file download each get their own controller, so an
    // idle stop of the first still leaves the second a live signal.
    let idle = idleTimeout(IDLE_TIMEOUT);
    let both = AbortSignal.any([signal, idle.signal]);
    const touch = () => idle.touch();
    const dest = join(deps.dir, asset.name);
    // At most one progress update per interval, and the latest count always arrives, even when the bytes pause. The
    // total is the bytes this download fetches: the changed blocks, or the whole file.
    let total = asset.size;
    let shown = 0;
    let latest = 0;
    let pending: ReturnType<typeof setTimeout> | undefined;
    const show = () => {
      clearTimeout(pending);
      pending = undefined;
      shown = Date.now();
      set({ state: "downloading", version: tag, received: latest, total });
    };
    const onProgress = (received: number) => {
      touch();
      latest = received;
      const wait = shown + PROGRESS_INTERVAL - Date.now();
      if (wait <= 0) show();
      else pending ??= setTimeout(show, wait);
    };
    const restart = (next: number) => {
      total = next;
      latest = 0;
      show();
    };
    // Restarts the idle limit when the response arrives and for every chunk of its body, however the caller reads it.
    const alive = (response: Response): Response => {
      touch();
      if (!response.body) return response;
      // Pulls one chunk at a time, so the limit runs only while a read waits for the network.
      const reader = response.body.getReader();
      const body = new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            const { done, value } = await reader.read();
            if (done) return controller.close();
            touch();
            controller.enqueue(value);
          },
          cancel: (reason) => reader.cancel(reason),
        },
        { highWaterMark: 0 },
      );
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    };
    const releaseFile = async (name: string, range?: [number, number]) => {
      const file = assets.find((a) => a.name === name);
      if (!file) throw new DiffError("blockmap");
      return alive(
        await fetchReleaseFile(file.url, name, {
          repository,
          fetch: fetcher,
          signal: both,
          ...(range ? { range } : {}),
        }),
      );
    };
    const fetchRange = (start: number, end: number) =>
      releaseFile(asset.name, [start, end]);
    // The Mac zip's blockmap, kept with the zip so the next update can start from it.
    let zipBlockMap: Buffer | null = null;

    /** Rebuilds the new file from the previous one and the changed blocks. Throws when that is not possible. */
    async function differential(): Promise<void> {
      if (kind === "appimage") {
        const oldMap = await readEmbeddedBlockMap(deps.target.appImage!);
        const size = asset.size;
        const trailer = await readRange(fetchRange, size - 4, size, size);
        const length = embeddedLength(trailer, size);
        const data = await readRange(
          fetchRange,
          size - 4 - length,
          size - 4,
          size,
        );
        const newMap = embeddedBlockMap(data);
        if (blockMapEnd(newMap) !== size - 4 - length)
          throw new DiffError("blockmap");
        const operations = planDownload(oldMap, newMap);
        restart(downloadBytes(operations));
        return assemble({
          oldFile: deps.target.appImage!,
          operations,
          dest,
          size,
          sha256,
          tail: Buffer.concat([data, trailer]),
          fetchRange,
          signal: both,
          onProgress,
          onActivity: touch,
        });
      }
      if (kind !== "zip") throw new DiffError("plan");
      zipBlockMap = await readCapped(
        await releaseFile(`${asset.name}.blockmap`),
        MAX_BLOCKMAP_BYTES,
      );
      const newMap = gzipBlockMap(zipBlockMap);
      if (blockMapEnd(newMap) !== asset.size) {
        zipBlockMap = null;
        throw new DiffError("blockmap");
      }
      // The first update after differential downloads shipped has no kept zip and downloads the whole file.
      const oldMap = gzipBlockMap(await readFile(`${keptZip}.blockmap`));
      const operations = planDownload(oldMap, newMap);
      restart(downloadBytes(operations));
      return assemble({
        oldFile: keptZip!,
        operations,
        dest,
        size: asset.size,
        sha256,
        fetchRange,
        signal: both,
        onProgress,
        onActivity: touch,
      });
    }

    try {
      let rebuilt = false;
      if (kind === "appimage" || kind === "zip") {
        try {
          await differential();
          rebuilt = true;
        } catch (error) {
          // Only the user's cancel ends the update here. An idle stop of the differential path falls back to the
          // whole file, which starts with a fresh idle signal and timer.
          if (signal.aborted) throw error;
          idle.clear();
          idle = idleTimeout(IDLE_TIMEOUT);
          both = AbortSignal.any([signal, idle.signal]);
          const code = (error as { code?: unknown } | null)?.code;
          const reason =
            typeof code === "string"
              ? code
              : error instanceof Error
                ? error.message
                : "unknown";
          deps.log?.(`pyxis: downloading the whole update file (${reason})`);
          restart(asset.size);
        }
      }
      if (!rebuilt) {
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
          onProgress,
        });
      }
    } catch (error) {
      if (idle.signal.aborted && !signal.aborted)
        throw new InstallError("network");
      throw error;
    } finally {
      idle.clear();
      clearTimeout(pending);
    }
    verified = { path: dest, kind };
    if (kind === "zip") {
      const zip = zipBlockMap ? await keepZip(dest, zipBlockMap) : dest;
      const folder = join(deps.dir, `PoliTost Pyxis ${tag.replace(/^v/, "")}`);
      try {
        await deps.mac!.extractZip(zip, folder);
        // The folder looks like the disk image's window: the app next to a link to Applications.
        await symlink("/Applications", join(folder, "Applications"));
      } catch {
        throw new InstallError("handover");
      }
      verified = { path: folder, kind };
      if (await deps.openPath(folder)) throw new InstallError("handover");
      return set({ state: "verified", version: tag, handover: "app-opened" });
    }
    if (kind === "dmg") {
      if (await deps.openPath(dest)) throw new InstallError("handover");
      return set({ state: "verified", version: tag, handover: "dmg-opened" });
    }
    if (kind === "deb") {
      deps.showItemInFolder(dest);
      return set({ state: "verified", version: tag, handover: "deb-shown" });
    }
    if (kind === "appimage") {
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

  /**
   * Moves a verified zip into the keep folder with its blockmap, replacing the previous pair, and returns its new path.
   * The old blockmap goes first, so a failure part-way leaves a zip without a blockmap, which the next update ignores.
   * If the move fails, the zip stays in the downloads folder and the next update downloads the whole file.
   */
  async function keepZip(zip: string, blockMap: Buffer): Promise<string> {
    let moved = false;
    try {
      await mkdir(deps.mac!.keepDir, { recursive: true });
      await rm(`${keptZip}.blockmap`, { force: true });
      await rename(zip, keptZip!);
      moved = true;
      await writeFile(`${keptZip}.blockmap.tmp`, blockMap);
      await rename(`${keptZip}.blockmap.tmp`, `${keptZip}.blockmap`);
    } catch (error) {
      deps.log?.(
        `pyxis: update zip not kept (${(error as { code?: string } | null)?.code ?? "unknown"})`,
      );
    }
    return moved ? keptZip! : zip;
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
        cleared = clear();
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
    /** Opens the disk image or the new app's folder again, or shows the downloaded file in its folder again. */
    async reveal(): Promise<void> {
      if (view.state !== "verified" || !verified) return;
      if (verified.kind === "dmg" || verified.kind === "zip") {
        if (await deps.openPath(verified.path))
          throw new Error("update-handover");
      } else deps.showItemInFolder(verified.path);
    },
    /**
     * Closes Pyxis to finish an update: the Windows installer starts after Pyxis has exited, or Pyxis restarts into the
     * replaced AppImage. Workspace work must finish first and running jobs need the student's confirmation. A second
     * call while the first is closing Pyxis does nothing, so one click cannot start two installers.
     */
    async finish(input: {
      workspaceBusy: boolean;
      activeJobs: number;
      confirmed: boolean;
    }): Promise<UpdateFinishResult> {
      const blocked = finishBlock(input);
      if (blocked) return blocked;
      if (finishing) return "done";
      if (view.state !== "verified" || !verified)
        throw new Error("update-not-ready");
      if (view.handover === "exe-ready") {
        finishing = true;
        try {
          // Once Pyxis has quit it cannot say the file is gone, so look now.
          await access(verified.path);
        } catch {
          finishing = false;
          set({ state: "failed", error: "handover" });
          return "done";
        }
        deps.launchAfterQuit(verified.path);
      } else if (view.handover === "appimage-replaced") {
        finishing = true;
        deps.relaunch(verified.path);
      } else if (
        view.handover !== "dmg-opened" &&
        view.handover !== "app-opened"
      )
        throw new Error("update-not-ready");
      deps.quit();
      return "done";
    },
  };
}
