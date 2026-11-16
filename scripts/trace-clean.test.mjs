import assert from "node:assert/strict";
import test from "node:test";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { withoutLaunchEnvironment } from "../tests/e2e/trace-clean.ts";

const launch = (env) =>
  JSON.stringify({
    version: 10,
    type: "context-options",
    options: { args: ["out/main/index.js"], env },
  });
const click = JSON.stringify({ type: "before", class: "Frame", method: "click", params: { selector: "button" } });
const trace = (...lines) => zipSync({ "trace.trace": strToU8(lines.join("\n")), "trace.network": new Uint8Array() });

test("the launch environment is emptied and the rest of the trace is kept", () => {
  const secret = "ghp_SECRETVALUE123";
  const zip = trace(launch([{ name: "NPM_TOKEN", value: secret }]), click);
  const files = unzipSync(withoutLaunchEnvironment(zip));
  const text = strFromU8(files["trace.trace"]);
  assert.ok(!text.includes(secret));
  assert.ok(!text.includes("NPM_TOKEN"));
  const [first, second] = text.split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(first.options, { args: ["out/main/index.js"], env: [] });
  assert.equal(second.method, "click");
  assert.ok("trace.network" in files);
});

test("a trace without a launch record, or with two, is refused", () => {
  assert.throws(() => withoutLaunchEnvironment(trace(click)), /0 launch options/);
  assert.throws(() => withoutLaunchEnvironment(trace(launch([]), launch([]))), /2 launch options/);
});

test("a zip that is not a trace is refused", () => {
  assert.throws(() => withoutLaunchEnvironment(zipSync({ "other.txt": strToU8("x") })), /no trace.trace/);
});
