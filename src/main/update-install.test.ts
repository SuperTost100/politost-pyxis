import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { deflateRawSync, gzipSync } from "node:zlib";
import { afterEach, expect, it, vi } from "vitest";
import type { UpdateInstallView } from "../shared/updates";
import { finishBlock } from "../shared/updates";
import {
  downloadVerified,
  fetchReleaseFile,
  installerAsset,
  parseSha256Sums,
  releaseAssetRedirect,
  releaseDownloadUrl,
  replaceAppImage,
  updateInstaller,
} from "./update-install";
import { updateSeam } from "./update-fixture";

const roots: string[] = [];
function temp(): string {
  const root = mkdtempSync(join(tmpdir(), "pyxis-update-install-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

function body(bytes: Uint8Array, chunk = 1024): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) return controller.close();
      controller.enqueue(bytes.subarray(offset, offset + chunk));
      offset += chunk;
    },
  });
}

it("picks the installer for this computer from the release's dotted asset names", () => {
  expect(
    installerAsset("v0.3.0", { platform: "darwin", arch: "arm64" }),
  ).toEqual({ name: "PoliTost.Pyxis-0.3.0-arm64.dmg", kind: "dmg" });
  expect(installerAsset("v0.3.0", { platform: "darwin", arch: "x64" })).toEqual(
    {
      name: "PoliTost.Pyxis-0.3.0.dmg",
      kind: "dmg",
    },
  );
  expect(installerAsset("v0.3.0", { platform: "win32", arch: "x64" })).toEqual({
    name: "PoliTost.Pyxis.Setup.0.3.0.exe",
    kind: "exe",
  });
  expect(
    installerAsset("v0.3.0", {
      platform: "linux",
      arch: "x64",
      appImage: "/home/s/Apps/PoliTost.Pyxis-0.2.3.AppImage",
    }),
  ).toEqual({ name: "PoliTost.Pyxis-0.3.0.AppImage", kind: "appimage" });
  expect(installerAsset("0.3.0", { platform: "linux", arch: "x64" })).toEqual({
    name: "politost-pyxis_0.3.0_amd64.deb",
    kind: "deb",
  });
  expect(
    installerAsset("v0.3.0", { platform: "win32", arch: "arm64" }),
  ).toBeNull();
  expect(
    installerAsset("v0.3.0", { platform: "linux", arch: "arm64" }),
  ).toBeNull();
  expect(
    installerAsset("v0.3.0", { platform: "freebsd", arch: "x64" }),
  ).toBeNull();
});

it("reads SHA256SUMS lines and maps spaced names to GitHub's dotted asset names", () => {
  const a = "a".repeat(64);
  const b = "B".repeat(64);
  const sums = parseSha256Sums(
    [
      `${a}  PoliTost.Pyxis-0.3.0.AppImage`,
      `${b} *PoliTost Pyxis Setup 0.3.0.exe\r`,
      "not a checksum line",
      `${"c".repeat(63)}  short.dmg`,
      `${a}  twice.deb`,
      `${"d".repeat(64)}  twice.deb`,
      "",
    ].join("\n"),
  );
  expect(sums.get("PoliTost.Pyxis-0.3.0.AppImage")).toBe(a);
  expect(sums.get("PoliTost.Pyxis.Setup.0.3.0.exe")).toBe("b".repeat(64));
  expect(sums.has("short.dmg")).toBe(false);
  // Two different checksums for one file vouch for neither.
  expect(sums.has("twice.deb")).toBe(false);
});

it("accepts only this repository's release downloads and GitHub's release-asset redirects", () => {
  const repo = "SuperTost100/politost-pyxis";
  const name = "PoliTost.Pyxis-0.3.0.AppImage";
  const good = `https://github.com/${repo}/releases/download/v0.3.0/${name}`;
  expect(releaseDownloadUrl(good, repo, name)).toBe(true);
  expect(
    releaseDownloadUrl(
      good.replace("SuperTost100", "supertost100"),
      repo,
      name,
    ),
  ).toBe(true);
  for (const bad of [
    good.replace("https:", "http:"),
    good.replace("github.com", "github.com.evil.example"),
    good.replace("github.com", "github.com:8443"),
    good.replace("https://", "https://user@"),
    good.replace(repo, "Someone/politost-pyxis"),
    good.replace(repo, "SuperTost100/other"),
    `https://github.com/${repo}/releases/download/v0.3.0/other.AppImage`,
    `https://github.com/${repo}/releases/download/v0.3.0/x/${name}`,
    `https://github.com/${repo}/archive/${name}`,
    "not a url",
  ])
    expect(releaseDownloadUrl(bad, repo, name), bad).toBe(false);
  expect(
    releaseAssetRedirect(
      "https://release-assets.githubusercontent.com/github-production-release-asset/1/x?sig=1",
    ),
  ).toBe(true);
  expect(
    releaseAssetRedirect(
      "https://objects.githubusercontent.com/github-production-release-asset-2e65be/1",
    ),
  ).toBe(true);
  for (const bad of [
    "http://release-assets.githubusercontent.com/a",
    "https://release-assets.githubusercontent.com.evil.example/a",
    "https://evil.example/release-assets.githubusercontent.com",
    "https://raw.githubusercontent.com/a/b",
    "https://github.com/SuperTost100/politost-pyxis/releases/download/v1/x",
  ])
    expect(releaseAssetRedirect(bad), bad).toBe(false);
});

it("follows one redirect to the release-asset host and refuses any other hop", async () => {
  const repo = "SuperTost100/politost-pyxis";
  const name = "SHA256SUMS";
  const start = `https://github.com/${repo}/releases/download/v0.3.0/${name}`;
  const asset = "https://release-assets.githubusercontent.com/x/1?sig=a";
  const seen: string[] = [];
  const redirecting = (location: string) =>
    vi.fn(async (url: string | URL | Request) => {
      seen.push(String(url));
      return String(url) === start
        ? new Response(null, { status: 302, headers: { location } })
        : new Response("ok", { status: 200 });
    });
  const signal = new AbortController().signal;
  const ok = await fetchReleaseFile(start, name, {
    repository: repo,
    fetch: redirecting(asset) as typeof fetch,
    signal,
  });
  expect(await ok.text()).toBe("ok");
  expect(seen).toEqual([start, asset]);
  for (const location of [
    "https://evil.example/file",
    "http://release-assets.githubusercontent.com/x",
    "/SuperTost100/politost-pyxis/releases/download/v0.3.0/other",
  ])
    await expect(
      fetchReleaseFile(start, name, {
        repository: repo,
        fetch: redirecting(location) as typeof fetch,
        signal,
      }),
    ).rejects.toMatchObject({ code: "blocked" });
  const never = vi.fn();
  await expect(
    fetchReleaseFile(
      "https://evil.example/SuperTost100/politost-pyxis/releases/download/v0.3.0/SHA256SUMS",
      name,
      { repository: repo, fetch: never as unknown as typeof fetch, signal },
    ),
  ).rejects.toMatchObject({ code: "blocked" });
  expect(never).not.toHaveBeenCalled();
});

it("keeps a download only when its size and SHA-256 match, and deletes it otherwise", async () => {
  const root = temp();
  const bytes = new Uint8Array(5000).map((_, i) => i % 251);
  const dest = join(root, "PoliTost.Pyxis-0.3.0.AppImage");
  const signal = new AbortController().signal;
  const progress: number[] = [];
  await downloadVerified({
    response: new Response(body(bytes)),
    dest,
    size: bytes.length,
    sha256: sha(bytes),
    signal,
    onProgress: (received) => progress.push(received),
  });
  expect(readFileSync(dest)).toEqual(Buffer.from(bytes));
  expect(progress.at(-1)).toBe(5000);
  rmSync(dest);

  const altered = bytes.slice();
  altered[10] = 0;
  await expect(
    downloadVerified({
      response: new Response(body(altered)),
      dest,
      size: bytes.length,
      sha256: sha(bytes),
      signal,
    }),
  ).rejects.toMatchObject({ code: "mismatch" });
  await expect(
    downloadVerified({
      response: new Response(body(bytes)),
      dest,
      size: bytes.length + 1,
      sha256: sha(bytes),
      signal,
    }),
  ).rejects.toMatchObject({ code: "mismatch" });
  await expect(
    downloadVerified({
      response: new Response(body(bytes)),
      dest,
      size: bytes.length - 1,
      sha256: sha(bytes),
      signal,
    }),
  ).rejects.toMatchObject({ code: "mismatch" });
  expect(readdirSync(root)).toEqual([]);
});

it("refuses an installer over the size cap, declared or streamed", async () => {
  const root = temp();
  const bytes = new Uint8Array(4096);
  const dest = join(root, "big.exe");
  const signal = new AbortController().signal;
  await expect(
    downloadVerified({
      response: new Response(body(bytes)),
      dest,
      size: 4096,
      sha256: sha(bytes),
      signal,
      max: 4095,
    }),
  ).rejects.toMatchObject({ code: "too-large" });
  // A response that sends more than the release declared stops at that size, before the rest is written.
  await expect(
    downloadVerified({
      response: new Response(body(new Uint8Array(10_000))),
      dest,
      size: 3000,
      sha256: sha(bytes),
      signal,
      max: 3500,
    }),
  ).rejects.toMatchObject({ code: "mismatch" });
  expect(readdirSync(root)).toEqual([]);
});

it("removes the partial file when the download is cancelled", async () => {
  const root = temp();
  const dest = join(root, "PoliTost.Pyxis-0.3.0.dmg");
  const controller = new AbortController();
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(stream) {
      if (sent === 2) {
        controller.abort();
        stream.error(new DOMException("aborted", "AbortError"));
        return;
      }
      sent++;
      stream.enqueue(new Uint8Array(1024));
    },
  });
  await expect(
    downloadVerified({
      response: new Response(stream),
      dest,
      size: 8192,
      sha256: "0".repeat(64),
      signal: controller.signal,
    }),
  ).rejects.toThrow();
  expect(readdirSync(root)).toEqual([]);
});

it("replaces an AppImage in place with an executable copy and leaves no temporary file", async () => {
  const root = temp();
  const apps = join(root, "Applications");
  mkdirSync(apps);
  const running = join(apps, "PoliTost.Pyxis-0.2.3.AppImage");
  writeFileSync(running, "old");
  const downloaded = join(root, "PoliTost.Pyxis-0.3.0.AppImage");
  writeFileSync(downloaded, "new AppImage bytes");
  await replaceAppImage(
    downloaded,
    running,
    sha(Buffer.from("new AppImage bytes")),
  );
  expect(readFileSync(running, "utf8")).toBe("new AppImage bytes");
  if (process.platform !== "win32")
    expect(statSync(running).mode & 0o777).toBe(0o755);
  expect(readdirSync(apps)).toEqual(["PoliTost.Pyxis-0.2.3.AppImage"]);
  // A copy that does not match the verified checksum never replaces the running file.
  await expect(
    replaceAppImage(downloaded, running, "0".repeat(64)),
  ).rejects.toMatchObject({ code: "mismatch" });
  expect(readFileSync(running, "utf8")).toBe("new AppImage bytes");
  expect(readdirSync(apps)).toEqual(["PoliTost.Pyxis-0.2.3.AppImage"]);
});

it("asks to wait for workspace work and to confirm running jobs before Pyxis closes", () => {
  expect(
    finishBlock({ workspaceBusy: true, activeJobs: 0, confirmed: true }),
  ).toBe("workspace-busy");
  expect(
    finishBlock({ workspaceBusy: false, activeJobs: 2, confirmed: false }),
  ).toBe("jobs-running");
  expect(
    finishBlock({ workspaceBusy: false, activeJobs: 2, confirmed: true }),
  ).toBeNull();
  expect(
    finishBlock({ workspaceBusy: false, activeJobs: 0, confirmed: false }),
  ).toBeNull();
});

/**
 * A fake GitHub: release metadata, a redirect for every download and the asset bytes from memory. With `ranges`, the
 * asset host answers a single `bytes=a-b` Range with 206, as GitHub's does; otherwise it ignores Range. `served` counts
 * the bytes sent for every asset but SHA256SUMS.
 */
function fakeGithub(
  files: Record<string, Uint8Array | string>,
  tag = "v0.3.0",
  options: { ranges?: boolean } = {},
) {
  const served = { bytes: 0, ranges: [] as string[] };
  const repo = "SuperTost100/politost-pyxis";
  const assets = Object.entries(files).map(([name, bytes]) => ({
    name,
    size: typeof bytes === "string" ? Buffer.byteLength(bytes) : bytes.length,
    browser_download_url: `https://github.com/${repo}/releases/download/${tag}/${name}`,
  }));
  const fetcher = vi.fn(
    async (resource: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(resource));
      if (url.hostname === "api.github.com")
        return new Response(
          JSON.stringify({
            tag_name: tag,
            draft: false,
            prerelease: false,
            assets,
          }),
        );
      const name = url.pathname.split("/").at(-1)!;
      if (url.hostname === "github.com")
        return new Response(null, {
          status: 302,
          headers: {
            location: `https://release-assets.githubusercontent.com/fixture/${name}`,
          },
        });
      const stored = files[name];
      if (stored == null) return new Response("", { status: 404 });
      const bytes = typeof stored === "string" ? Buffer.from(stored) : stored;
      const range = new Headers(init?.headers)
        .get("range")
        ?.match(/^bytes=(\d+)-(\d+)$/);
      const counted = name !== "SHA256SUMS";
      if (options.ranges && range) {
        const start = Number(range[1]);
        const end = Math.min(Number(range[2]), bytes.length - 1);
        if (counted) served.bytes += end + 1 - start;
        served.ranges.push(`${name} ${start}-${end}`);
        return new Response(body(bytes.subarray(start, end + 1)), {
          status: 206,
          headers: {
            "content-range": `bytes ${start}-${end}/${bytes.length}`,
            "content-length": String(end + 1 - start),
          },
        });
      }
      if (counted) served.bytes += bytes.length;
      return new Response(body(bytes));
    },
  );
  return { repo, fetcher, served };
}

function installer(
  root: string,
  files: Record<string, Uint8Array | string>,
  target: { platform: string; arch: string; appImage?: string },
  options: {
    ranges?: boolean;
    mac?: Parameters<typeof updateInstaller>[0]["mac"];
  } = {},
) {
  const { repo, fetcher, served } = fakeGithub(files, "v0.3.0", options);
  const views: UpdateInstallView[] = [];
  const calls: string[] = [];
  const logs: string[] = [];
  const instance = updateInstaller({
    ...(options.mac ? { mac: options.mac } : {}),
    log: (message) => logs.push(message),
    repository: repo,
    current: "0.2.3",
    dir: join(root, "updates"),
    target,
    fetch: fetcher as typeof fetch,
    emit: (view) => views.push(view),
    openPath: async (path) => {
      calls.push(`open ${path}`);
      return "";
    },
    showItemInFolder: (path) => calls.push(`show ${path}`),
    launchAfterQuit: (path) => {
      calls.push(`launch-after-quit ${path}`);
    },
    relaunch: (path) => calls.push(`relaunch ${path}`),
    quit: () => calls.push("quit"),
  });
  return { instance, views, calls, fetcher, served, logs };
}

it("downloads, verifies and replaces the running AppImage, then restarts only on request", async () => {
  const root = temp();
  const appImage = join(root, "apps", "PoliTost.Pyxis-0.2.3.AppImage");
  mkdirSync(join(root, "apps"));
  writeFileSync(appImage, "old");
  const bytes = new Uint8Array(20_000).map((_, i) => i % 7);
  const name = "PoliTost.Pyxis-0.3.0.AppImage";
  const { instance, views, calls } = installer(
    root,
    {
      [name]: bytes,
      SHA256SUMS: `${sha(bytes)}  ${name}\n${"f".repeat(64)}  politost-pyxis_0.3.0_amd64.deb\n`,
    },
    { platform: "linux", arch: "x64", appImage },
  );
  await instance.start();
  expect(views.some((view) => view.state === "downloading")).toBe(true);
  expect(instance.state()).toEqual({
    state: "verified",
    version: "v0.3.0",
    handover: "appimage-replaced",
  });
  expect(readFileSync(appImage)).toEqual(Buffer.from(bytes));
  expect(calls).toEqual([]);
  expect(existsSync(join(root, "updates", name))).toBe(false);
  expect(
    await instance.finish({
      workspaceBusy: true,
      activeJobs: 0,
      confirmed: false,
    }),
  ).toBe("workspace-busy");
  expect(
    await instance.finish({
      workspaceBusy: false,
      activeJobs: 1,
      confirmed: false,
    }),
  ).toBe("jobs-running");
  expect(calls).toEqual([]);
  expect(
    await instance.finish({
      workspaceBusy: false,
      activeJobs: 1,
      confirmed: true,
    }),
  ).toBe("done");
  expect(calls).toEqual([`relaunch ${appImage}`, "quit"]);
});

it("shows the verified AppImage in its folder when the AppImage's folder is not writable", async () => {
  const root = temp();
  // A path whose parent is a file cannot receive the temporary copy on any platform.
  writeFileSync(join(root, "not-a-folder"), "");
  const appImage = join(root, "not-a-folder", "Pyxis.AppImage");
  const bytes = new Uint8Array(100).fill(3);
  const name = "PoliTost.Pyxis-0.3.0.AppImage";
  const { instance, calls } = installer(
    root,
    { [name]: bytes, SHA256SUMS: `${sha(bytes)}  ${name}\n` },
    { platform: "linux", arch: "x64", appImage },
  );
  await instance.start();
  expect(instance.state()).toMatchObject({ handover: "appimage-folder" });
  expect(calls).toEqual([`show ${join(root, "updates", name)}`]);
  expect(readFileSync(join(root, "updates", name))).toEqual(Buffer.from(bytes));
});

it("opens the disk image, shows the .deb, and hands the Windows installer over to start after Pyxis quits", async () => {
  for (const [target, name, opened, finished] of [
    [
      { platform: "darwin", arch: "arm64" },
      "PoliTost.Pyxis-0.3.0-arm64.dmg",
      "open",
      ["quit"],
    ],
    [
      { platform: "linux", arch: "x64" },
      "politost-pyxis_0.3.0_amd64.deb",
      "show",
      null,
    ],
    [
      { platform: "win32", arch: "x64" },
      "PoliTost.Pyxis.Setup.0.3.0.exe",
      null,
      ["launch-after-quit", "quit"],
    ],
  ] as const) {
    const root = temp();
    const bytes = new Uint8Array(300).fill(9);
    const file = join(root, "updates", name);
    const { instance, calls } = installer(
      root,
      { [name]: bytes, SHA256SUMS: `${sha(bytes)}  ${name}\n` },
      target,
    );
    await instance.start();
    expect(instance.state().state).toBe("verified");
    expect(calls).toEqual(opened ? [`${opened} ${file}`] : []);
    calls.length = 0;
    const result = await instance
      .finish({ workspaceBusy: false, activeJobs: 0, confirmed: false })
      .catch((error: Error) => error.message);
    if (finished) {
      expect(result).toBe("done");
      expect(calls).toEqual(
        finished.map((call) => (call === "quit" ? call : `${call} ${file}`)),
      );
    } else expect(result).toBe("update-not-ready");
  }
});

it("refuses a release with no installer for this computer, no checksum line or a wrong checksum", async () => {
  const bytes = new Uint8Array(300).fill(1);
  const name = "PoliTost.Pyxis.Setup.0.3.0.exe";
  const target = { platform: "win32", arch: "x64" };
  for (const [files, error] of [
    [{ SHA256SUMS: "" }, "no-asset"],
    [{ [name]: bytes }, "no-checksum"],
    [
      { [name]: bytes, SHA256SUMS: `${"0".repeat(64)}  other.exe\n` },
      "no-checksum",
    ],
    [{ [name]: bytes, SHA256SUMS: `${"0".repeat(64)}  ${name}\n` }, "mismatch"],
  ] as const) {
    const root = temp();
    const { instance, calls } = installer(root, files, target);
    await instance.start();
    expect(instance.state()).toEqual({ state: "failed", error });
    expect(calls).toEqual([]);
    expect(
      existsSync(join(root, "updates"))
        ? readdirSync(join(root, "updates"))
        : [],
    ).toEqual([]);
  }
});

it("cancels a running download, deletes the partial file and returns to idle", async () => {
  const root = temp();
  const name = "PoliTost.Pyxis.Setup.0.3.0.exe";
  const bytes = new Uint8Array(4096).fill(2);
  const { repo, fetcher } = fakeGithub({
    [name]: bytes,
    SHA256SUMS: `${sha(bytes)}  ${name}\n`,
  });
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const slow = vi.fn(
    async (resource: string | URL | Request, init?: RequestInit) => {
      const url = String(resource);
      if (!url.includes("/fixture/" + name)) return fetcher(resource);
      let sent = false;
      return new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            if (!sent) {
              sent = true;
              controller.enqueue(bytes.subarray(0, 1024));
              release();
              return;
            }
            await new Promise((resolve, reject) => {
              init?.signal?.addEventListener("abort", () =>
                reject(init.signal!.reason),
              );
            });
          },
        }),
      );
    },
  );
  const views: UpdateInstallView[] = [];
  const instance = updateInstaller({
    repository: repo,
    current: "0.2.3",
    dir: join(root, "updates"),
    target: { platform: "win32", arch: "x64" },
    fetch: slow as typeof fetch,
    emit: (view) => views.push(view),
    openPath: async () => "",
    showItemInFolder: () => {},
    launchAfterQuit: () => {},
    relaunch: () => {},
    quit: () => {},
  });
  const running = instance.start();
  await held;
  await vi.waitFor(() =>
    expect(instance.state()).toMatchObject({
      state: "downloading",
      received: 1024,
    }),
  );
  expect(readdirSync(join(root, "updates"))).toEqual([`${name}.part`]);
  instance.cancel();
  await running;
  expect(instance.state()).toEqual({ state: "idle" });
  expect(existsSync(join(root, "updates"))).toBe(false);
});

it("never downloads when the latest release is not newer than this install", async () => {
  const root = temp();
  const { repo, fetcher } = fakeGithub({ SHA256SUMS: "" }, "v0.2.3");
  const instance = updateInstaller({
    repository: repo,
    current: "0.2.3",
    dir: join(root, "updates"),
    target: { platform: "win32", arch: "x64" },
    fetch: fetcher as typeof fetch,
    emit: () => {},
    openPath: async () => "",
    showItemInFolder: () => {},
    launchAfterQuit: () => {},
    relaunch: () => {},
    quit: () => {},
  });
  await instance.start();
  expect(instance.state()).toEqual({ state: "failed", error: "not-newer" });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("uses the fake-release seam only in an unpackaged build", async () => {
  const env = {
    PYXIS_E2E: "1",
    PYXIS_E2E_RELEASE: JSON.stringify({ tag_name: "v9.0.0", assets: [] }),
    PYXIS_E2E_APPIMAGE: "/tmp/Pyxis.AppImage",
  };
  expect(updateSeam(env, true)).toBeNull();
  expect(updateSeam({ PYXIS_E2E: "1" }, false)).toBeNull();
  const seam = updateSeam(env, false);
  expect(seam?.appImage).toBe("/tmp/Pyxis.AppImage");
  const release = await seam!.fetch(
    "https://api.github.com/repos/PoliTost/pyxis-test/releases/latest",
  );
  expect(((await release.json()) as { tag_name: string }).tag_name).toBe(
    "v9.0.0",
  );
});

it("hands the Windows installer over once, however often the button is pressed", async () => {
  const root = temp();
  const name = "PoliTost.Pyxis.Setup.0.3.0.exe";
  const bytes = new Uint8Array(300).fill(9);
  const { instance, calls } = installer(
    root,
    { [name]: bytes, SHA256SUMS: `${sha(bytes)}  ${name}\n` },
    { platform: "win32", arch: "x64" },
  );
  await instance.start();
  calls.length = 0;
  const input = { workspaceBusy: false, activeJobs: 0, confirmed: false };
  // The second click arrives while the first is still checking the file.
  const results = await Promise.all([
    instance.finish(input),
    instance.finish(input),
  ]);
  expect(results).toEqual(["done", "done"]);
  expect(await instance.finish(input)).toBe("done");
  expect(calls).toEqual([
    `launch-after-quit ${join(root, "updates", name)}`,
    "quit",
  ]);
});

it("does not quit for a Windows update whose installer file is gone", async () => {
  const root = temp();
  const name = "PoliTost.Pyxis.Setup.0.3.0.exe";
  const bytes = new Uint8Array(300).fill(9);
  const { instance, calls } = installer(
    root,
    { [name]: bytes, SHA256SUMS: `${sha(bytes)}  ${name}\n` },
    { platform: "win32", arch: "x64" },
  );
  await instance.start();
  calls.length = 0;
  rmSync(join(root, "updates", name));
  const input = { workspaceBusy: false, activeJobs: 0, confirmed: false };
  expect(await instance.finish(input)).toBe("done");
  expect(instance.state()).toEqual({ state: "failed", error: "handover" });
  expect(calls).toEqual([]);
});

it("ends a download as failed when the downloads folder cannot be cleared, with no unhandled rejection", async () => {
  const root = temp();
  const name = "PoliTost.Pyxis.Setup.0.3.0.exe";
  const bytes = new Uint8Array(300).fill(9);
  const { repo, fetcher } = fakeGithub({
    [name]: bytes,
    SHA256SUMS: `${sha(bytes)}  ${name}\n`,
  });
  const logs: string[] = [];
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown) => rejections.push(reason);
  process.on("unhandledRejection", onRejection);
  try {
    const instance = updateInstaller({
      repository: repo,
      current: "0.2.3",
      dir: join(root, "updates"),
      target: { platform: "win32", arch: "x64" },
      fetch: fetcher as typeof fetch,
      emit: () => {},
      openPath: async () => "",
      showItemInFolder: () => {},
      launchAfterQuit: () => {},
      relaunch: () => {},
      quit: () => {},
      log: (message) => logs.push(message),
      // What Windows does when a scan or an open file holds the folder.
      removeDir: async () => {
        throw Object.assign(new Error("resource busy or locked"), {
          code: "EBUSY",
        });
      },
    });
    await instance.start();
    expect(instance.state()).toEqual({ state: "failed", error: "disk" });
    // Let a rejection nobody awaited reach the process.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(rejections).toEqual([]);
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.every((message) => message.includes("EBUSY"))).toBe(true);
  } finally {
    process.off("unhandledRejection", onRejection);
  }
});

/** Blocks of `size` bytes filled with `seed`, so equal seeds make equal blocks. */
const block = (seed: number, size = 1000) => Buffer.alloc(size, seed);
/** electron-builder's blockmap JSON for `blocks`, with SHA-256 standing in for its BLAKE2 checksums. */
const blockMapJson = (blocks: Buffer[]) =>
  JSON.stringify({
    version: "2",
    files: [
      {
        name: "file",
        offset: 0,
        checksums: blocks.map((b) =>
          createHash("sha256").update(b).digest("base64"),
        ),
        sizes: blocks.map((b) => b.length),
      },
    ],
  });
/** An AppImage as electron-builder writes it: the image, its raw-deflate blockmap, and the blockmap's length. */
function appImageOf(blocks: Buffer[]): { bytes: Buffer; tail: number } {
  const map = deflateRawSync(blockMapJson(blocks));
  const length = Buffer.alloc(4);
  length.writeUInt32BE(map.length);
  return {
    bytes: Buffer.concat([...blocks, map, length]),
    tail: map.length + 4,
  };
}

it("rebuilds the AppImage from the running one, downloading only the changed blocks", async () => {
  const root = temp();
  mkdirSync(join(root, "apps"));
  const appImage = join(root, "apps", "PoliTost.Pyxis-0.2.3.AppImage");
  const old = appImageOf([1, 2, 3, 4, 5, 6].map((seed) => block(seed)));
  const next = appImageOf([1, 2, 9, 4, 5, 6].map((seed) => block(seed)));
  writeFileSync(appImage, old.bytes);
  const name = "PoliTost.Pyxis-0.3.0.AppImage";
  const { instance, views, served, logs } = installer(
    root,
    { [name]: next.bytes, SHA256SUMS: `${sha(next.bytes)}  ${name}\n` },
    { platform: "linux", arch: "x64", appImage },
    { ranges: true },
  );
  await instance.start();
  expect(instance.state()).toMatchObject({ handover: "appimage-replaced" });
  expect(readFileSync(appImage)).toEqual(next.bytes);
  // The trailer, the blockmap and the one changed block: three Range requests.
  expect(served.ranges).toHaveLength(3);
  expect(served.bytes).toBe(next.tail + 1000);
  expect(logs).toEqual([]);
  // Once planned, progress counts the downloaded bytes, not the copied ones.
  const downloading = views.filter((view) => view.state === "downloading");
  const planned = downloading.findIndex((view) => view.total === 1000);
  expect(planned).toBeGreaterThan(0);
  for (const view of downloading.slice(planned))
    expect(view).toMatchObject({ total: 1000 });
  expect(existsSync(join(root, "updates", name))).toBe(false);
});

it("downloads the whole AppImage when the server ignores Range or the rebuilt file does not match", async () => {
  const name = "PoliTost.Pyxis-0.3.0.AppImage";
  const blocks = [1, 2, 3, 4].map((seed) => block(seed));
  const next = appImageOf([1, 2, 9, 4].map((seed) => block(seed)));
  for (const [ranges, installed, reason] of [
    [false, appImageOf(blocks).bytes, "update-diff-range"],
    // The installed file's second block changed after its blockmap was written, so copying it gives wrong bytes.
    [
      true,
      Buffer.concat([
        block(1),
        block(7),
        appImageOf(blocks).bytes.subarray(2000),
      ]),
      "update-diff-mismatch",
    ],
  ] as const) {
    const root = temp();
    const appImage = join(root, "Pyxis.AppImage");
    writeFileSync(appImage, installed);
    const { instance, views, served, logs } = installer(
      root,
      { [name]: next.bytes, SHA256SUMS: `${sha(next.bytes)}  ${name}\n` },
      { platform: "linux", arch: "x64", appImage },
      { ranges },
    );
    await instance.start();
    expect(instance.state(), reason).toMatchObject({
      handover: "appimage-replaced",
    });
    expect(readFileSync(appImage)).toEqual(next.bytes);
    expect(logs).toEqual([
      `pyxis: downloading the whole update file (${reason})`,
    ]);
    expect(served.bytes).toBeGreaterThan(next.bytes.length);
    expect(
      views.filter((view) => view.state === "downloading").at(-1),
    ).toMatchObject({ total: next.bytes.length });
    expect(readdirSync(join(root, "updates"))).toEqual([]);
  }
});

/** A stand-in for ditto: the unpacked folder gets the app bundle as one file holding the zip's bytes. */
function fakeMac(root: string) {
  const unpacked: string[] = [];
  return {
    unpacked,
    mac: {
      keepDir: join(root, "update-base"),
      extractZip: async (zip: string, folder: string) => {
        unpacked.push(zip);
        mkdirSync(folder, { recursive: true });
        writeFileSync(join(folder, "PoliTost Pyxis.app"), readFileSync(zip));
      },
    },
  };
}

it("updates a Mac from the zip: whole the first time and kept, then only the changed blocks", async () => {
  const root = temp();
  const { mac, unpacked } = fakeMac(root);
  const zip = "PoliTost.Pyxis-0.3.0-arm64-mac.zip";
  const dmg = "PoliTost.Pyxis-0.3.0-arm64.dmg";
  const kept = join(root, "update-base", "arm64.zip");
  const folder = join(root, "updates", "PoliTost Pyxis 0.3.0");
  const release = (blocks: Buffer[]) => {
    const bytes = Buffer.concat(blocks);
    const map = gzipSync(blockMapJson(blocks));
    return {
      bytes,
      map,
      files: {
        [zip]: bytes,
        [`${zip}.blockmap`]: map,
        [dmg]: "a disk image",
        SHA256SUMS: `${sha(bytes)}  ${zip}\n${sha(Buffer.from("a disk image"))}  ${dmg}\n`,
      },
    };
  };

  // No kept zip yet: the whole zip, which then stays for the next update.
  const first = release([1, 2, 3, 4, 5].map((seed) => block(seed)));
  const one = installer(
    root,
    first.files,
    { platform: "darwin", arch: "arm64" },
    { ranges: true, mac },
  );
  await one.instance.start();
  expect(one.instance.state()).toEqual({
    state: "verified",
    version: "v0.3.0",
    handover: "app-opened",
  });
  expect(one.served.bytes).toBe(first.map.length + first.bytes.length);
  expect(one.logs).toEqual([
    "pyxis: downloading the whole update file (ENOENT)",
  ]);
  expect(readFileSync(kept)).toEqual(first.bytes);
  expect(readFileSync(`${kept}.blockmap`)).toEqual(first.map);
  expect(unpacked).toEqual([kept]);
  expect(readFileSync(join(folder, "PoliTost Pyxis.app"))).toEqual(first.bytes);
  // Node on Windows stores an absolute link target with the current drive; macOS keeps it as written.
  expect(readlinkSync(join(folder, "Applications"))).toBe(
    process.platform === "win32" ? resolve("/Applications") : "/Applications",
  );
  expect(one.calls).toEqual([`open ${folder}`]);
  await one.instance.reveal();
  expect(one.calls).toEqual([`open ${folder}`, `open ${folder}`]);
  expect(
    await one.instance.finish({
      workspaceBusy: false,
      activeJobs: 0,
      confirmed: false,
    }),
  ).toBe("done");
  expect(one.calls.at(-1)).toBe("quit");

  // The next update starts from the kept zip and fetches the two changed blocks in one range.
  const second = release([1, 8, 9, 4, 5].map((seed) => block(seed)));
  const two = installer(
    root,
    second.files,
    { platform: "darwin", arch: "arm64" },
    { ranges: true, mac },
  );
  await two.instance.start();
  expect(two.instance.state()).toMatchObject({ handover: "app-opened" });
  expect(two.logs).toEqual([]);
  expect(two.served.ranges).toEqual([`${zip} 1000-2999`]);
  expect(two.served.bytes).toBe(second.map.length + 2000);
  expect(readFileSync(kept)).toEqual(second.bytes);
  expect(readFileSync(`${kept}.blockmap`)).toEqual(second.map);
  expect(readFileSync(join(folder, "PoliTost Pyxis.app"))).toEqual(
    second.bytes,
  );
  expect(
    two.views.filter((view) => view.state === "downloading").at(-1),
  ).toMatchObject({ total: 2000 });
});

it("opens the disk image without a zip checksum, keeps no zip without a blockmap, and fails when the zip won't unpack", async () => {
  const zip = "PoliTost.Pyxis-0.3.0-mac.zip";
  const dmg = "PoliTost.Pyxis-0.3.0.dmg";
  const bytes = Buffer.concat([block(1), block(2)]);
  const target = { platform: "darwin", arch: "x64" };

  let root = temp();
  let mac = fakeMac(root).mac;
  const noZipSum = installer(
    root,
    { [zip]: bytes, [dmg]: bytes, SHA256SUMS: `${sha(bytes)}  ${dmg}\n` },
    target,
    { mac },
  );
  await noZipSum.instance.start();
  expect(noZipSum.instance.state()).toMatchObject({ handover: "dmg-opened" });
  expect(noZipSum.calls).toEqual([`open ${join(root, "updates", dmg)}`]);

  root = temp();
  const fake = fakeMac(root);
  const noMap = installer(
    root,
    { [zip]: bytes, SHA256SUMS: `${sha(bytes)}  ${zip}\n` },
    target,
    { mac: fake.mac },
  );
  await noMap.instance.start();
  expect(noMap.instance.state()).toMatchObject({ handover: "app-opened" });
  expect(fake.unpacked).toEqual([join(root, "updates", zip)]);
  expect(existsSync(join(root, "update-base"))).toBe(false);

  root = temp();
  mac = {
    keepDir: join(root, "update-base"),
    extractZip: async () => {
      throw new Error("ditto failed");
    },
  };
  const broken = installer(
    root,
    { [zip]: bytes, SHA256SUMS: `${sha(bytes)}  ${zip}\n` },
    target,
    { mac },
  );
  await broken.instance.start();
  expect(broken.instance.state()).toEqual({
    state: "failed",
    error: "handover",
  });
  expect(broken.calls).toEqual([]);
});
