import { importPickedSource } from "./picked-source";
import AxeBuilder from "@axe-core/playwright";
import { _electron as electron, expect, test } from "@playwright/test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { strToU8, zipSync } from "fflate";
import type { ConceptGraph } from "../../src/shared/concept-map";

test("MAP-01 through MAP-04 saved positions, model patch, keyboard and screen PNG", async () => {
  test.setTimeout(240_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-map-check-"));
  const file = join(userData, "derivatives.ptsb");
  writeFileSync(
    file,
    zipSync({
      "smartbook.json": strToU8(
        JSON.stringify({
          id: "calculus",
          title: "Analisi",
          access: "public",
          chapters: [{ id: "c1", number: 1, title: "Derivate", file: "01.md" }],
        }),
      ),
      "chapters/01.md": strToU8(
        "## p1 | Derivata\nLa derivata misura il cambiamento. La derivata di $x^2$ è $2x$.\n\n## p2 | Prodotto\nLa regola del prodotto deriva $fg$ come $f'g+fg'$.\n\n## p3 | Composizione\nLa regola della catena deriva $f(g(x))$ come $f'(g(x))g'(x)$. Una tangente descrive la variazione locale.\n",
      ),
    }),
  );
  const planReplies = {
    topics: {
      topics: [
        {
          title: "Derivate",
          summary: "Regole di derivazione",
          subtopics: ["Prodotto", "Catena"],
          segmentIds: ["{{segment:0}}"],
        },
      ],
    },
    markdown: {
      markdown: "## Derivate\nLe derivate misurano il cambiamento [P1].",
    },
    questions: {
      questions: Array.from({ length: 10 }, (_, i) => ({
        stem: `Derivata ${i}`,
        options: ["2x", "x", "0", "1"],
        correct: 0,
        topicIndex: 0,
        passageIds: ["{{passage:0}}"],
        explanation: "La derivata di x al quadrato è 2x.",
      })),
    },
  };
  const labels = [
    "Derivate",
    "Tasso di variazione",
    "$f(x)=x^2$",
    "$f'(x)=2x$",
    "Regola del prodotto",
    "Composizione",
    "Tangente",
    "Variazione locale",
  ];
  const mapReplies = {
    title: {
      title: "Derivate",
      nodes: labels.map((label, i) => ({
        id: `n${i}`,
        label,
        parent: i ? "n0" : null,
        sources: "{{allPassages}}",
      })),
      edges: labels
        .slice(1)
        .map((_, i) => ({ from: "n0", to: `n${i + 1}`, label: "comprende" })),
    },
    ops: {
      ops: [
        {
          op: "add_node",
          id: "chain",
          label: "Regola della catena",
          parent: "n0",
        },
        { op: "rename", id: "n1", label: "Tasso istantaneo" },
      ],
    },
  };
  const env = {
    ...process.env,
    PYXIS_USER_DATA: userData,
    PYXIS_E2E: "1",
    PYXIS_E2E_PLAN_REPLIES: JSON.stringify(planReplies),
    PYXIS_E2E_MAP_REPLIES: process.env.PYXIS_LIVE_MAP
      ? undefined
      : JSON.stringify(mapReplies),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    args: [join(process.cwd(), process.env.PYXIS_OUT_DIR ?? "out", "main/index.js")],
    env,
  });
  try {
    const page = await app.firstWindow();
    // Hidden windows on Windows and Linux can stall CSS/JS motion mid-way (stuck modal leave, half-faded colors); the app honors this setting.
    await page.emulateMedia({ reducedMotion: "reduce" });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.getByRole("button", { name: "Salta" }).click();
    const source = (await importPickedSource(page, app, file)) as {
      sourceId: string;
    };
    await expect
      .poll(
        async () =>
          (
            (await page.evaluate(() =>
              window.pyxis.invoke("sources.list", {}),
            )) as Array<{ id: string; status: string }>
          ).find((s) => s.id === source.sourceId)?.status,
      )
      .toBe("ready");
    const created = (await page.evaluate(
      (sourceId) =>
        window.pyxis.invoke("plans.create", {
          title: "Analisi",
          sourceIds: [sourceId],
        }),
      source.sourceId,
    )) as { planId: string };
    await expect
      .poll(
        async () =>
          (
            (await page.evaluate(
              (planId) => window.pyxis.invoke("plans.build", { planId }),
              created.planId,
            )) as { state: string }
          ).state,
      )
      .toBe("succeeded");
    const plan = (await page.evaluate(
      (planId) => window.pyxis.invoke("plans.read", { planId }),
      created.planId,
    )) as { topics: Array<{ id: string }> };
    const input = { planId: created.planId, topicId: plan.topics[0]!.id };
    await page.evaluate(({ planId, topicId }) => {
      window.location.hash = `/plans/${planId}/map/${topicId}`;
    }, input);
    await page.getByRole("button", { name: "Crea mappe", exact: true }).click();
    await expect
      .poll(
        async () =>
          (
            (await page.evaluate(
              (input) => window.pyxis.invoke("maps.build", input),
              input,
            )) as { state: string }
          )?.state,
        { timeout: 120_000 },
      )
      .toBe("succeeded");
    const maps = (await page.evaluate(
      (input) => window.pyxis.invoke("maps.list", input),
      input,
    )) as Array<{ id: string; model?: string }>;
    expect(maps.length).toBeGreaterThan(0);
    const current = { ...input, mapId: maps[0]!.id };
    const graph = () =>
      page.evaluate(
        (input) => window.pyxis.invoke("maps.open", input),
        current,
      ) as Promise<ConceptGraph>;
    const initial = await graph();
    expect(initial.nodes.length).toBeGreaterThanOrEqual(8);
    await expect(page.locator(".react-flow__node")).toHaveCount(
      initial.nodes.length,
    );
    const nodeId = initial.nodes.find((n) => n.parent)!.id;
    const actual = page.locator(`.react-flow__node[data-id="${nodeId}"]`);
    // React Flow measures nodes and fits the view after they mount; drag only once the box stops moving.
    let seen = "";
    await expect
      .poll(async () => {
        const next = JSON.stringify(await actual.boundingBox());
        const settled = next !== "null" && next === seen;
        seen = next;
        return settled;
      })
      .toBe(true);
    const box = await actual.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      box!.x + box!.width / 2 + 55,
      box!.y + box!.height / 2 + 35,
      { steps: 8 },
    );
    await page.mouse.up();
    await expect
      .poll(
        async () => (await graph()).nodes.find((n) => n.id === nodeId)?.pinned,
      )
      .toBe(true);
    const pinned = (await graph()).nodes.find((n) => n.id === nodeId)!;
    await page.getByText("Radiale", { exact: true }).click();
    await expect.poll(async () => (await graph()).layout).toBe("radial");
    expect((await graph()).nodes.find((n) => n.id === nodeId)).toMatchObject({
      x: pinned.x,
      y: pinned.y,
      pinned: true,
    });
    await page.reload();
    await expect(page.locator(".react-flow__node")).toHaveCount(
      initial.nodes.length,
    );
    await page
      .locator(".px-map-composer input")
      .fill("aggiungi un ramo sulla regola della catena");
    const before = await graph();
    await page.locator(".px-map-composer button").click();
    await expect
      .poll(async () => (await graph()).nodes.length, { timeout: 90_000 })
      .toBeGreaterThan(before.nodes.length);
    await page.getByRole("button", { name: "Annulla", exact: true }).click();
    await expect.poll(async () => (await graph()).nodes).toEqual(before.nodes);
    await expect(page.locator(".px-map-composer input")).toBeEnabled();
    await expect(page.locator(".react-flow__node")).toHaveCount(
      before.nodes.length,
    );
    await expect
      .poll(async () => {
        await actual.focus();
        return actual.evaluate((el) => el === document.activeElement);
      })
      .toBe(true);
    await expect(actual).toHaveClass(/selected/);
    // Something else can take focus right after the node does (the composer re-enables after the undo),
    // and then the arrow goes to it; take focus back and press again until the node moves.
    await expect(async () => {
      await actual.focus();
      await expect(actual).toBeFocused({ timeout: 1000 });
      await page.keyboard.press("ArrowRight");
      await expect
        .poll(
          async () => (await graph()).nodes.find((n) => n.id === nodeId)?.x,
          { timeout: 2000 },
        )
        .not.toBe(pinned.x);
    }).toPass({ timeout: 20000 });
    await actual.click();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog")).toBeVisible();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Annulla" })
      .click();
    mkdirSync(".shots", { recursive: true });
    for (const [language, theme, width] of [
      ["it", "dark", 1280],
      ["it", "light", 960],
      ["en", "dark", 1280],
      ["en", "light", 960],
    ] as const) {
      await page.evaluate(
        async ({ language, theme }) => {
          localStorage.setItem("pyxis.lang", language);
          await window.pyxis.setAppearance(theme);
        },
        { language, theme },
      );
      await page.reload();
      await page.setViewportSize({ width, height: width === 960 ? 640 : 800 });
      await expect(page.locator(".react-flow__node")).toHaveCount(
        initial.nodes.length,
      );
      await page.screenshot({
        path: `.shots/m10-map-${language}-${theme}-${width}.png`,
      });
      expect(
        (await new AxeBuilder({ page }).setLegacyMode(true).analyze())
          .violations,
      ).toEqual([]);
      const output = join(userData, `map-${theme}-${language}.png`);
      await app.evaluate(({ session }, path) => {
        session.defaultSession.once("will-download", (_, item) =>
          item.setSavePath(path),
        );
      }, output);
      await page
        .getByRole("button", { name: /Esporta PNG|Export PNG/, exact: true })
        .click();
      await expect
        .poll(() => existsSync(output), { timeout: 20000 })
        .toBe(true);
      // Windows shows the file before the write has finished, so wait until it decodes.
      const readPng = () => {
        try {
          return PNG.sync.read(readFileSync(output));
        } catch {
          return null;
        }
      };
      await expect.poll(readPng, { timeout: 20000 }).not.toBeNull();
      copyFileSync(
        output,
        `.shots/m10-export-${language}-${theme}-${width}.png`,
      );
      const png = readPng()!;
      const bounds = await page.locator(".px-map-canvas").boundingBox();
      expect(png.width).toBe(Math.round(bounds!.width * 2));
      expect(png.height).toBe(Math.round(bounds!.height * 2));
      const color = await page
        .locator(".px-map-canvas")
        .evaluate((el) => getComputedStyle(el).backgroundColor);
      const rgb = color.match(/\d+/g)!.slice(0, 3).map(Number);
      // Match a blank canvas pixel: catches old dark-only repaint exports.
      expect([
        ...png.data.slice(
          (png.width * 40 + png.width - 40) * 4,
          (png.width * 40 + png.width - 40) * 4 + 3,
        ),
      ]).toEqual(rgb);
    }
    expect(errors).toEqual([]);
    if (process.env.PYXIS_LIVE_MAP)
      console.log("Live map model", maps[0]!.model);
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
