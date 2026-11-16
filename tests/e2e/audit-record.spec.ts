import { expect, test } from "@playwright/test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditRecord } from "./audit-record";

const folder = mkdtempSync(join(tmpdir(), "pyxis-audit-record-"));
const file = join(folder, "record.json");
const stored = () => JSON.parse(readFileSync(file, "utf8")) as { run?: string; records: unknown[]; failures: string[] };
const record = (run: string) => new AuditRecord(file, run, { routes: [] });

test.afterAll(() => rmSync(folder, { recursive: true, force: true }));

test("a replacement worker of the same run takes up what the worker before it recorded", () => {
  const first = record("run-1");
  first.resume();
  first.records.push({ name: "root" });
  first.failures.push("root-en-dark-960: Error: broken");
  first.write();

  const second = record("run-1");
  second.resume();
  second.records.push({ name: "exams" });
  second.write();

  expect(stored().records).toEqual([{ name: "root" }, { name: "exams" }]);
  expect(stored().failures).toEqual(["root-en-dark-960: Error: broken"]);
});

test("a record left by an earlier run is not taken up, whichever worker starts the file", () => {
  writeFileSync(file, JSON.stringify({ run: "run-1", records: [{ name: "old" }], failures: ["old: Error"] }));
  const next = record("run-2");
  next.resume();
  next.write();
  expect(stored()).toMatchObject({ run: "run-2", records: [], failures: [] });
});

test("a record with no run, or a run that is not known, is not taken up", () => {
  writeFileSync(file, JSON.stringify({ records: [{ name: "old" }], failures: ["old: Error"] }));
  const unmarked = record("");
  unmarked.resume();
  expect(unmarked.failures).toEqual([]);
  const marked = record("run-3");
  marked.resume();
  expect(marked.failures).toEqual([]);
});

test("nothing is written until the record has been taken up, so a failed setup keeps the last record", () => {
  writeFileSync(file, JSON.stringify({ run: "run-4", records: [{ name: "part 1" }], failures: [] }));
  const replacement = record("run-4");
  replacement.write();
  expect(stored().records).toEqual([{ name: "part 1" }]);
  replacement.resume();
  replacement.write();
  expect(stored().records).toEqual([{ name: "part 1" }]);
});

test("a file that cannot be parsed holds nothing to resume and is written over", () => {
  writeFileSync(file, '{"run": "run-5", "records": [');
  const killed = record("run-5");
  killed.resume();
  killed.records.push({ name: "root" });
  killed.write();
  expect(stored().records).toEqual([{ name: "root" }]);
});
