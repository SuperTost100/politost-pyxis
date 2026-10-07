import { importPickedSource } from "./picked-source";
import AxeBuilder from "@axe-core/playwright";
import { _electron as electron, expect, test } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";

test("MAP-05 large map: left-to-right layout, folding, quiet cross-links", async () => {
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

  // Root, four chapters, then sections and leaves; long labels wrap, a few links cross branches.
  const total = Number(process.env.PYXIS_MAP_NODES ?? 25);
  const chapters = 4;
  const sections = Math.floor((total - 1 - chapters) / 2);
  const nodes: Array<{ id: string; label: string; parent: string | null }> = [
    {
      id: "n0",
      label: "Derivate: dal rapporto incrementale alle applicazioni",
      parent: null,
    },
  ];
  for (let i = 1; i < total; i++) {
    const parent =
      i <= chapters
        ? "n0"
        : i <= chapters + sections
          ? `n${1 + ((i - chapters - 1) % chapters)}`
          : `n${chapters + 1 + ((i - chapters - sections - 1) % sections)}`;
    nodes.push({
      id: `n${i}`,
      parent,
      label:
        i <= chapters
          ? `Capitolo ${i}: ${i % 2 ? "regole di derivazione" : "applicazioni"}`
          : i % 4 === 0
            ? `Teorema ${i}: enunciato con ipotesi, tesi e un esempio svolto passo per passo, $f'(x)$`
            : `Argomento ${i}`,
    });
  }
  const links = [
    ["n1", `n${total - 1}`, "stesso metodo"],
    ["n2", `n${chapters + 3}`, "applica il teorema"],
    [`n${chapters + 2}`, `n${total - 2}`, "caso particolare"],
  ] as const;
  const mapReplies = {
    title: {
      title: "Derivate",
      nodes: nodes.map((node) => ({ ...node, sources: "{{allPassages}}" })),
      edges: [
        ...nodes.slice(1).map((node) => ({
          from: node.parent,
          to: node.id,
          label: "comprende",
        })),
        ...links.map(([from, to, label]) => ({ from, to, label })),
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
    args: [
      join(process.cwd(), process.env.PYXIS_OUT_DIR ?? "out", "main/index.js"),
    ],
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

    const view = async () =>
      page.locator(".react-flow__viewport").evaluate((el) => {
        const m = new DOMMatrix(getComputedStyle(el).transform);
        return { x: m.e, y: m.f, zoom: m.a };
      });
    const boxes = async () => {
      const found = await page.locator(".react-flow__node").evaluateAll((els) =>
        els.map((el) => {
          const r = el.getBoundingClientRect();
          return {
            id: (el as HTMLElement).dataset.id!,
            x: r.x,
            y: r.y,
            w: r.width,
            h: r.height,
          };
        }),
      );
      return found;
    };
    await expect(page.locator(".react-flow__node").first()).toBeVisible();
    // The layout waits for every node to be measured, then the view opens once and stays put.
    let seen = "";
    await expect
      .poll(async () => {
        const next = JSON.stringify([await view(), (await boxes()).length]);
        const settled = next === seen;
        seen = next;
        return settled;
      })
      .toBe(true);
    const opened = await view();
    expect(opened.zoom).toBeGreaterThanOrEqual(0.6 - 0.001);
    const placed = await boxes();
    const root = placed.find((box) => box.id === "n0")!;
    // Root on the left, every depth column to the right of it.
    for (const box of placed)
      if (box.id !== "n0") expect(box.x).toBeGreaterThan(root.x + root.w);
    // Real gaps: no two nodes touch, columns are at least 120px apart at zoom 1.
    for (const a of placed)
      for (const b of placed) {
        if (a.id >= b.id) continue;
        const apartX = a.x + a.w <= b.x || b.x + b.w <= a.x;
        const apartY = a.y + a.h <= b.y || b.y + b.h <= a.y;
        expect(apartX || apartY, `${a.id} overlaps ${b.id}`).toBe(true);
      }
    const gaps = placed
      .filter((a) => a.id !== "n0")
      .map((a) =>
        Math.min(
          ...placed.filter((b) => b.x < a.x - 1).map((b) => a.x - (b.x + b.w)),
        ),
      );
    expect(Math.min(...gaps) / opened.zoom).toBeGreaterThanOrEqual(120);
    const text = page.locator(".px-concept-node .px-markdown").first();
    expect(
      await text.evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
    ).toBeGreaterThanOrEqual(14);
    // Tree edges carry no label; cross-links stay quiet until an end is selected.
    // Past 25 nodes the deep branches open folded, so some link ends are out of sight.
    if (total <= 25)
      await expect(page.locator(".px-cross-edge")).toHaveCount(links.length);
    await expect(page.locator(".px-cross-label")).toHaveCount(0);
    await page.locator('.react-flow__node[data-id="n2"]').focus();
    await expect(page.locator(".px-cross-label")).toHaveText(
      "applica il teorema",
    );
    await page.locator(".react-flow__pane").click({ position: { x: 4, y: 4 } });
    await expect(page.locator(".px-cross-label")).toHaveCount(0);
    // Folding hides a whole branch and the chevron says how many nodes it holds.
    const before = placed.length;
    const fold = page.locator(
      '.react-flow__node[data-id="n1"] .px-concept-fold',
    );
    await expect(fold).toHaveAttribute("aria-expanded", "true");
    await fold.dispatchEvent("click");
    await expect(fold).toHaveAttribute("aria-expanded", "false");
    expect((await boxes()).length).toBeLessThan(before);
    await fold.dispatchEvent("click");
    await expect(page.locator(".react-flow__node")).toHaveCount(before);
    mkdirSync(".shots", { recursive: true });
    for (const [language, theme] of [
      ["it", "dark"],
      ["it", "light"],
      ["en", "dark"],
      ["en", "light"],
    ] as const) {
      await page.evaluate(
        async ({ language, theme }) => {
          localStorage.setItem("pyxis.lang", language);
          await window.pyxis.setAppearance(theme);
        },
        { language, theme },
      );
      await page.reload();
      await page.setViewportSize({ width: 1280, height: 800 });
      await expect(page.locator(".react-flow__node")).toHaveCount(before);
      await page.waitForTimeout(400);
      await page.screenshot({
        path: `.shots/map-large-${total}-${language}-${theme}-1280.png`,
      });
      expect(
        (await new AxeBuilder({ page }).setLegacyMode(true).analyze())
          .violations,
      ).toEqual([]);
    }
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
