import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { UpdateView } from "../shared/updates";

const DAY = 24 * 60 * 60 * 1000;
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

export function releaseChecker(input: {
  repository: string | null;
  current: string;
  cachePath: string;
  fetch?: typeof fetch;
  now?: () => number;
}): () => Promise<UpdateView> {
  let pending: Promise<UpdateView> | null = null;
  let recent: UpdateView | undefined;
  const now = input.now ?? Date.now;
  const fetchRelease = input.fetch ?? fetch;
  const key = `${input.repository}@${input.current}`;
  async function check(): Promise<UpdateView> {
    if (!input.repository)
      return { state: "unpublished", current: input.current };
    const at = now();
    if (
      recent?.checkedAt != null &&
      at >= recent.checkedAt &&
      at - recent.checkedAt < DAY
    )
      return recent;
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
        at - view.checkedAt! < DAY &&
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
    let view: UpdateView;
    try {
      const response = await fetchRelease(
        `https://api.github.com/repos/${input.repository}/releases/latest`,
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
      if (response.status === 404)
        view = { state: "unpublished", current: input.current, checkedAt: at };
      else {
        if (!response.ok || !response.body) throw new Error("update-fetch");
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > 1024 * 1024) throw new Error("update-size");
            chunks.push(value);
          }
        } finally {
          await reader.cancel();
        }
        const release = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          tag_name?: unknown;
          body?: unknown;
          draft?: unknown;
          prerelease?: unknown;
        };
        if (
          typeof release.tag_name !== "string" ||
          release.draft === true ||
          release.prerelease === true ||
          (release.body != null && typeof release.body !== "string")
        )
          throw new Error("update-release");
        const available = newerStable(release.tag_name, input.current);
        view = {
          state: available ? "available" : "current",
          current: input.current,
          checkedAt: at,
          ...(available
            ? {
                release: {
                  version: release.tag_name,
                  url: `https://github.com/${input.repository}/releases/tag/${encodeURIComponent(release.tag_name)}`,
                  notes: typeof release.body === "string" ? release.body : "",
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
  return () => {
    if (!pending)
      pending = check().finally(() => {
        pending = null;
      });
    return pending;
  };
}
