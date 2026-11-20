import { expect, test } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { launchPyxis } from "./app-under-test";
import { removeTestFolder } from "./cleanup";
import { fromChiediToExams } from "./doors";
import { seedPlan } from "./seed";
import { saveShot } from "./shots";
import { standInTools } from "./tools";

test.describe("a tool Pyxis no longer offers, in the records it answered", () => {
  test.skip(process.platform === "win32", "stand-in CLIs are shell scripts");
  test.setTimeout(180000);

  test("a job Cursor stopped reads as history in Attività: Cursor is named, it is not a tool to wait for or sign in to, and the way on is another tool", async () => {
    const userData = mkdtempSync(join(tmpdir(), "pyxis-retired-history-"));
    const tools = standInTools(["claude"]);
    const app = await launchPyxis({ userData, env: tools.env });
    try {
      const page = await app.firstWindow();
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.getByRole("button", { name: "Salta" }).click();
      await expect(page).toHaveURL(/#\/ask$/);
      // Confirmed before anything else, so no notice covers the page.
      await page.evaluate(() => window.pyxis.invoke("engines.acknowledge", { providers: ["claude"] }));
      await page.reload();
      await fromChiediToExams(page);
      // What an earlier build left: one job stopped by Cursor's usage limit, one by its refused sign-in.
      const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10000 });
      const now = Date.now();
      seedPlan(db, { id: "p", title: "Fisica 1", status: "ready", language: "it" });
      const job = db.prepare(
        "INSERT INTO jobs(id,kind,params_json,state,progress,error,created_at,updated_at) VALUES(?,?,?,'failed',0,?,?,?)",
      );
      job.run("old-limit", "cards-build", JSON.stringify({ planId: "p", topicId: "t" }), "quota [agent]: You have hit your usage limit.", now, now);
      job.run("old-signin", "plan-build", JSON.stringify({ planId: "p" }), "not-logged-in [agent]: 401", now - 1000, now - 1000);
      // And one that was told to wait for Cursor's requests to come back.
      job.run("old-wait", "cards-build", JSON.stringify({ planId: "p", topicId: "t2" }), "quota [agent]: You have hit your usage limit.", now - 2000, now - 2000);
      db.prepare("INSERT INTO settings(key,value_json,updated_at) VALUES('job-wait:old-wait',?,?)").run(
        JSON.stringify({ until: now + 20 * 3600_000, tool: "agent" }),
        now,
      );
      db.close();
      await page.reload();
      await page.getByRole("button", { name: /^(Attività|Background tasks)(:|\s|$)/ }).click();
      const list = page.getByRole("region", { name: /^(Attività|Background tasks)$/ });
      await expect(list).toBeVisible();
      const text = await list.innerText();
      // The tool's name is what it was called, never its internal id.
      expect(text).not.toMatch(/\bagent\b/);
      // It reads as history: what was set to run on Cursor, which Pyxis no longer uses. Nothing says Cursor is out of
      // requests, refused a sign-in or can be waited for or signed in to again.
      await expect(list.getByText(/Cursor, che Pyxis non usa più/).first()).toBeVisible();
      expect(text).not.toMatch(/Cursor ha finito le richieste|Cursor ha rifiutato l'accesso|Accedi a Cursor|tornano le richieste di Cursor/);
      await expect(list.getByRole("button", { name: /^(Aspetta|Wait)/ })).toHaveCount(0);
      await expect(list.getByRole("button", { name: /Accedi a Cursor|Sign in to Cursor/ })).toHaveCount(0);
      // The waiting job says it goes on with another tool, because Pyxis no longer uses Cursor.
      await expect(list.getByText(/con un altro strumento: Pyxis non usa più Cursor/)).toBeVisible();
      // The way on is to try again, which another tool answers, or to look at the tools Pyxis does offer.
      await expect(list.getByRole("button", { name: /^Riprova/ }).first()).toBeVisible();
      await expect(list.getByRole("button", { name: "Strumenti AI" }).first()).toBeVisible();
      await saveShot(page, "retired-tool-jobs-it.png");
    } finally {
      await app.close();
      removeTestFolder(userData);
      rmSync(tools.bin, { recursive: true, force: true });
    }
  });
});
