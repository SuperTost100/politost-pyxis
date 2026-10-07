import {
  _electron as electron,
  expect,
  test,
  type Page,
} from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const MAIN = join(
  process.cwd(),
  process.env.PYXIS_OUT ?? "out",
  "main/index.js",
);

const REPLY = [
  "Per parti usa $\\int u\\,dv = uv - \\int v\\,du$ [P1].",
  "",
  "Poni $u=x$ e $dv=e^{x}dx$, quindi $\\int x e^{x}dx = e^{x}(x-1)+C$.",
].join("\n");

function seed(userData: string) {
  const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"));
  db.exec(`
    INSERT INTO subjects(id,name,position,created_at) VALUES('s-fis','Fisica',0,1);
    INSERT INTO sources(id,kind,title,status,library,created_at,updated_at) VALUES('src-fis','excerpt','Appunti di fisica','ready',1,1,1);
    INSERT INTO source_documents(id,source_id,version,tree_json,created_at) VALUES('d-fis','src-fis',1,'{"kind":"excerpt"}',1);
    INSERT INTO passages(id,source_id,document_id,text,locator_json,section_path,created_at) VALUES('pa1','src-fis','d-fis','Come si risolve un integrale per parti: la formula integrale per parti di u dv vale uv meno integrale di v du.','{"chapter":1,"paragraph":"p1"}','1. Integrali',1);
    INSERT INTO plans(id,subject_id,title,status,content_language,target,created_at,updated_at) VALUES('p-fis','s-fis','Fisica 1','ready','it',0.75,1,1);
    INSERT INTO plan_sources(plan_id,source_id) VALUES('p-fis','src-fis');
  `);
  db.close();
}

type Paint = Record<string, string>;

/** Every painted colour on the page, keyed by the element's place in the tree. */
function paint(page: Page): Promise<Paint> {
  return page.evaluate(() => {
    const out: Record<string, string> = {};
    const walk = (node: Element, path: string) => {
      if (
        ["SCRIPT", "STYLE", "LINK", "META", "TITLE", "HEAD"].includes(
          node.tagName,
        )
      )
        return;
      const style = getComputedStyle(node);
      out[path] = [
        style.color,
        style.backgroundColor,
        style.borderTopColor,
        style.borderBottomColor,
      ].join(" | ");
      let index = 0;
      for (const child of node.children)
        walk(
          child,
          `${path}>${child.tagName.toLowerCase()}${typeof child.className === "string" && child.className ? "." + child.className.split(/\s+/)[0] : ""}:${index++}`,
        );
    };
    walk(document.body, "body");
    return out;
  });
}

/** Elements whose colours differ between two paints of the same page. */
function differences(a: Paint, b: Paint): string[] {
  return (
    Object.keys(a)
      // The door switch paints its selected pill from a thumb animation that a reload has not run.
      .filter(
        (key) =>
          key in b && a[key] !== b[key] && !key.includes("div.ant-segmented"),
      )
      .map((key) => `${key}: ${a[key]} != ${b[key]}`)
  );
}

/** The four colours the issue reported: page, header rule, assistant text and its formula. */
function landmarks(page: Page) {
  return page.evaluate(() => {
    const css = (
      selector: string,
      property: "backgroundColor" | "color" | "borderBottomColor",
    ) => {
      const node = document.querySelector(selector);
      if (!node) throw new Error(`missing ${selector}`);
      return getComputedStyle(node)[property];
    };
    return {
      theme: document.documentElement.dataset["theme"] ?? null,
      page: css("body", "backgroundColor"),
      headerRule: css("header.ant-layout-header", "borderBottomColor"),
      assistantText: css(".px-msg:not(.px-msg-user) .px-msg-text p", "color"),
      assistantMath: css(".px-msg:not(.px-msg-user) .katex", "color"),
    };
  });
}

test("Ask: a live theme switch repaints the page, header and cited reply like a reload does", async () => {
  test.setTimeout(180000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-ask-theme-"));
  const env = {
    ...process.env,
    PYXIS_USER_DATA: userData,
    PYXIS_E2E: "1",
    PYXIS_E2E_REPLY: REPLY,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [MAIN], env });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    seed(userData);
    await page.evaluate(() => window.pyxis.setAppearance("light"));
    await page.evaluate(() => {
      location.hash = "/ask";
    });
    await page.reload();
    // A subject brings its sources, so the reply is grounded and carries a citation chip.
    await page.getByRole("button", { name: /^Materia:/ }).click();
    await page.getByRole("button", { name: "Fisica", exact: true }).click();
    const box = page.getByRole("textbox", { name: "Messaggio" });
    await box.fill("Come si risolve un integrale per parti?");
    await box.press("Enter");
    await expect(page).toHaveURL(/#\/ask\/.+/);
    await expect(page.locator(".katex").first()).toBeVisible({
      timeout: 30000,
    });
    const chatHash = await page.evaluate(() => location.hash);
    const open = async () => {
      await page.evaluate(() => {
        location.hash = "/exams";
      });
      await expect(page).toHaveURL(/#\/exams$/);
      await page.evaluate((hash) => {
        location.hash = hash;
      }, chatHash);
      await expect(page.locator(".katex").first()).toBeVisible();
    };
    // Transitions are still running a moment after a switch; a reload paints the settled colours.
    // The pointer rests in a corner and nothing keeps focus, so no hover or focus state differs between a live page and
    // a reloaded one (macOS keeps the composer focused after sending; a reload drops it).
    const settle = async () => {
      await page.mouse.move(1, 1);
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.waitForTimeout(800);
    };
    const reloaded = async () => {
      await page.reload();
      await expect(page.locator(".katex").first()).toBeVisible();
      await settle();
      return paint(page);
    };

    for (const [from, to] of [
      ["light", "dark"],
      ["dark", "light"],
    ] as const) {
      await page.evaluate((theme) => window.pyxis.setAppearance(theme), from);
      await open();
      await settle();
      const before = await landmarks(page);

      // The switch the issue describes: the API call, with the chat on screen.
      await page.evaluate((theme) => window.pyxis.setAppearance(theme), to);
      await settle();
      await page.screenshot({ path: `.shots/ask-theme-${from}-to-${to}.png` });
      const live = await paint(page);
      const after = await landmarks(page);
      expect(after.theme).toBe(to);
      for (const key of [
        "page",
        "headerRule",
        "assistantText",
        "assistantMath",
      ] as const)
        expect(after[key], `${key}: ${from} to ${to}`).not.toBe(before[key]);
      expect(
        differences(live, await reloaded()),
        `live ${to} against a reload`,
      ).toEqual([]);

      // The same switch from Settings > Appearance, then back to the chat.
      await page.evaluate((theme) => window.pyxis.setAppearance(theme), from);
      await open();
      await page.evaluate(() => {
        location.hash = "/settings/appearance";
      });
      await page
        .getByRole("button", {
          name: to === "dark" ? "Scuro" : "Chiaro",
          exact: true,
        })
        .click();
      await expect(page.locator("html")).toHaveAttribute("data-theme", to);
      await open();
      await settle();
      const viaSettings = await paint(page);
      expect(
        differences(viaSettings, await reloaded()),
        `${to} through Settings against a reload`,
      ).toEqual([]);
    }
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
