import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import shipped from "../../../resources/model-roles.json";
import { modelFile, resetModelFile, type ModelFile } from "./model-roles";
import { MODEL_FILE_NAME, modelFileBranch, modelFileUrl, syncModelFile } from "./model-roles-sync";

const dirs: string[] = [];
const folder = () => {
  const dir = mkdtempSync(join(tmpdir(), "pyxis-model-roles-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  resetModelFile();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const copy = (): ModelFile => JSON.parse(JSON.stringify(shipped)) as ModelFile;
/** A copy newer than the shipped one, whose fast Claude model is `fast`. */
function newer(fast = "claude-haiku-9"): ModelFile {
  const file = copy();
  file.updatedAt = "2099-01-01T00:00:00Z";
  file.tools.claude!.roles.fast.models = [fast];
  return file;
}
const answer = (body: unknown, init?: ResponseInit) => async () => new Response(typeof body === "string" ? body : JSON.stringify(body), init);
const base = { repository: "SuperTost100/politost-pyxis", version: "0.5.0" };
const fastClaude = () => modelFile().tools.claude!.roles.fast.models[0];

describe("where the model file is fetched from", () => {
  it("asks main for a release and next for a pre-release, over HTTPS on raw.githubusercontent.com, with no query", () => {
    expect(modelFileBranch("0.5.0")).toBe("main");
    expect(modelFileBranch("0.5.0-dev.13")).toBe("next");
    expect(modelFileBranch("0.6.0-rc.1")).toBe("next");
    expect(modelFileBranch("0.5.0+build.7")).toBe("main");
    expect(modelFileUrl(base.repository, "0.5.0")).toBe(
      "https://raw.githubusercontent.com/SuperTost100/politost-pyxis/main/resources/model-roles.json",
    );
    expect(modelFileUrl(base.repository, "0.5.0-dev.13")).toBe(
      "https://raw.githubusercontent.com/SuperTost100/politost-pyxis/next/resources/model-roles.json",
    );
    expect(new URL(modelFileUrl(base.repository, "0.5.0")).search).toBe("");
  });

  it("sends the request to the branch of the running build, with no body, no cookies and no header of its own", async () => {
    const asked: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = (async (url: string, init?: RequestInit) => {
      asked.push({ url, init });
      return new Response(JSON.stringify(copy()));
    }) as unknown as typeof fetch;
    await syncModelFile({ ...base, version: "0.5.0-dev.13", dir: folder(), fetch: fetcher });
    expect(asked.map((call) => call.url)).toEqual([
      "https://raw.githubusercontent.com/SuperTost100/politost-pyxis/next/resources/model-roles.json",
    ]);
    const init = asked[0]!.init!;
    expect(init.headers).toBeUndefined();
    expect(init.body).toBeUndefined();
    expect(init.method).toBeUndefined();
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("keeping the newest valid copy", () => {
  it("takes a newer download, tells the caller, and keeps it in the data folder", async () => {
    const dir = folder();
    const adopted = vi.fn();
    await syncModelFile({ ...base, dir, fetch: answer(newer()) as typeof fetch, onAdopted: adopted });
    expect(fastClaude()).toBe("claude-haiku-9");
    expect(adopted).toHaveBeenCalledTimes(1);
    const stored = JSON.parse(readFileSync(join(dir, MODEL_FILE_NAME), "utf8")) as { checkedAt: number; file: ModelFile };
    expect(stored.file.updatedAt).toBe("2099-01-01T00:00:00Z");
  });

  it("does not let an older download replace the copy shipped with the app", async () => {
    const dir = folder();
    const older = newer("claude-haiku-1");
    older.updatedAt = "2020-01-01T00:00:00Z";
    const adopted = vi.fn();
    await syncModelFile({ ...base, dir, fetch: answer(older) as typeof fetch, onAdopted: adopted });
    expect(fastClaude()).toBe("claude-haiku-5-5");
    expect(adopted).not.toHaveBeenCalled();
  });

  it("falls back to the shipped copy for a download that is missing, unknown or broken", async () => {
    const responses: Array<() => Promise<Response>> = [
      async () => new Response("", { status: 404 }),
      async () => new Response("<html>rate limited</html>", { status: 200 }),
      async () => new Response(JSON.stringify({ ...newer(), version: 2 })),
      async () => new Response(JSON.stringify({ version: 1 })),
      async () => new Response(JSON.stringify(null)),
      async () => {
        throw new TypeError("fetch failed");
      },
      async () => new Response("x".repeat(300 * 1024)),
    ];
    for (const response of responses) {
      const adopted = vi.fn();
      await syncModelFile({ ...base, dir: folder(), fetch: response as typeof fetch, onAdopted: adopted });
      expect(fastClaude()).toBe("claude-haiku-5-5");
      expect(adopted).not.toHaveBeenCalled();
    }
  });

  it("refuses a redirect and a response without a body", async () => {
    await syncModelFile({ ...base, dir: folder(), fetch: (async () => Response.redirect("https://example.com/x", 302)) as typeof fetch });
    await syncModelFile({ ...base, dir: folder(), fetch: (async () => new Response(null, { status: 200 })) as typeof fetch });
    expect(fastClaude()).toBe("claude-haiku-5-5");
  });

  it("uses the stored copy at the next start without the network, and an app update that ships a newer file beats it", async () => {
    const dir = folder();
    await syncModelFile({ ...base, dir, fetch: answer(newer("claude-haiku-9")) as typeof fetch });
    resetModelFile();
    expect(fastClaude()).toBe("claude-haiku-5-5");
    await syncModelFile({ ...base, dir, fetch: null });
    expect(fastClaude()).toBe("claude-haiku-9");
    // A stored copy older than the one now in use is ignored: a newer app brought a newer file.
    resetModelFile();
    const stale = newer("claude-haiku-2");
    stale.updatedAt = "2000-01-01T00:00:00Z";
    writeFileSync(join(dir, MODEL_FILE_NAME), JSON.stringify({ checkedAt: 0, file: stale }));
    await syncModelFile({ ...base, dir, fetch: null });
    expect(fastClaude()).toBe("claude-haiku-5-5");
  });

  it("reads a stored file that is damaged as no file", async () => {
    const dir = folder();
    writeFileSync(join(dir, MODEL_FILE_NAME), "{not json");
    await syncModelFile({ ...base, dir, fetch: null });
    expect(fastClaude()).toBe("claude-haiku-5-5");
  });
});

describe("how often it asks", () => {
  it("makes no request without a network, and none within a day of the last one, then asks again", async () => {
    const dir = folder();
    const fetcher = vi.fn(answer(copy())) as unknown as typeof fetch;
    let now = 1_000_000_000_000;
    const run = () => syncModelFile({ ...base, dir, fetch: fetcher, now: () => now });
    await syncModelFile({ ...base, dir, fetch: null, now: () => now });
    expect(fetcher).not.toHaveBeenCalled();
    await run();
    expect(fetcher).toHaveBeenCalledTimes(1);
    now += 23 * 60 * 60 * 1000;
    await run();
    expect(fetcher).toHaveBeenCalledTimes(1);
    now += 2 * 60 * 60 * 1000;
    await run();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("counts a failed ask too, so an offline start does not retry every few minutes", async () => {
    const dir = folder();
    const fetcher = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const now = () => 1_000_000_000_000;
    await syncModelFile({ ...base, dir, fetch: fetcher, now });
    await syncModelFile({ ...base, dir, fetch: fetcher, now });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("treats a clock set back as a day that has passed", async () => {
    const dir = folder();
    const fetcher = vi.fn(answer(copy())) as unknown as typeof fetch;
    await syncModelFile({ ...base, dir, fetch: fetcher, now: () => 5_000_000_000_000 });
    await syncModelFile({ ...base, dir, fetch: fetcher, now: () => 1_000_000_000_000 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("works with no data folder: it asks, takes the copy, stores nothing", async () => {
    await syncModelFile({ ...base, fetch: answer(newer()) as typeof fetch });
    expect(fastClaude()).toBe("claude-haiku-9");
  });
});
