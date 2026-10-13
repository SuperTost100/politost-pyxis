import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";

const CHUNK = 64 * 1024;

/**
 * The fake-release seam for end-to-end tests, or null. A packaged app never uses it, even with `PYXIS_E2E=1`: it must
 * not fetch from a fake release or replace a file because of environment variables.
 */
export function updateSeam(
  env: NodeJS.ProcessEnv,
  packaged: boolean,
): { fetch: typeof fetch; appImage?: string } | null {
  if (packaged || !env["PYXIS_E2E_RELEASE"]) return null;
  return {
    fetch: fixtureFetch({
      release: JSON.parse(env["PYXIS_E2E_RELEASE"]),
      assets: env["PYXIS_E2E_UPDATE_ASSETS"],
      hold: env["PYXIS_E2E_UPDATE_HOLD"],
    }),
    appImage: env["PYXIS_E2E_APPIMAGE"],
  };
}

/**
 * End-to-end tests only: a stand-in for GitHub. The releases API answers with `release`, a release download redirects
 * to the release-asset host the way GitHub does, and that host serves files from `assets`. While the `hold` file
 * exists the last chunk of a file longer than one chunk waits, so a test can see a download in progress.
 */
export function fixtureFetch(input: {
  release: unknown;
  assets?: string;
  hold?: string;
}): typeof fetch {
  return async (resource, init) => {
    const url = new URL(
      resource instanceof Request ? resource.url : String(resource),
    );
    if (url.hostname === "api.github.com")
      return new Response(JSON.stringify(input.release), { status: 200 });
    const name = basename(decodeURIComponent(url.pathname));
    if (url.hostname === "github.com")
      return new Response(null, {
        status: 302,
        headers: {
          location: `https://release-assets.githubusercontent.com/fixture/${encodeURIComponent(name)}`,
        },
      });
    if (
      url.hostname !== "release-assets.githubusercontent.com" ||
      !input.assets
    )
      throw new TypeError("fetch failed");
    let bytes: Buffer;
    try {
      bytes = await readFile(join(input.assets, name));
    } catch {
      return new Response("", { status: 404 });
    }
    const signal = init?.signal;
    let offset = 0;
    return new Response(
      new ReadableStream<Uint8Array>({
        async pull(controller) {
          const midway = offset > 0 && offset < bytes.length;
          if (midway && offset + CHUNK >= bytes.length)
            while (input.hold && existsSync(input.hold) && !signal?.aborted)
              await new Promise((resolve) => setTimeout(resolve, 50));
          if (signal?.aborted) return controller.error(signal.reason);
          if (offset >= bytes.length) return controller.close();
          controller.enqueue(bytes.subarray(offset, offset + CHUNK));
          offset += CHUNK;
        },
      }),
      { status: 200, headers: { "content-length": String(bytes.length) } },
    );
  };
}
