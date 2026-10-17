import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hasBlob, putBlob } from "../blobs";
import { openDatabase } from "../db/connection";
import { createPlan } from "../plans/create";
import { exportPlan, importPlan } from "../plans/file";
import { planHandlers } from "../plans/handlers";
import { freeUpSpace } from "./usage";
import { deleteLoosePassages } from "../chat/delete";

type Db = ReturnType<typeof openDatabase>;

const dirs: string[] = [];
const dbs: Db[] = [];
afterEach(() => {
  // Windows refuses to remove a folder while its database is still open.
  for (const db of dbs.splice(0)) if (db.open) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function workspace(): { dir: string; db: Db } {
  const dir = mkdtempSync(join(tmpdir(), "pyxis-free-"));
  dirs.push(dir);
  const db = openDatabase(join(dir, "pyxis.db"));
  dbs.push(db);
  return { dir, db };
}
function blob(dir: string, text: string): string {
  return putBlob(dir, Buffer.from(text), "application/pdf", "pdf");
}
function source(db: Db, id: string, sha: string | null, extra: { library?: 0 | 1; status?: string } = {}) {
  db.prepare(
    "INSERT INTO sources(id,kind,title,blob_sha,mime,status,library,created_at,updated_at) VALUES(?,'pdf',?,?,'application/pdf',?,?,1,1)",
  ).run(id, id, sha, extra.status ?? "ready", extra.library ?? 1);
  db.prepare(
    "INSERT INTO source_documents(id,source_id,version,tree_json,created_at) VALUES(?,?,1,?,1)",
  ).run(`${id}-doc`, id, JSON.stringify(sha ? { blobSha: sha } : {}));
  db.prepare(
    "INSERT INTO passages(id,source_id,document_id,version,text,created_at) VALUES(?,?,?,1,?,1)",
  ).run(`${id}-p`, id, `${id}-doc`, `Testo di ${id}.`);
}

/** A plan file with one embedded original, as another student would share it. */
function sharedPlan(): ReturnType<typeof exportPlan> {
  const { dir, db } = workspace();
  const sha = blob(dir, "il libro condiviso");
  source(db, "book", sha);
  const plan = createPlan(db, { title: "Condiviso", sourceIds: [] });
  db.prepare("INSERT INTO plan_sources(plan_id,source_id) VALUES(?,'book')").run(plan.planId);
  db.prepare(
    "INSERT INTO topic_passages(topic_id,passage_id) SELECT id,'book-p' FROM topics WHERE plan_id=?",
  ).run(plan.planId);
  const file = exportPlan(db, plan.planId, { workspace: dir, embed: true });
  expect(file.sources![0]!.data).toBeDefined();
  return file;
}

describe("deleting an imported plan (#111)", () => {
  it("removes the sources and files it brought, and keeps what something else uses", () => {
    const file = sharedPlan();
    const { dir, db } = workspace();
    const plans = planHandlers(db, dir);
    const first = importPlan(db, file, 10_000, dir);
    const second = importPlan(db, file, 20_000, dir);
    const sha = file.sources![0]!.sha!;
    expect(db.prepare("SELECT COUNT(*) FROM sources WHERE library=0").pluck().get()).toBe(2);

    plans.delete({ planId: first });
    // The second copy still names the same file.
    expect(db.prepare("SELECT COUNT(*) FROM sources WHERE library=0").pluck().get()).toBe(1);
    expect(hasBlob(dir, sha)).toBe(true);

    plans.delete({ planId: second });
    expect(db.prepare("SELECT COUNT(*) FROM sources").pluck().get()).toBe(0);
    expect(db.prepare("SELECT COUNT(*) FROM passages").pluck().get()).toBe(0);
    expect(hasBlob(dir, sha)).toBe(false);
  });

  it("removes an imported smartbook with its book row", () => {
    const file = sharedPlan();
    file.sources![0]!.kind = "smartbook";
    const { dir, db } = workspace();
    const planId = importPlan(db, file, 10_000, dir);
    expect(db.prepare("SELECT COUNT(*) FROM smartbooks").pluck().get()).toBe(1);
    planHandlers(db, dir).delete({ planId });
    expect(db.prepare("SELECT COUNT(*) FROM smartbooks").pluck().get()).toBe(0);
    expect(db.prepare("SELECT COUNT(*) FROM sources").pluck().get()).toBe(0);
    expect(hasBlob(dir, file.sources![0]!.sha!)).toBe(false);
  });

  it("keeps an imported source a chat still lists or cites", () => {
    const file = sharedPlan();
    const { dir, db } = workspace();
    const planId = importPlan(db, file, 10_000, dir);
    const sourceId = db.prepare("SELECT source_id FROM plan_sources WHERE plan_id=?").pluck().get(planId) as string;
    db.prepare("INSERT INTO chats(id,title,scope_json,created_at,updated_at) VALUES('c',NULL,?,1,1)").run(
      JSON.stringify({ planId, sourceIds: [sourceId] }),
    );
    planHandlers(db, dir).delete({ planId });
    expect(db.prepare("SELECT COUNT(*) FROM sources WHERE id=?").pluck().get(sourceId)).toBe(1);
    expect(hasBlob(dir, file.sources![0]!.sha!)).toBe(true);
  });

  it("keeps a library source the plan used", () => {
    const { dir, db } = workspace();
    const sha = blob(dir, "libreria");
    source(db, "lib", sha);
    const plan = createPlan(db, { title: "Mio", sourceIds: [] });
    db.prepare("INSERT INTO plan_sources(plan_id,source_id) VALUES(?,'lib')").run(plan.planId);
    planHandlers(db, dir).delete({ planId: plan.planId });
    expect(db.prepare("SELECT COUNT(*) FROM sources").pluck().get()).toBe(1);
    expect(hasBlob(dir, sha)).toBe(true);
  });
});

describe("quotes without a source (#111)", () => {
  it("deletes one nothing cites, and keeps one a generated exercise's locator names", () => {
    const { db } = workspace();
    for (const id of ["loose", "named", "first"])
      db.prepare("INSERT INTO passages(id,source_id,version,text,created_at) VALUES(?,NULL,1,'Citazione.',1)").run(id);
    db.prepare(
      "INSERT INTO exercises(id,smartbook_id,passage_id,prompt,answer,locator_json,created_at) VALUES('gen',NULL,'first','Quanto?','2',?,1)",
    ).run(JSON.stringify({ kind: "generated", topicId: "t", passageIds: ["first", "named"] }));
    deleteLoosePassages(db, ["loose", "named"]);
    expect(db.prepare("SELECT id FROM passages ORDER BY id").pluck().all()).toEqual(["first", "named"]);
  });
});

describe("free up space (#111)", () => {
  it("removes files nothing names and says how much it freed", () => {
    const { dir, db } = workspace();
    const kept = {
      source: blob(dir, "fonte"),
      version: blob(dir, "versione precedente"),
      attachment: blob(dir, "foto"),
      retry: blob(dir, "estrazione da riprovare"),
      step: blob(dir, "uscita di un passo"),
    };
    source(db, "s", kept.source);
    db.prepare("UPDATE source_documents SET tree_json=? WHERE id='s-doc'").run(
      JSON.stringify({ blobSha: kept.source, sourceSha: kept.version }),
    );
    db.prepare("INSERT INTO chats(id,title,created_at,updated_at) VALUES('c',NULL,1,1)").run();
    db.prepare("INSERT INTO messages(id,chat_id,role,body,created_at) VALUES('m','c','user','foto',1)").run();
    db.prepare("INSERT INTO attachments(id,message_id,blob_sha,mime,created_at) VALUES('a','m',?,'image/png',1)").run(
      kept.attachment,
    );
    // A failed import can be retried, and the retry reads its extraction again.
    db.prepare("INSERT INTO jobs(id,kind,params_json,state,created_at,updated_at) VALUES('j1','source-import',?,'failed',1,1)").run(
      JSON.stringify({ sourceId: "s", extractedSha: kept.retry }),
    );
    db.prepare("INSERT INTO jobs(id,kind,params_json,state,created_at,updated_at) VALUES('j2','source-import','{}','interrupted',1,1)").run();
    db.prepare(
      "INSERT INTO job_steps(id,job_id,name,position,label,state,output_json) VALUES('j2s','j2','extract',0,'x','succeeded',?)",
    ).run(JSON.stringify({ extractedSha: kept.step }));
    const done = blob(dir, "estrazione di un import finito");
    db.prepare("INSERT INTO jobs(id,kind,params_json,state,created_at,updated_at) VALUES('j3','source-import',?,'succeeded',1,1)").run(
      JSON.stringify({ sourceId: "s", extractedSha: done }),
    );
    const orphan = blob(dir, "nessuno lo usa");
    const leftover = join(dir, "blobs", orphan.slice(0, 2), `.${orphan}.0b9c3e5a-1d2f-4a6b-8c7d-9e0f1a2b3c4d.tmp`);
    writeFileSync(leftover, "xx");
    const unrelated = join(dir, "blobs", "note.txt");
    writeFileSync(unrelated, "non un blob");

    const freed = freeUpSpace(db, dir);
    for (const [name, sha] of Object.entries(kept)) expect(hasBlob(dir, sha), name).toBe(true);
    expect(hasBlob(dir, done)).toBe(false);
    expect(hasBlob(dir, orphan)).toBe(false);
    expect(existsSync(leftover)).toBe(false);
    expect(existsSync(unrelated)).toBe(true);
    expect(freed.bytes).toBeGreaterThanOrEqual(
      Buffer.byteLength("estrazione di un import finito") + Buffer.byteLength("nessuno lo usa") + 2,
    );
    expect(freeUpSpace(db, dir).bytes).toBe(0);
  });

  it("removes sources a plan deleted before this left behind, and removed sources nothing cites", () => {
    const { dir, db } = workspace();
    const hidden = blob(dir, "copia nascosta");
    source(db, "hidden", hidden, { library: 0 });
    const removed = blob(dir, "fonte rimossa");
    source(db, "removed", removed, { status: "removed" });
    const cited = blob(dir, "fonte rimossa ma citata");
    source(db, "cited", cited, { status: "removed" });
    const plan = createPlan(db, { title: "Cita", sourceIds: [] });
    db.prepare(
      "INSERT INTO items(id,plan_id,topic_id,kind,body_json,created_at) VALUES('lesson',?,NULL,'lesson','{\"markdown\":\"x\"}',1)",
    ).run(plan.planId);
    db.prepare("INSERT INTO item_passages(item_id,passage_id) VALUES('lesson','cited-p')").run();
    const listed = blob(dir, "allegato in chat");
    source(db, "listed", listed, { library: 0 });
    db.prepare("INSERT INTO chats(id,title,scope_json,created_at,updated_at) VALUES('c',NULL,'[\"listed\"]',1,1)").run();

    freeUpSpace(db, dir);
    const ids = db.prepare("SELECT id FROM sources ORDER BY id").pluck().all();
    expect(ids).toEqual(["cited", "listed"]);
    expect(hasBlob(dir, hidden)).toBe(false);
    expect(hasBlob(dir, removed)).toBe(false);
    expect(hasBlob(dir, cited)).toBe(true);
    expect(hasBlob(dir, listed)).toBe(true);
    expect(db.prepare("SELECT COUNT(*) FROM passages WHERE source_id IN ('hidden','removed')").pluck().get()).toBe(0);
  });

  it("keeps a source whose passages only JSON names: an exercise's locator or a lesson's citation order", () => {
    const { dir, db } = workspace();
    for (const id of ["first", "second", "ordered", "unused"]) source(db, id, blob(dir, id), { library: 0 });
    const plan = createPlan(db, { title: "Resta", sourceIds: [] });
    const topic = db.prepare("SELECT id FROM topics WHERE plan_id=?").pluck().get(plan.planId) as string | undefined;
    // A generated exercise keeps only its first passage in the passage_id column.
    db.prepare(
      "INSERT INTO exercises(id,smartbook_id,passage_id,prompt,answer,locator_json,created_at) VALUES('gen',NULL,'first-p','Quanto?','2',?,1)",
    ).run(JSON.stringify({ kind: "generated", topicId: topic ?? "t", passageIds: ["first-p", "second-p"] }));
    db.prepare(
      "INSERT INTO items(id,plan_id,topic_id,kind,body_json,created_at) VALUES('lesson',?,NULL,'lesson',?,1)",
    ).run(plan.planId, JSON.stringify({ markdown: "Vedi [P1].", passageIds: ["ordered-p"] }));
    freeUpSpace(db, dir);
    expect(db.prepare("SELECT id FROM sources ORDER BY id").pluck().all()).toEqual(["first", "ordered", "second"]);
    expect(db.prepare("SELECT COUNT(*) FROM passages").pluck().get()).toBe(3);
  });

  it("keeps an imported smartbook while a surviving item names one of its exercises", () => {
    const { dir, db } = workspace();
    for (const id of ["named", "free"]) {
      source(db, id, blob(dir, id), { library: 0 });
      db.prepare("INSERT INTO smartbooks(id,source_id,meta_json,created_at) VALUES(?,?,'{}',1)").run(`${id}-book`, id);
      db.prepare(
        "INSERT INTO exercises(id,smartbook_id,prompt,answer,locator_json,created_at) VALUES(?,?,'Quanto?','2','{\"chapter\":1}',1)",
      ).run(`${id}-ex`, `${id}-book`);
    }
    const plan = createPlan(db, { title: "Esercizi", sourceIds: [] });
    db.prepare(
      "INSERT INTO items(id,plan_id,topic_id,kind,body_json,created_at) VALUES('lesson',?,NULL,'lesson',?,1)",
    ).run(plan.planId, JSON.stringify({ markdown: ':::exercise{id="named-ex"}\nQuanto?\n:::' }));
    freeUpSpace(db, dir);
    expect(db.prepare("SELECT id FROM sources").pluck().all()).toEqual(["named"]);
    expect(db.prepare("SELECT id FROM exercises").pluck().all()).toEqual(["named-ex"]);
  });

  it("works on a workspace with no files yet", () => {
    const { dir, db } = workspace();
    rmSync(join(dir, "blobs"), { recursive: true, force: true });
    expect(freeUpSpace(db, dir)).toEqual({ bytes: 0 });
  });
});
