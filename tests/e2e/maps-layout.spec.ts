import { importPickedSource } from "./picked-source";
import { expect, test } from "@playwright/test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchPyxis } from "./app-under-test";
import { makeBook } from "./book";
import { expectNoAxeViolations } from "./axe";
import { animationsSettled } from "./settled";
import { saveShot } from "./shots";
import { removeTestFolder } from "./cleanup";
import { fromChiediToExams } from "./doors";
import { DatabaseSync } from "node:sqlite";
import type { Page } from "@playwright/test";
import { seedSubjects } from "./seed";
import { drawingProblems } from "../fixtures/map-svg";
import { radialFixtures, storedGraph } from "../fixtures/maps";

test("MAP-05 large map: left-to-right layout, folding, quiet cross-links", async () => {
  test.setTimeout(240_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-map-check-"));
  const file = join(userData, "derivatives.ptsb");
  writeFileSync(
    file,
    makeBook({
      id: "calculus",
      title: "Analisi",
      chapters: [
        {
          title: "Derivate",
          text: "## p1 | Derivata\nLa derivata misura il cambiamento. La derivata di $x^2$ è $2x$.\n\n## p2 | Prodotto\nLa regola del prodotto deriva $fg$ come $f'g+fg'$.\n\n## p3 | Composizione\nLa regola della catena deriva $f(g(x))$ come $f'(g(x))g'(x)$. Una tangente descrive la variazione locale.\n",
        },
      ],
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
  // The reply is looked up by the first property of the map's schema.
  const mapReplies = {
    nodes: {
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
    PYXIS_E2E_PLAN_REPLIES: JSON.stringify(planReplies),
    PYXIS_E2E_MAP_REPLIES: process.env.PYXIS_LIVE_MAP
      ? undefined
      : JSON.stringify(mapReplies),
  };
  const app = await launchPyxis({ userData, env });
  try {
    const page = await app.firstWindow();
    // Hidden windows on Windows and Linux can stall CSS/JS motion mid-way (stuck modal leave, half-faded colors); the app honors this setting.
    await page.emulateMedia({ reducedMotion: "reduce" });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.getByRole("button", { name: "Salta" }).click();
    // Skipping saves the profile, then moves to Chiedi; wait so a reload or route change cannot land on setup.
    await fromChiediToExams(page);
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
    await page.getByRole("button", { name: "Crea la mappa", exact: true }).click();
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
    // Under the title: the exam's icon and link, a dot, then the hint, all centred on one line.
    const line = page.locator(".px-map-sub");
    await expect(line).toHaveText(/^Analisi·clicca un concetto/);
    const middles = await line.evaluate((p) =>
      [...p.querySelectorAll("svg, a > span, :scope > span")].map((el) => {
        const box = el.getBoundingClientRect();
        return box.top + box.height / 2;
      }),
    );
    expect(middles).toHaveLength(4);
    expect(Math.max(...middles) - Math.min(...middles)).toBeLessThanOrEqual(1);
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
    // The branch slides back into n1 and fades before it leaves the map.
    await expect.poll(async () => (await boxes()).length).toBeLessThan(before);
    // Folding and unfolding move the map in one motion. Every change the map makes to a node is recorded as it
    // happens, without page timers, which a hidden test window may hold back for seconds: where it is, its size, its
    // opacity, whether it is selected and how visible its link handles are. The record ends with the map's own signals,
    // once it has stopped moving and shows the expected number of nodes.
    type Spot = { x: number; y: number };
    type Sample = Spot & { at: number; w: number; h: number; o: number; selected: boolean; handles: number; moving: boolean; label: number };
    await page.evaluate(`window.__recordMotion = (until) => new Promise((done) => {
      const canvas = document.querySelector(".px-map-canvas");
      const count = () => document.querySelectorAll(".react-flow__node").length;
      const before = count();
      const track = {};
      const start = performance.now();
      const record = () => {
        const at = performance.now() - start;
        const moving = canvas.hasAttribute("data-moving");
        const shown = document.querySelector(".px-cross-label");
        const label = shown ? Number(shown.style.opacity || 1) : -1;
        for (const node of document.querySelectorAll(".react-flow__node")) {
          // A spot near 0 can read as 1e-14px, so the number may carry an exponent.
          const match = /translate\\(([-+\\d.e]+)px,\\s*([-+\\d.e]+)px\\)/.exec(node.style.transform);
          const handles = Math.max(0, ...[...node.querySelectorAll(".react-flow__handle")].map((h) => Number(getComputedStyle(h).opacity)));
          (track[node.dataset.id] ??= []).push({
            x: Number(match[1]), y: Number(match[2]), at, moving, handles, label,
            w: node.offsetWidth, h: node.offsetHeight,
            o: Number(node.style.opacity || 1), selected: node.classList.contains("selected"),
          });
        }
      };
      record();
      let moved = false;
      const settled = () => !canvas.hasAttribute("data-moving") && (until === "fewer" ? count() < before : count() > before);
      window.__motion = { moved: () => moved, nodes: count, before, stop: () => watch.disconnect() };
      const watch = new MutationObserver(() => {
        record();
        if (canvas.hasAttribute("data-moving")) moved = true;
        if ((moved || !window.matchMedia("(prefers-reduced-motion: no-preference)").matches) && settled()) {
          watch.disconnect();
          done(track);
        }
      });
      watch.observe(canvas, { subtree: true, childList: true, attributes: true, attributeFilter: ["style", "data-moving", "class"] });
    })`);
    // A fold that never settles must fail here, saying which signal never came, rather than at the test's time limit.
    // The limit runs in the test, where timers aren't held back.
    const recordMotion = async (until: "fewer" | "more", act: () => Promise<void>) => {
      const sampling = page.evaluate(`window.__recordMotion(${JSON.stringify(until)})`) as Promise<Record<string, Sample[]>>;
      await act();
      let limit: ReturnType<typeof setTimeout> | undefined;
      return Promise.race([
        sampling,
        new Promise<never>((_, fail) => {
          limit = setTimeout(() => {
            void page
              .evaluate(`(() => { const r = window.__motion; r.stop(); return { moved: r.moved(), nodes: r.nodes(), before: r.before, moving: !!document.querySelector(".px-map-canvas[data-moving]") }; })()`)
              .then((state) => fail(new Error(`The map never settled within 10 s: ${JSON.stringify(state)}`)), fail);
          }, 10_000);
        }),
      ]).finally(() => clearTimeout(limit));
    };
    const away = (a: Spot, b: Spot) => Math.hypot(a.x - b.x, a.y - b.y);
    // Where a node sits tucked inside n1 in the same sample: its left edge on n1's right edge, centred on n1. A branch
    // grows out of there and folds back into it.
    const tucked = (track: Record<string, Sample[]>, spot: Sample) => {
      const n1 = track["n1"]!.find((s) => s.at === spot.at)!;
      return { x: n1.x + n1.w, y: n1.y + (n1.h - spot.h) / 2 };
    };
    // What every fold and unfold keeps to: nodes that stay on the map head straight for their end and never step
    // back, link handles stay hidden while nodes slide under the pointer, and n1's selection doesn't change.
    const checkMotion = (track: Record<string, Sample[]>) => {
      const last = track["n1"]!.at(-1)!.at;
      for (const [id, spots] of Object.entries(track)) {
        if (spots.at(-1)!.at !== last) continue;
        const end = spots.at(-1)!;
        spots.slice(1).forEach((spot, i) => {
          expect(away(spot, end), `${id} steps back at ${Math.round(spot.at)} ms`).toBeLessThanOrEqual(away(spots[i]!, end) + 0.5);
        });
      }
      for (const [id, spots] of Object.entries(track))
        for (const spot of spots)
          if (spot.moving) expect(spot.handles, `${id} shows its handles at ${Math.round(spot.at)} ms`).toBe(0);
      expect(new Set(track["n1"]!.map((spot) => spot.selected)).size, "n1's selection changes").toBe(1);
    };
    // Unfolding grows the branch out of n1: each new node first shows tucked inside n1 and ends farther out.
    await page.emulateMedia({ reducedMotion: "no-preference" });
    const unfolded = await recordMotion("more", () => fold.dispatchEvent("click"));
    await expect(page.locator(".react-flow__node")).toHaveCount(before);
    const grown = Object.entries(unfolded).filter(([, spots]) => spots[0]!.at > unfolded["n1"]![0]!.at);
    expect(grown.length).toBeGreaterThan(0);
    for (const [id, spots] of grown) {
      expect(away(spots[0]!, tucked(unfolded, spots[0]!)), `${id} grows out of n1`).toBeLessThan(24);
      expect(spots[0]!.o, `${id} fades in`).toBeLessThan(1);
      expect(away(spots.at(-1)!, tucked(unfolded, spots.at(-1)!)), `${id} ends farther out`).toBeGreaterThan(100);
    }
    checkMotion(unfolded);
    // Folding with a real click, as a person does, with the pointer over n1 as its siblings slide. Each node of the
    // branch stays in sight while it slides into n1, and the last time it shows it is inside n1, faded out, in the same
    // frame that puts n1 at its end. That last frame doesn't depend on how many frames the screen managed before it.
    // n6 is selected, so its link to n23, which folds away with the branch, shows its label; the label fades with it.
    await page.locator('.react-flow__node[data-id="n6"]').focus();
    await expect(page.locator(".px-cross-label")).toHaveText("caso particolare");
    const closed = await recordMotion("fewer", () => fold.click({ timeout: 10_000 }));
    await expect(fold).toHaveAttribute("aria-expanded", "false");
    const last = closed["n1"]!.at(-1)!.at;
    const gone = Object.entries(closed).filter(([, spots]) => spots.at(-1)!.at < last);
    expect(gone.length).toBeGreaterThan(0);
    for (const [id, spots] of gone) {
      const moved = spots.findIndex((spot) => spot.x !== spots[0]!.x || spot.y !== spots[0]!.y);
      expect(moved, `${id} moves before it leaves`).toBeGreaterThan(0);
      // Timed from the sample where the map says it moves, which comes before the motion's first frame, so a stalled
      // frame can't shorten it.
      const began = spots.find((spot) => spot.moving)!;
      expect(spots.at(-1)!.at - began.at, `${id} stays while it slides`).toBeGreaterThan(150);
      const end = spots.at(-1)!;
      const n1 = closed["n1"]!.find((spot) => spot.at === end.at)!;
      expect(away(n1, closed["n1"]!.at(-1)!), `${id} last shows when n1 has ended`).toBeLessThan(0.5);
      expect(away(end, tucked(closed, end)), `${id} ends inside n1`).toBeLessThan(24);
      expect(end.o, `${id} has faded out`).toBe(0);
    }
    expect(closed["n23"]!.at(-1)!.label, "the label of n23's link fades out with n23").toBe(0);
    checkMotion(closed);
    await expect(page.locator(".px-map-canvas[data-moving]")).toHaveCount(0);
    await fold.dispatchEvent("click");
    await expect(fold).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator(".react-flow__node")).toHaveCount(before);
    await expect(page.locator(".px-map-canvas[data-moving]")).toHaveCount(0);
    // With reduced motion the map cuts: a new node enters where it ends.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await fold.dispatchEvent("click");
    await expect.poll(async () => (await boxes()).length).toBeLessThan(before);
    const cut = await recordMotion("more", () => fold.dispatchEvent("click"));
    const entered = Object.values(cut).filter((spots) => spots[0]!.at > cut["n1"]![0]!.at);
    expect(entered.length).toBeGreaterThan(0);
    for (const spots of entered) expect(away(spots[0]!, spots.at(-1)!)).toBeLessThan(1);
    expect(Object.values(cut).every((spots) => spots.every((spot) => !spot.moving))).toBe(true);
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
      await animationsSettled(page);
      await saveShot(page, `map-large-${total}-${language}-${theme}-1280.png`);
      await expectNoAxeViolations(page);
    }
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

/** The concept boxes on screen, in screen pixels. */
async function conceptBoxes(page: Page) {
  return page.locator(".react-flow__node").evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      return { id: (el as HTMLElement).dataset.id!, x: r.x, y: r.y, w: r.width, h: r.height };
    }),
  );
}
/** Every pair of concept boxes that intersect, as "a×b". */
async function overlapping(page: Page) {
  const boxes = await conceptBoxes(page);
  const found: string[] = [];
  for (const [i, a] of boxes.entries())
    for (const b of boxes.slice(i + 1))
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) found.push(`${a.id}×${b.id}`);
  return found;
}
/** Waits until the map has stopped moving and its view and boxes hold still. */
async function mapAtRest(page: Page) {
  await expect(page.locator(".px-map-canvas[data-moving]")).toHaveCount(0);
  let seen = "";
  await expect
    .poll(async () => {
      const next = JSON.stringify([
        await page.locator(".react-flow__viewport").evaluate((el) => getComputedStyle(el).transform),
        await conceptBoxes(page),
      ]);
      const still = next === seen;
      seen = next;
      return still;
    })
    .toBe(true);
}
const viewZoom = (page: Page) =>
  page.locator(".react-flow__viewport").evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).a);

test("MAP-11 radial layout: no overlaps, readable fit, folding, switch back and Annulla", async () => {
  test.setTimeout(240_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-map-radial-"));
  const app = await launchPyxis({ userData });
  try {
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(page);
    await page.evaluate(() => window.pyxis.invoke("plans.list", {}));
    // The five fixture maps, all of one subject with no exam.
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10000 });
    seedSubjects(db, [{ id: "cinema", name: "Cinema" }]);
    db.prepare("INSERT INTO maps(id,subject_id,graph_json,grounding,created_at) VALUES('row-cinema','cinema',?,'general',1)").run(
      JSON.stringify({
        version: 1,
        maps: Object.entries(radialFixtures).map(([id, map]) => ({
          id,
          title: map.title,
          passageIds: [],
          grounding: "general",
          graph: storedGraph(map),
        })),
      }),
    );
    db.close();
    const open = async (id: string) => {
      await page.evaluate((id) => {
        location.hash = `/maps/cinema?from=maps&map=${id}`;
      }, id);
      await page.reload();
      await expect(page.locator(".react-flow__node").first()).toBeVisible();
      await mapAtRest(page);
    };
    const layout = (name: string) => page.getByRole("radio", { name, exact: true });

    await page.setViewportSize({ width: 1280, height: 800 });
    await open("filmHistory");
    await expect(page.locator(".react-flow__node")).toHaveCount(radialFixtures.filmHistory.nodes.length);
    await layout("Radiale").click();
    await expect(layout("Radiale")).toHaveAttribute("aria-checked", "true");
    await mapAtRest(page);
    expect(await overlapping(page)).toEqual([]);
    // The root in the middle of the canvas, every main branch around it.
    const canvas = (await page.locator(".px-map-canvas").boundingBox())!;
    const placed = await conceptBoxes(page);
    const root = placed.find((box) => box.id === "root")!;
    expect(Math.abs(root.x + root.w / 2 - (canvas.x + canvas.width / 2))).toBeLessThan(canvas.width / 4);
    expect(Math.abs(root.y + root.h / 2 - (canvas.y + canvas.height / 2))).toBeLessThan(canvas.height / 4);
    // Labels stay readable: the view never opens below the tree's minimum zoom, so 14 px text shows at 11 px or more.
    expect(await viewZoom(page)).toBeGreaterThanOrEqual(0.85 - 1e-3);
    const text = page.locator('.react-flow__node[data-id="b2a"] .px-markdown');
    const fontSize = await text.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(fontSize * (await viewZoom(page))).toBeGreaterThanOrEqual(11);
    // Links outside the hierarchy show only while an end is selected, with their label.
    await expect(page.locator(".px-cross-edge")).toHaveCount(0);
    await page.locator('.react-flow__node[data-id="b3"]').focus();
    await expect(page.locator(".px-cross-edge")).toHaveCount(1);
    await expect(page.locator(".px-cross-label")).toHaveText("ispira");
    await page.locator(".react-flow__pane").click({ position: { x: 4, y: 4 } });
    await expect(page.locator(".px-cross-edge")).toHaveCount(0);

    // Folding Hollywood classica hides its five concepts and keeps the rest apart; unfolding brings them back.
    const fold = page.locator('.react-flow__node[data-id="b2"] .px-concept-fold');
    await fold.dispatchEvent("click");
    await expect(fold).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator(".react-flow__node")).toHaveCount(radialFixtures.filmHistory.nodes.length - 5);
    await mapAtRest(page);
    expect(await overlapping(page)).toEqual([]);
    await fold.dispatchEvent("click");
    await expect(fold).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator(".react-flow__node")).toHaveCount(radialFixtures.filmHistory.nodes.length);
    await mapAtRest(page);
    expect(await overlapping(page)).toEqual([]);

    // Back to the tree, then Annulla brings the radial layout back.
    await layout("Albero").click();
    await expect(layout("Albero")).toHaveAttribute("aria-checked", "true");
    await mapAtRest(page);
    const tree = await conceptBoxes(page);
    const treeRoot = tree.find((box) => box.id === "root")!;
    for (const box of tree) if (box.id !== "root") expect(box.x).toBeGreaterThan(treeRoot.x + treeRoot.w);
    await page.getByRole("button", { name: "Annulla", exact: true }).click();
    await expect(layout("Radiale")).toHaveAttribute("aria-checked", "true");
    await mapAtRest(page);
    expect(await overlapping(page)).toEqual([]);

    // The switch moves every concept from its place in the tree to its place in the radial layout.
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await layout("Albero").click();
    await mapAtRest(page);
    const from = new Map((await conceptBoxes(page)).map((box) => [box.id, box]));
    const moving = page.evaluate(
      () =>
        new Promise<number>((done) => {
          const canvas = document.querySelector(".px-map-canvas")!;
          let frames = 0;
          const watch = new MutationObserver(() => {
            if (canvas.hasAttribute("data-moving")) frames++;
            else if (frames) {
              watch.disconnect();
              done(frames);
            }
          });
          watch.observe(canvas, { subtree: true, attributes: true, attributeFilter: ["style", "data-moving"] });
        }),
    );
    await layout("Radiale").click();
    expect(await moving).toBeGreaterThan(1);
    await mapAtRest(page);
    const to = await conceptBoxes(page);
    expect(to.filter((box) => Math.hypot(box.x - from.get(box.id)!.x, box.y - from.get(box.id)!.y) > 40).length).toBeGreaterThan(10);
    expect(await overlapping(page)).toEqual([]);
    await page.emulateMedia({ reducedMotion: "reduce" });

    // Every fixture in both layouts: Italian dark at 1280, and English light at 960 with large text. No two concepts
    // touch in the radial layout, which opens at a readable zoom.
    for (const [language, theme, width, textSize] of [
      ["it", "dark", 1280, "md"],
      ["en", "light", 960, "lg"],
    ] as const) {
      await page.evaluate(
        async ({ language, theme, textSize }) => {
          localStorage.setItem("pyxis.lang", language);
          await window.pyxis.setAppearance(theme);
          await window.pyxis.invoke("profile.save", { dyslexia: false, textSize });
        },
        { language, theme, textSize },
      );
      await page.setViewportSize({ width, height: 800 });
      for (const id of Object.keys(radialFixtures)) {
        for (const kind of ["radial", "tree"] as const) {
          await page.evaluate(
            ({ id, kind }) => window.pyxis.invoke("maps.layout", { subjectId: "cinema", mapId: id, layout: kind }),
            { id, kind },
          );
          await open(id);
          if (kind === "radial") {
            expect(await overlapping(page), `${id} at ${width}`).toEqual([]);
            expect(await viewZoom(page)).toBeGreaterThanOrEqual(0.85 - 1e-3);
          }
          await animationsSettled(page);
          await saveShot(page, `map-${id}-${kind}-${language}-${theme}-${width}${textSize === "lg" ? "-large" : ""}.png`);
        }
      }
    }
    await expectNoAxeViolations(page);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("MAP-13 Adatta la mappa brings the whole large map into the window, radial and tree, at both window sizes", async () => {
  test.setTimeout(240_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-map-fit-"));
  const app = await launchPyxis({ userData });
  try {
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(page);
    await page.evaluate(() => window.pyxis.invoke("plans.list", {}));
    // The 25-concept map, which opens at a readable zoom and then needs far less to be shown whole.
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10000 });
    seedSubjects(db, [{ id: "cinema", name: "Cinema" }]);
    db.prepare("INSERT INTO maps(id,subject_id,graph_json,grounding,created_at) VALUES('row-cinema','cinema',?,'general',1)").run(
      JSON.stringify({
        version: 1,
        maps: (["radial", "tree"] as const).map((kind) => ({
          id: kind,
          title: radialFixtures.filmHistory.title,
          passageIds: [],
          grounding: "general",
          graph: storedGraph(radialFixtures.filmHistory, kind),
        })),
      }),
    );
    db.close();
    const fit = page.getByRole("button", { name: "Adatta la mappa" });
    for (const [width, height] of [
      [960, 640],
      [1280, 800],
    ] as const) {
      await page.setViewportSize({ width, height });
      for (const kind of ["radial", "tree"] as const) {
        const where = `${kind} at ${width}`;
        await page.evaluate((id) => {
          location.hash = `/maps/cinema?from=maps&map=${id}`;
        }, kind);
        await page.reload();
        await expect(page.locator(".react-flow__node").first()).toBeVisible();
        await mapAtRest(page);
        await expect(page.locator(".react-flow__node"), where).toHaveCount(radialFixtures.filmHistory.nodes.length);
        const outside = async () => {
          const canvas = (await page.locator(".px-map-canvas").boundingBox())!;
          return (await conceptBoxes(page))
            .filter((box) => box.x < canvas.x || box.y < canvas.y || box.x + box.w > canvas.x + canvas.width || box.y + box.h > canvas.y + canvas.height)
            .map((box) => box.id);
        };
        // The page opens at a readable zoom, which cuts this map: the button must change that.
        const before = await viewZoom(page);
        expect(await outside(), `${where} opens with part of the map out of the window`).not.toEqual([]);
        await fit.click();
        await mapAtRest(page);
        expect(await outside(), `${where} after Adatta la mappa`).toEqual([]);
        expect(await viewZoom(page), where).toBeLessThan(before);
        // Pressed again with the whole map in view, it leaves the view where it is.
        const fitted = await page.locator(".react-flow__viewport").evaluate((el) => getComputedStyle(el).transform);
        await fit.click();
        await mapAtRest(page);
        expect(await page.locator(".react-flow__viewport").evaluate((el) => getComputedStyle(el).transform), where).toBe(fitted);
        // Zoomed in and moved off, the button brings the whole map back.
        await page.locator(".react-flow__pane").hover();
        await page.mouse.wheel(0, -600);
        await mapAtRest(page);
        expect(await outside(), `${where} zoomed in`).not.toEqual([]);
        await fit.click();
        await mapAtRest(page);
        expect(await outside(), `${where} after Adatta la mappa from a zoomed view`).toEqual([]);
      }
    }
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("MAP-12 exporting a radial map as SVG draws the picture the page shows", async () => {
  test.setTimeout(180_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-map-radial-export-"));
  const saved = join(userData, "export.bin");
  const app = await launchPyxis({ userData, env: { PYXIS_E2E_SAVE: saved } });
  try {
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(page);
    await page.evaluate(() => window.pyxis.invoke("plans.list", {}));
    const fixtures = { filmHistory: radialFixtures.filmHistory, physics: radialFixtures.physics };
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10000 });
    seedSubjects(db, [{ id: "cinema", name: "Cinema" }]);
    db.prepare("INSERT INTO maps(id,subject_id,graph_json,grounding,created_at) VALUES('row-cinema','cinema',?,'general',1)").run(
      JSON.stringify({
        version: 1,
        maps: Object.entries(fixtures).map(([id, map]) => ({
          id,
          title: map.title,
          passageIds: [],
          grounding: "general",
          graph: storedGraph(map, "radial"),
        })),
      }),
    );
    db.close();
    for (const [id, map] of Object.entries(fixtures)) {
      await page.evaluate((id) => {
        location.hash = `/maps/cinema?from=maps&map=${id}`;
      }, id);
      await page.reload();
      await expect(page.locator(".react-flow__node").first()).toBeVisible();
      await mapAtRest(page);
      rmSync(saved, { force: true });
      await page.getByRole("button", { name: "Altro", exact: true }).click();
      await page.getByRole("menuitem", { name: "Esporta" }).click();
      await page.getByRole("menuitem", { name: "Mappa intera SVG" }).click();
      await expect.poll(() => existsSync(saved), { timeout: 30_000 }).toBe(true);
      await expect(page.getByText("File salvato")).toBeVisible();
      // The file is the whole map, unfolded, drawn from the radial plan: no two boxes touch, no link passes behind a
      // box that is not one of its ends, and the root is in the middle.
      const svg = readFileSync(saved, "utf8");
      const graph = storedGraph(map, "radial");
      const problems = drawingProblems(svg, graph);
      expect(problems.overlaps, id).toEqual([]);
      expect(problems.behind, id).toEqual([]);
      expect(problems.rootOffset.x, id).toBeLessThan(0.1);
      expect(problems.rootOffset.y, id).toBeLessThan(0.1);
    }
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});
