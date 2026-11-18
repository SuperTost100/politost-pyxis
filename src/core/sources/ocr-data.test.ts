import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { utimesSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../db/connection";
import {
  downloadOcrLanguage,
  OCR_DATA_BASE,
  OCR_DATA_FILES,
  type OcrDataIo,
  ocrConsent,
  ocrDataDir,
  ocrDataStatus,
  readVerifiedOcrData,
  createOcrScratch,
  ocrScratchRoot,
  setOcrConsent,
  sweepStaleOcrScratch,
} from "./ocr-data";

const dirs: string[] = [];
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "pyxis-ocr-data-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
// Injected stand-ins for the pinned files: no network and no real language data.
const fake = {
  eng: Buffer.from("fake english data"),
  ita: Buffer.from("fake italian data, a little longer"),
};
const files = Object.fromEntries(
  Object.entries(fake).map(([code, bytes]) => [
    code,
    { sha256: hash(bytes), size: bytes.length },
  ]),
);
const reply =
  (bytes: Uint8Array, status = 200) =>
  async () =>
    new Response(status === 200 ? bytes : "no", { status });
const signal = () => new AbortController().signal;

describe("OCR language data", () => {
  it("is missing until downloaded, and reads nothing from the network", async () => {
    const tess = scratch();
    expect(await ocrDataStatus(tess, files)).toMatchObject({
      state: "missing",
    });
    await expect(readVerifiedOcrData(tess, ["eng"], files)).rejects.toThrow(
      "ocr-data-missing",
    );
  });

  it("downloads each file bounded, hashes it, and keeps it only if it matches", async () => {
    const tess = scratch();
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      return new Response(fake[url.includes("eng") ? "eng" : "ita"]);
    }) as unknown as typeof fetch;
    for (const lang of ["eng", "ita"])
      await downloadOcrLanguage(tess, lang, signal(), {
        fetchImpl,
        files,
        base: "https://example.test/pin/",
      });
    expect(urls).toEqual([
      "https://example.test/pin/eng.traineddata",
      "https://example.test/pin/ita.traineddata",
    ]);
    expect(await ocrDataStatus(tess, files)).toMatchObject({ state: "ready" });
    expect(readdirSync(ocrDataDir(tess)).sort()).toEqual([
      "eng.traineddata",
      "ita.traineddata",
    ]);
    // Ready files are not fetched again.
    const again = vi.fn(fetchImpl);
    await downloadOcrLanguage(tess, "eng", signal(), {
      fetchImpl: again,
      files,
    });
    expect(again).not.toHaveBeenCalled();
  });

  it("refuses a body with the wrong hash, a short or long body, and leaves nothing on disk", async () => {
    const tess = scratch();
    const wrongHash = Buffer.alloc(fake.eng.length, 1);
    await expect(
      downloadOcrLanguage(tess, "eng", signal(), {
        fetchImpl: reply(wrongHash) as never,
        files,
      }),
    ).rejects.toThrow("ocr-data-integrity");
    await expect(
      downloadOcrLanguage(tess, "eng", signal(), {
        fetchImpl: reply(fake.eng.subarray(0, 5)) as never,
        files,
      }),
    ).rejects.toThrow("ocr-data-integrity");
    await expect(
      downloadOcrLanguage(tess, "eng", signal(), {
        fetchImpl: reply(Buffer.concat([fake.eng, Buffer.from("x")])) as never,
        files,
      }),
    ).rejects.toThrow("ocr-data-too-big");
    expect(
      existsSync(ocrDataDir(tess)) ? readdirSync(ocrDataDir(tess)) : [],
    ).toEqual([]);
  });

  it("says offline, or the HTTP failure, instead of an opaque error", async () => {
    const tess = scratch();
    const offline = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(
      downloadOcrLanguage(tess, "eng", signal(), { fetchImpl: offline, files }),
    ).rejects.toThrow("ocr-data-offline");
    await expect(
      downloadOcrLanguage(tess, "eng", signal(), {
        fetchImpl: reply(fake.eng, 404) as never,
        files,
      }),
    ).rejects.toThrow("ocr-data-download");
    // A connection lost while the body streams is the same offline error.
    const broken = (async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(fake.eng.subarray(0, 3));
            controller.error(new Error("socket hang up"));
          },
        }),
      )) as unknown as typeof fetch;
    await expect(
      downloadOcrLanguage(tess, "eng", signal(), { fetchImpl: broken, files }),
    ).rejects.toThrow("ocr-data-offline");
  });

  it("stops on cancel without calling it offline and without keeping a file", async () => {
    const tess = scratch();
    const controller = new AbortController();
    const slow = (async (_url: string, init: RequestInit) =>
      new Response(
        new ReadableStream({
          start(stream) {
            stream.enqueue(fake.eng.subarray(0, 3));
            init.signal?.addEventListener("abort", () =>
              stream.error(init.signal?.reason),
            );
          },
        }),
      )) as unknown as typeof fetch;
    const pending = downloadOcrLanguage(tess, "eng", controller.signal, {
      fetchImpl: slow,
      files,
    });
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(
      existsSync(ocrDataDir(tess)) ? readdirSync(ocrDataDir(tess)) : [],
    ).toEqual([]);
  });

  it("verifies on every read: an altered or truncated file is `integrity`, and a retry replaces it", async () => {
    const tess = scratch();
    mkdirSync(ocrDataDir(tess), { recursive: true });
    writeFileSync(join(ocrDataDir(tess), "eng.traineddata"), fake.eng);
    const [read] = await readVerifiedOcrData(tess, ["eng"], files);
    expect(read?.code).toBe("eng");
    expect(Buffer.from(read!.data).equals(fake.eng)).toBe(true);
    writeFileSync(
      join(ocrDataDir(tess), "eng.traineddata"),
      Buffer.concat([
        fake.eng.subarray(0, 4),
        Buffer.from("X"),
        fake.eng.subarray(5),
      ]),
    );
    await expect(readVerifiedOcrData(tess, ["eng"], files)).rejects.toThrow(
      "ocr-data-integrity",
    );
    writeFileSync(
      join(ocrDataDir(tess), "eng.traineddata"),
      fake.eng.subarray(0, 4),
    );
    expect(await ocrDataStatus(tess, { eng: files.eng! })).toMatchObject({
      state: "integrity",
    });
    await downloadOcrLanguage(tess, "eng", signal(), {
      fetchImpl: reply(fake.eng) as never,
      files,
    });
    expect(await ocrDataStatus(tess, { eng: files.eng! })).toMatchObject({
      state: "ready",
    });
  });

  describe("a file that is there but cannot be read for a moment", () => {
    const fail = (code: string) => Object.assign(new Error(code), { code });
    /** A file system whose reads fail with `codes` in turn and then read the real file, and a wait that only counts. */
    const flaky = (codes: string[], forever = false) => {
      const waits: number[] = [];
      let reads = 0;
      return {
        waits,
        reads: () => reads,
        io: {
          read: async (path: string) => {
            const code = forever ? codes[0] : codes[reads];
            reads += 1;
            if (code) throw fail(code);
            return readFileSync(path);
          },
          wait: async (ms: number) => void waits.push(ms),
        },
      };
    };
    const withFile = (bytes: Buffer = fake.eng) => {
      const tess = scratch();
      mkdirSync(ocrDataDir(tess), { recursive: true });
      writeFileSync(join(ocrDataDir(tess), "eng.traineddata"), bytes);
      return tess;
    };
    const download = (tess: string, io: OcrDataIo) => {
      const fetchImpl = vi.fn(reply(fake.eng));
      return { fetchImpl, run: () => downloadOcrLanguage(tess, "eng", signal(), { fetchImpl: fetchImpl as never, files, io }) };
    };

    it.each(["EBUSY", "EPERM", "EACCES"])("%s once and then a good read: checked, and nothing is downloaded", async (code) => {
      const tess = withFile();
      const system = flaky([code]);
      const { fetchImpl, run } = download(tess, system.io);
      await run();
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(system.reads()).toBe(2);
      expect(system.waits).toEqual([100]);
      expect(readFileSync(join(ocrDataDir(tess), "eng.traineddata")).equals(fake.eng)).toBe(true);
    });

    it("a read that keeps failing is `unreadable` after a bounded wait: no download, the file untouched, not called altered", async () => {
      const tess = withFile();
      const system = flaky(["EBUSY"], true);
      const { fetchImpl, run } = download(tess, system.io);
      await expect(run()).rejects.toThrow("ocr-data-unreadable");
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(system.waits).toEqual([100, 250, 500, 1000]);
      expect(system.reads()).toBe(5);
      expect(readFileSync(join(ocrDataDir(tess), "eng.traineddata")).equals(fake.eng)).toBe(true);
      expect(readdirSync(ocrDataDir(tess))).toEqual(["eng.traineddata"]);
      await expect(readVerifiedOcrData(tess, ["eng"], files, system.io)).rejects.toThrow("ocr-data-unreadable");
      expect(await ocrDataStatus(tess, { eng: files.eng! }, system.io)).toMatchObject({ state: "unreadable" });
    });

    // Putting the verified file in place is the last step of a repair. On Windows a virus scanner that has just opened the
    // new file makes the rename fail for a moment, as it does a read, and a job that failed there left the file altered and
    // let the next start fetch it a second time.
    const renaming = (codes: string[], forever = false) => {
      let renames = 0;
      const waits: number[] = [];
      return {
        renames: () => renames,
        waits,
        io: {
          wait: async (ms: number) => void waits.push(ms),
          rename: async (from: string, to: string) => {
            const code = forever ? codes[0] : codes[renames];
            renames += 1;
            if (code) throw fail(code);
            renameSync(from, to);
          },
        },
      };
    };

    it.each(["EBUSY", "EPERM", "EACCES"])("%s on the rename of a repaired file, once: tried again, and the file is fetched once", async (code) => {
      const tess = withFile(fake.eng.subarray(0, 4));
      const system = renaming([code]);
      const { fetchImpl, run } = download(tess, system.io);
      await run();
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(system.waits).toEqual([50]);
      expect(readFileSync(join(ocrDataDir(tess), "eng.traineddata")).equals(fake.eng)).toBe(true);
      expect(readdirSync(ocrDataDir(tess))).toEqual(["eng.traineddata"]);
    });

    it("a rename that keeps failing ends after a bounded wait with the system's error, and leaves no staging file behind", async () => {
      const tess = withFile(fake.eng.subarray(0, 4));
      const system = renaming(["EPERM"], true);
      const { fetchImpl, run } = download(tess, system.io);
      await expect(run()).rejects.toThrow("EPERM");
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(system.waits).toEqual([50, 100, 250, 500]);
      expect(system.renames()).toBe(5);
      expect(readdirSync(ocrDataDir(tess))).toEqual(["eng.traineddata"]);
    });

    it("an error that is not a file held for a moment is not tried again", async () => {
      const tess = withFile(fake.eng.subarray(0, 4));
      const system = renaming(["ENOSPC"], true);
      await expect(download(tess, system.io).run()).rejects.toThrow("ENOSPC");
      expect(system.waits).toEqual([]);
      expect(system.renames()).toBe(1);
    });

    it("a language that is not there is still missing and still downloads, whichever way the system says so", async () => {
      for (const code of ["ENOENT", "ENOTDIR"]) {
        const tess = scratch();
        const system = flaky([code], true);
        expect(await ocrDataStatus(tess, { eng: files.eng! }, system.io)).toMatchObject({ state: "missing" });
        expect(system.waits).toEqual([]);
        const fetchImpl = vi.fn(reply(fake.eng));
        await downloadOcrLanguage(tess, "eng", signal(), { fetchImpl: fetchImpl as never, files, io: system.io });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(readFileSync(join(ocrDataDir(tess), "eng.traineddata")).equals(fake.eng)).toBe(true);
      }
    });

    it("a file that reads with the wrong bytes is still altered and still repaired, with no waiting", async () => {
      const tess = withFile(fake.eng.subarray(0, 4));
      const system = flaky([]);
      expect(await ocrDataStatus(tess, { eng: files.eng! }, system.io)).toMatchObject({ state: "integrity" });
      const { fetchImpl, run } = download(tess, system.io);
      await run();
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(system.waits).toEqual([]);
      expect(readFileSync(join(ocrDataDir(tess), "eng.traineddata")).equals(fake.eng)).toBe(true);
    });

    it("names a damaged or absent file before one that could not be read, because a download settles those", async () => {
      const tess = withFile();
      // ita is not there, eng cannot be read: the data is missing, and a download can fetch what is missing.
      const unreadableEng = { read: async () => { throw fail("EBUSY"); }, wait: async () => undefined };
      const io = {
        ...unreadableEng,
        read: async (path: string) => {
          if (path.endsWith("ita.traineddata")) throw fail("ENOENT");
          return unreadableEng.read();
        },
      };
      await expect(readVerifiedOcrData(tess, ["eng", "ita"], files, io)).rejects.toThrow("ocr-data-missing");
    });
  });

  it("does not trust files an older build cached beside the pinned folder", async () => {
    const tess = scratch();
    writeFileSync(join(tess, "eng.traineddata"), fake.eng);
    await expect(readVerifiedOcrData(tess, ["eng"], files)).rejects.toThrow(
      "ocr-data-missing",
    );
  });

  it("refuses a language that has no pin", async () => {
    await expect(
      readVerifiedOcrData(scratch(), ["deu"], files),
    ).rejects.toThrow("ocr-language-unsupported");
    await expect(
      downloadOcrLanguage(scratch(), "deu", signal(), { files }),
    ).rejects.toThrow("ocr-language-unsupported");
  });

  it("keeps the student's answer in settings, on by default", () => {
    const db = openDatabase(":memory:");
    expect(ocrConsent(db)).toBe(true);
    setOcrConsent(db, false);
    expect(ocrConsent(db)).toBe(false);
    setOcrConsent(db, true);
    expect(ocrConsent(db)).toBe(true);
    setOcrConsent(db, false);
    expect(ocrConsent(db)).toBe(false);
    db.close();
  });
});

describe("the declared pin", () => {
  it("names the official tesseract-ocr tessdata_fast commit, not a moving branch or a CDN", () => {
    expect(OCR_DATA_BASE).toBe(
      "https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/87416418657359cb625c412a48b6e1d6d41c29bd/",
    );
    expect(Object.keys(OCR_DATA_FILES)).toEqual(["eng", "ita"]);
  });

  // The artifacts come from a dev download made with the owner's authority (`.tmp/tessdata-fast`, git-ignored). The test
  // compares what the code declares with the real bytes, so a typo in a hash or size cannot pass on fake data alone.
  const local =
    process.env.PYXIS_TEST_TESSDATA ??
    join(import.meta.dirname, "../../../.tmp/tessdata-fast");
  it.skipIf(
    !existsSync(join(local, "eng.traineddata")) ||
      !existsSync(join(local, "ita.traineddata")),
  )("declares the exact size and SHA-256 of the real eng and ita files", () => {
    for (const [code, pinned] of Object.entries(OCR_DATA_FILES)) {
      const bytes = readFileSync(join(local, `${code}.traineddata`));
      expect({ code, size: bytes.length, sha256: hash(bytes) }).toEqual({
        code,
        ...pinned,
      });
    }
  });
});

describe("OCR scratch folders", () => {
  it("a start sweeps what an earlier process left in this workspace's scratch root, and nothing else", () => {
    const base = scratch();
    const tess = join(base, "runtimes", "tesseract");
    const root = ocrScratchRoot(tess);
    const old = join(root, "left-by-a-crash");
    mkdirSync(old, { recursive: true });
    writeFileSync(join(old, "eng.traineddata"), "6.5 MB in real life");
    const past = new Date(Date.now() - 3_600_000);
    utimesSync(old, past, past);
    // A run of this process, started after it, and files that are not scratch at all.
    const running = join(root, "this-process");
    mkdirSync(running);
    mkdirSync(ocrDataDir(tess), { recursive: true });
    writeFileSync(join(ocrDataDir(tess), "eng.traineddata"), "pinned data");
    const outside = join(base, "elsewhere");
    mkdirSync(outside);
    sweepStaleOcrScratch(tess);
    expect(readdirSync(root)).toEqual(["this-process"]);
    expect(existsSync(join(ocrDataDir(tess), "eng.traineddata"))).toBe(true);
    expect(existsSync(outside)).toBe(true);
    // Nothing to sweep is not an error.
    expect(() => sweepStaleOcrScratch(join(base, "none"))).not.toThrow();
  });

  it("never follows a symlinked scratch root or entry, so nothing outside the workspace is deleted", () => {
    const base = scratch();
    const past = new Date(Date.now() - 3_600_000);
    // An old file and an old folder in a folder the student owns elsewhere.
    const outside = join(base, "elsewhere");
    mkdirSync(join(outside, "keep-folder"), { recursive: true });
    writeFileSync(join(outside, "keep.txt"), "mine");
    writeFileSync(join(outside, "keep-folder", "inner.txt"), "mine too");
    utimesSync(join(outside, "keep.txt"), past, past);
    utimesSync(join(outside, "keep-folder"), past, past);
    const intact = () => {
      expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("mine");
      expect(readFileSync(join(outside, "keep-folder", "inner.txt"), "utf8")).toBe("mine too");
    };

    const linkedRoot = join(base, "a", "runtimes", "tesseract");
    mkdirSync(linkedRoot, { recursive: true });
    symlinkSync(outside, ocrScratchRoot(linkedRoot), "dir");
    expect(() => sweepStaleOcrScratch(linkedRoot)).not.toThrow();
    intact();

    // A real root holding links: the links are left, their targets untouched, a plain old entry is still swept.
    const tess = join(base, "b", "runtimes", "tesseract");
    const root = ocrScratchRoot(tess);
    mkdirSync(root, { recursive: true });
    symlinkSync(join(outside, "keep-folder"), join(root, "linked-folder"), "dir");
    symlinkSync(join(outside, "keep.txt"), join(root, "linked-file"));
    mkdirSync(join(root, "stale"));
    utimesSync(join(root, "stale"), past, past);
    sweepStaleOcrScratch(tess);
    intact();
    expect(readdirSync(root).sort()).toEqual(["linked-file", "linked-folder"]);
  });

  it("creates a run's scratch folder in a real root, and refuses a symlinked or non-folder root", async () => {
    const base = scratch();
    const tess = join(base, "runtimes", "tesseract");
    const run = join(ocrScratchRoot(tess), "run-1");
    await createOcrScratch(tess, run);
    expect(existsSync(run)).toBe(true);

    const outside = join(base, "elsewhere");
    mkdirSync(outside);
    const linked = join(base, "linked", "tesseract");
    mkdirSync(linked, { recursive: true });
    symlinkSync(outside, ocrScratchRoot(linked), "dir");
    await expect(createOcrScratch(linked, join(ocrScratchRoot(linked), "run-2"))).rejects.toThrow("ocr-scratch-unsafe");
    expect(readdirSync(outside)).toEqual([]);

    const plain = join(base, "plain", "tesseract");
    mkdirSync(plain, { recursive: true });
    writeFileSync(ocrScratchRoot(plain), "not a folder");
    await expect(createOcrScratch(plain, join(ocrScratchRoot(plain), "run-3"))).rejects.toThrow("ocr-scratch-unsafe");
  });
});
