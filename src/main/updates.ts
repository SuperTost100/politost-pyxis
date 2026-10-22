import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { UpdateView } from "../shared/updates";
import { readCapped as readBody } from "../core/sources/public-fetch";

const DAY = 24 * 60 * 60 * 1000;
// GitHub allows 60 unauthenticated requests an hour per address, which a shared campus network uses up. A failed check
// is tried again after 15 minutes instead of blocking the button for a day.
const FAILED_RETRY = 15 * 60 * 1000;
const freshFor = (state: string) => (state === "failed" ? FAILED_RETRY : DAY);
export function githubRepository(value: unknown): string | null {
  const url =
    typeof value === "string"
      ? value
      : value && typeof value === "object" && "url" in value
        ? value.url
        : null;
  if (typeof url !== "string") return null;
  const match = url
    .replace(/^git\+/, "")
    .match(
      /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/,
    );
  return match?.[1] ?? null;
}

// Releases/latest excludes drafts and prereleases. Compare stable tags against
// the installed version, including a prerelease of the same stable version.
export function newerStable(tag: string, current: string): boolean {
  const stable =
    /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
  const installed =
    /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
  const next = tag.match(stable);
  const old = current.match(installed);
  if (!next || !old || tag.length > 200 || current.length > 200)
    throw new Error("update-version");
  if (
    old[4]
      ?.slice(1)
      .split(".")
      .some(
        (part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith("0"),
      )
  )
    throw new Error("update-version");
  for (let i = 1; i <= 3; i++) {
    const a = BigInt(next[i]!);
    const b = BigInt(old[i]!);
    if (a !== b) return a > b;
  }
  return Boolean(old[4]);
}

/** Reads a response body, refusing it once it grows past `cap` bytes. */
export async function readCapped(
  response: Response,
  cap: number,
): Promise<Buffer> {
  if (!response.body) throw new Error("update-fetch");
  const bytes = await readBody(response.body, cap, () => new Error("update-size"));
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export type ReleaseAsset = { name: string; size: number; url: string };
export type LatestRelease = {
  tag: string;
  body: string;
  assets: ReleaseAsset[];
};

/**
 * The repository's latest release from GitHub, or null when it has none. Releases/latest already excludes drafts and
 * prereleases; a response that still claims either is refused. Assets keep only the name, declared size and download
 * URL; callers check the URL before using it.
 */
export async function latestRelease(
  repository: string,
  fetcher: typeof fetch,
): Promise<LatestRelease | null> {
  const response = await fetcher(
    `https://api.github.com/repos/${repository}/releases/latest`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "PoliTost-Pyxis",
      },
      signal: AbortSignal.timeout(7000),
      redirect: "error",
    },
  );
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("update-fetch");
  const release = JSON.parse(
    (await readCapped(response, 1024 * 1024)).toString("utf8"),
  ) as {
    tag_name?: unknown;
    body?: unknown;
    draft?: unknown;
    prerelease?: unknown;
    assets?: unknown;
  };
  if (
    typeof release.tag_name !== "string" ||
    release.draft === true ||
    release.prerelease === true ||
    (release.body != null && typeof release.body !== "string")
  )
    throw new Error("update-release");
  const assets: ReleaseAsset[] = [];
  for (const asset of Array.isArray(release.assets) ? release.assets : []) {
    const {
      name,
      size,
      browser_download_url: url,
    } = (asset ?? {}) as {
      name?: unknown;
      size?: unknown;
      browser_download_url?: unknown;
    };
    if (
      typeof name === "string" &&
      typeof url === "string" &&
      Number.isSafeInteger(size) &&
      (size as number) >= 0
    )
      assets.push({ name, size: size as number, url });
  }
  return {
    tag: release.tag_name,
    body: typeof release.body === "string" ? release.body : "",
    assets,
  };
}

/** A check the student asks for skips the cache, but never calls GitHub more often than this. */
const FORCED_INTERVAL = 60 * 1000;

/**
 * The check behind the Updates page. Automatic calls read the cache (a day, or 15 minutes after a failure). A call with
 * `force` is a student pressing a button: it asks GitHub again, at most once a minute, and otherwise answers as an
 * automatic call would.
 */
export function releaseChecker(input: {
  repository: string | null;
  current: string;
  cachePath: string;
  fetch?: typeof fetch;
  now?: () => number;
}): (force?: boolean) => Promise<UpdateView> {
  let pending: { promise: Promise<UpdateView>; force: boolean } | null = null;
  let recent: UpdateView | undefined;
  let lastForcedAt: number | null = null;
  const now = input.now ?? Date.now;
  const fetchRelease = input.fetch ?? fetch;
  const key = `${input.repository}@${input.current}`;
  async function check(force: boolean): Promise<UpdateView> {
    if (!input.repository)
      return { state: "unpublished", current: input.current };
    const at = now();
    // A clock set back counts as an interval that has passed.
    const refresh =
      force &&
      (lastForcedAt === null ||
        at < lastForcedAt ||
        at - lastForcedAt >= FORCED_INTERVAL);
    if (refresh) lastForcedAt = at;
    if (
      !refresh &&
      recent?.checkedAt != null &&
      at >= recent.checkedAt &&
      at - recent.checkedAt < freshFor(recent.state)
    )
      return recent;
    if (!refresh) {
      try {
        const cache = JSON.parse(await readFile(input.cachePath, "utf8")) as {
          key?: string;
          view?: UpdateView;
        };
        const view = cache.view;
        if (
          cache.key === key &&
          view?.current === input.current &&
          Number.isFinite(view.checkedAt) &&
          at >= view.checkedAt! &&
          at - view.checkedAt! < freshFor(view.state) &&
          ["current", "available", "failed", "unpublished"].includes(view.state)
        ) {
          const cached: UpdateView = {
            state: view.state,
            current: input.current,
            checkedAt: view.checkedAt,
          };
          if (view.state === "available") {
            const release = view.release;
            if (
              !release ||
              typeof release.version !== "string" ||
              typeof release.notes !== "string" ||
              release.notes.length > 1024 * 1024 ||
              !newerStable(release.version, input.current)
            )
              throw new Error("update-cache");
            cached.release = {
              version: release.version,
              notes: release.notes,
              url: `https://github.com/${input.repository}/releases/tag/${encodeURIComponent(release.version)}`,
            };
          }
          return (recent = cached);
        }
      } catch {
        /* A missing cache starts the first check. */
      }
    }
    let view: UpdateView;
    try {
      const release = await latestRelease(input.repository, fetchRelease);
      if (!release)
        view = { state: "unpublished", current: input.current, checkedAt: at };
      else {
        const available = newerStable(release.tag, input.current);
        view = {
          state: available ? "available" : "current",
          current: input.current,
          checkedAt: at,
          ...(available
            ? {
                release: {
                  version: release.tag,
                  url: `https://github.com/${input.repository}/releases/tag/${encodeURIComponent(release.tag)}`,
                  notes: release.body,
                },
              }
            : {}),
        };
      }
    } catch {
      view = { state: "failed", current: input.current, checkedAt: at };
    }
    recent = view;
    try {
      await mkdir(dirname(input.cachePath), { recursive: true });
      const temporary = `${input.cachePath}.tmp`;
      await writeFile(temporary, JSON.stringify({ key, view }));
      await rename(temporary, input.cachePath);
    } catch {
      /* A read-only user-data folder must not block startup. */
    }
    return view;
  }
  return (force = false) => {
    // A running check answers a caller that accepts the cache. A forced call waits for it, then asks GitHub itself.
    if (pending && (!force || pending.force)) return pending.promise;
    const before = pending?.promise;
    const promise: Promise<UpdateView> = (
      before ? before.then(() => check(force)) : check(force)
    ).finally(() => {
      if (pending?.promise === promise) pending = null;
    });
    pending = { promise, force };
    return promise;
  };
}
