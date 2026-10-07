import { _electron as electron, expect, test } from "@playwright/test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { importPickedSource } from "./picked-source";

for (const libraryCopy of [false, true]) {
  test(`chat deletion after a later document attachment keeps library copy: ${libraryCopy}`, async () => {
    const userData = mkdtempSync(join(tmpdir(), "pyxis-chat-delete-"));
    const file = join(userData, "motion.md");
    writeFileSync(
      file,
      "Velocity is displacement divided by elapsed time.\n".repeat(20),
    );
    const env = {
      ...process.env,
      PYXIS_E2E: "1",
      PYXIS_USER_DATA: userData,
      PYXIS_E2E_REPLY: "Velocity is displacement divided by elapsed time [P1].",
    };
    delete env.ELECTRON_RUN_AS_NODE;
    const app = await electron.launch(
      process.env.PYXIS_DIST_APP
        ? {
            executablePath: process.env.PYXIS_DIST_APP,
            args: ["--use-mock-keychain"],
            env,
          }
        : { args: [join(process.cwd(), "out/main/index.js")], env },
    );
    try {
      const page = await app.firstWindow();
      await page.getByRole("button", { name: "Salta", exact: true }).click();
      const first = await page.evaluate(() =>
        window.pyxis.invoke("chats.ask", {
          text: "Hello",
          sourceIds: [],
          allowGeneral: true,
        }),
      );
      await app.evaluate(({ dialog }, path) => {
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [path],
        });
      }, file);
      const picked = await page.evaluate(() =>
        window.pyxis.showOpenDialog({ properties: ["openFile"] }),
      );
      await page.evaluate(
        ({ chatId, path }) =>
          window.pyxis.invoke("chats.ask", {
            chatId,
            text: "What is velocity?",
            sourceIds: [],
            files: [path],
          }),
        { chatId: first.chatId, path: picked![0]! },
      );
      const held = await page.evaluate(
        (chatId) => window.pyxis.invoke("chats.read", { chatId }),
        first.chatId,
      );
      expect(held.held).toHaveLength(1);
      let copyId: string | undefined;
      if (libraryCopy)
        copyId = (await importPickedSource(page, app, file)).sourceId;
      await page.evaluate(
        (chatId) =>
          window.pyxis.invoke("chats.ask", {
            chatId,
            text: "Explain velocity again",
            sourceIds: [],
          }),
        first.chatId,
      );
      expect(
        (
          await page.evaluate(
            (chatId) => window.pyxis.invoke("chats.read", { chatId }),
            first.chatId,
          )
        ).sourceIds,
      ).toContain(held.held[0]!.id);
      const db = new DatabaseSync(join(userData, "workspace/pyxis.db"), {
        timeout: 10000,
      });
      const doc = db
        .prepare("SELECT blob_sha FROM sources WHERE id=?")
        .get(held.held[0]!.id) as { blob_sha: string };
      await page.evaluate(
        (chatId) => window.pyxis.invoke("chats.delete", { chatId }),
        first.chatId,
      );
      expect(
        db.prepare("SELECT COUNT(*) AS n FROM sources WHERE library=0").get(),
      ).toEqual({ n: 0 });
      expect(
        db
          .prepare("SELECT COUNT(*) AS n FROM passages WHERE source_id=?")
          .get(held.held[0]!.id),
      ).toEqual({ n: 0 });
      if (copyId)
        expect(
          db.prepare("SELECT library FROM sources WHERE id=?").get(copyId),
        ).toEqual({ library: 1 });
      expect(
        existsSync(
          join(
            userData,
            "workspace/blobs",
            doc.blob_sha.slice(0, 2),
            doc.blob_sha,
          ),
        ),
      ).toBe(libraryCopy);
      db.close();
    } finally {
      await app.close();
      rmSync(userData, { recursive: true, force: true });
    }
  });
}
