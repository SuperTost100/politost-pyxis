import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { strToU8, unzipSync, zipSync, strFromU8 } from "fflate";
import { withoutLaunchEnvironment } from "../tests/e2e/trace-clean.ts";
import { saveTrace as save } from "../tests/e2e/trace-save.ts";

const saveTrace = (options) => save({ clean: withoutLaunchEnvironment, ...options });

const SECRET = "ghp_SECRETVALUE123";
const rawTrace = () =>
  zipSync({
    "trace.trace": strToU8(
      [
        JSON.stringify({ type: "context-options", options: { args: ["main.js"], env: [{ name: "NPM_TOKEN", value: SECRET }] } }),
        JSON.stringify({ type: "before", method: "click" }),
      ].join("\n"),
    ),
  });

/** A results folder that `attach` copies into, as Playwright copies an attachment, and what stop saw as the raw path. */
function setup() {
  const results = mkdtempSync(join(tmpdir(), "pyxis-results-test-"));
  const seen = { raw: "" };
  const attach = async (path) => copyFileSync(path, join(results, "attachment.zip"));
  return { results, seen, attach, done: () => rmSync(results, { recursive: true, force: true }) };
}

/** Every file under `folder` holds neither the secret nor its variable's name, in a zip or outside one. */
function assertClean(folder) {
  for (const name of readdirSync(folder, { recursive: true })) {
    const path = join(folder, name);
    if (!statSync(path).isFile()) continue;
    const bytes = readFileSync(path);
    const text = name.endsWith(".zip") ? Object.values(unzipSync(bytes)).map(strFromU8).join("\n") : bytes.toString("latin1");
    assert.ok(!text.includes(SECRET) && !text.includes("NPM_TOKEN"), `${name} holds the environment`);
  }
}

test("a trace that is saved and then rejected is cleaned, attached, and leaves no raw zip anywhere", async () => {
  const { results, seen, attach, done } = setup();
  try {
    await assert.rejects(
      saveTrace({
        stop: async (path) => {
          seen.raw = path;
          writeFileSync(path, rawTrace());
          throw new Error("Target page, context or browser has been closed");
        },
        attach,
        maxBytes: 1e6,
      }),
      /has been closed/,
    );
    assert.ok(!seen.raw.startsWith(results), "the raw zip is written outside the results folder");
    assert.deepEqual(readdirSync(results), ["attachment.zip"]);
    assertClean(results);
    assert.ok(!existsSync(dirname(seen.raw)), "the folder of the raw zip is removed");
    assert.equal(JSON.parse(strFromU8(unzipSync(readFileSync(join(results, "attachment.zip")))["trace.trace"]).split("\n")[0]).options.env.length, 0);
  } finally {
    done();
  }
});

test("a trace that stops cleanly is attached once, cleaned", async () => {
  const { results, seen, attach, done } = setup();
  try {
    const kept = await saveTrace({ stop: async (path) => ((seen.raw = path), writeFileSync(path, rawTrace())), attach, maxBytes: 1e6 });
    assert.equal(kept, true);
    assert.deepEqual(readdirSync(results), ["attachment.zip"]);
    assertClean(results);
    assert.ok(!existsSync(dirname(seen.raw)));
  } finally {
    done();
  }
});

test("a stop that fails before saving attaches nothing and leaves nothing", async () => {
  const { results, seen, attach, done } = setup();
  try {
    await assert.rejects(saveTrace({ stop: async (path) => ((seen.raw = path), Promise.reject(new Error("gone"))), attach, maxBytes: 1e6 }), /gone/);
    assert.deepEqual(readdirSync(results), []);
    assert.ok(!existsSync(dirname(seen.raw)));
  } finally {
    done();
  }
});

test("a zip that cannot be cleaned is not attached, and the raw zip is gone", async () => {
  const { results, seen, attach, done } = setup();
  try {
    await assert.rejects(
      saveTrace({ stop: async (path) => ((seen.raw = path), writeFileSync(path, zipSync({ "other.txt": strToU8(SECRET) }))), attach, maxBytes: 1e6 }),
      /no trace.trace/,
    );
    assert.deepEqual(readdirSync(results), []);
    assert.ok(!existsSync(dirname(seen.raw)));
  } finally {
    done();
  }
});

test("a trace above the size limit is not attached", async () => {
  const { results, seen, attach, done } = setup();
  try {
    const kept = await saveTrace({ stop: async (path) => ((seen.raw = path), writeFileSync(path, rawTrace())), attach, maxBytes: 10 });
    assert.equal(kept, false);
    assert.deepEqual(readdirSync(results), []);
    assert.ok(!existsSync(dirname(seen.raw)));
  } finally {
    done();
  }
});
