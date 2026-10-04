import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { githubRepository, newerStable, releaseChecker } from "./updates";

it("compares stable release semver and accepts only public GitHub metadata", () => {
  expect(
    githubRepository({ url: "git+https://github.com/PoliTost/Pyxis.git" }),
  ).toBe("PoliTost/Pyxis");
  expect(githubRepository("https://github.com.evil.example/a/b")).toBeNull();
  expect(newerStable("v1.10.0", "1.9.99")).toBe(true);
  expect(newerStable("1.0.0", "1.0.0-beta.2")).toBe(true);
  expect(newerStable("1.0.0", "1.0.0")).toBe(false);
  expect(newerStable("1.0.0", "2.0.0")).toBe(false);
  expect(() => newerStable("1.1.0-beta", "1.0.0")).toThrow();
  for (const bad of ["1.1.0+bad_name", "1.1.0+..", "1.1.0+"])
    expect(() => newerStable(bad, "1.0.0")).toThrow();
  for (const bad of ["1.0.0-01", "1.0.0-..", "1.0.0-bad_name"])
    expect(() => newerStable("1.1.0", bad)).toThrow();
});

it("coalesces checks, persists a daily cache, and never fetches without a repository", async () => {
  const root = mkdtempSync(join(tmpdir(), "pyxis-updates-"));
  let now = 1800000000000;
  const fetcher = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          tag_name: "v1.2.0",
          body: "Changes",
          prerelease: false,
          draft: false,
        }),
        { status: 200 },
      ),
  );
  const options = {
    repository: "PoliTost/Pyxis",
    current: "1.1.0",
    cachePath: join(root, "updates.json"),
    fetch: fetcher,
    now: () => now,
  };
  try {
    const check = releaseChecker(options);
    const [a, b] = await Promise.all([check(), check()]);
    expect(a).toEqual(b);
    expect(a.state).toBe("available");
    expect(a.release?.url).toBe(
      "https://github.com/PoliTost/Pyxis/releases/tag/v1.2.0",
    );
    await releaseChecker(options)();
    expect(fetcher).toHaveBeenCalledTimes(1);
    now += 24 * 60 * 60 * 1000;
    await check();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(
      (await releaseChecker({ ...options, repository: null })()).state,
    ).toBe("unpublished");
    expect(fetcher).toHaveBeenCalledTimes(2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("keeps offline failure and unpublished releases within the daily request budget", async () => {
  const root = mkdtempSync(join(tmpdir(), "pyxis-offline-update-"));
  const unavailable = vi.fn(async () => new Response("", { status: 404 }));
  const offline = vi.fn(async () => {
    throw new Error("offline");
  });
  try {
    for (const [fetcher, state] of [
      [unavailable, "unpublished"],
      [offline, "failed"],
    ] as const) {
      const check = releaseChecker({
        repository: "a/b",
        current: "1.0.0",
        cachePath: join(root, `${state}.json`),
        fetch: fetcher,
      });
      expect((await check()).state).toBe(state);
      await check();
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("keeps the daily request budget in memory when the cache cannot be written", async () => {
  const root = mkdtempSync(join(tmpdir(), "pyxis-update-cache-failure-"));
  const blocker = join(root, "not-a-directory");
  writeFileSync(blocker, "block cache directory creation");
  try {
    for (const state of [
      "available",
      "current",
      "failed",
      "unpublished",
    ] as const) {
      let now = 1800000000000;
      const fetcher = vi.fn(async () => {
        if (state === "failed") throw new Error("offline");
        if (state === "unpublished") return new Response("", { status: 404 });
        return new Response(
          JSON.stringify({
            tag_name: state === "available" ? "v1.2.0" : "v1.0.0",
            body: "Notes",
            draft: false,
            prerelease: false,
          }),
          { status: 200 },
        );
      });
      const check = releaseChecker({
        repository: "a/b",
        current: "1.0.0",
        cachePath: join(blocker, `${state}.json`),
        fetch: fetcher,
        now: () => now,
      });
      const [first, concurrent] = await Promise.all([check(), check()]);
      expect(first.state).toBe(state);
      expect(concurrent).toEqual(first);
      expect(await check()).toEqual(first);
      now += 24 * 60 * 60 * 1000 - 1;
      expect(await check()).toEqual(first);
      expect(fetcher).toHaveBeenCalledTimes(1);
      now += 1;
      const [next, nextConcurrent] = await Promise.all([check(), check()]);
      expect(next.state).toBe(state);
      expect(nextConcurrent).toEqual(next);
      expect(next.checkedAt).toBe(now);
      expect(fetcher).toHaveBeenCalledTimes(2);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("reconstructs cached release URLs and discards malformed cached notes", async () => {
  const root = mkdtempSync(join(tmpdir(), "pyxis-cache-trust-"));
  const path = join(root, "updates.json");
  const fetcher = vi.fn(
    async () =>
      new Response(JSON.stringify({ tag_name: "1.1.0", body: "Checked" })),
  );
  try {
    const options = {
      repository: "a/b",
      current: "1.0.0",
      cachePath: path,
      fetch: fetcher,
    };
    const cached = {
      key: "a/b@1.0.0",
      view: {
        state: "available",
        current: "1.0.0",
        checkedAt: Date.now(),
        release: {
          version: "1.1.0",
          notes: "Safe",
          url: "https://evil.example/",
        },
      },
    };
    writeFileSync(path, JSON.stringify(cached));
    expect((await releaseChecker(options)()).release?.url).toBe(
      "https://github.com/a/b/releases/tag/1.1.0",
    );
    expect(fetcher).not.toHaveBeenCalled();
    writeFileSync(
      path,
      JSON.stringify({
        ...cached,
        view: {
          ...cached.view,
          release: { ...cached.view.release, notes: 42 },
        },
      }),
    );
    expect((await releaseChecker(options)()).release?.notes).toBe("Checked");
    expect(fetcher).toHaveBeenCalledTimes(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
