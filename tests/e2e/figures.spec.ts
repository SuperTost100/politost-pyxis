import AxeBuilder from "@axe-core/playwright";
import {
  expect,
  test,
  type Page,
} from "@playwright/test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { importPickedSource } from "./picked-source";
import { launchPyxis } from "./app-under-test";

const figure = (caption: string, code: string) =>
  ["```pyxis-figure", JSON.stringify({ caption, code }), "```"].join("\n");
const block = (kind: string, body: unknown) =>
  ["```pyxis-" + kind, JSON.stringify(body), "```"].join("\n");

// A recorded lesson with two figures that draw (a function plot and a vector diagram) and one whose code fails.
const lesson = [
  "## La legge oraria",
  "",
  "Nel moto uniformemente accelerato la posizione cresce col quadrato del tempo: $x(t) = \\tfrac12 a t^2$.",
  "",
  figure(
    "La posizione $x(t) = \\tfrac12 a t^2$ per $a = 2\\,\\mathrm{m/s^2}$.",
    "t = np.linspace(0, 4, 200)\nplt.plot(t, 0.5 * 2 * t**2, color='#3262db', lw=2)\nplt.xlabel('t (s)')\nplt.ylabel('x (m)')\nplt.title('Moto uniformemente accelerato')",
  ),
  "",
  "## Le forze come vettori",
  "",
  "Due forze applicate allo stesso punto si sommano con la regola del parallelogramma.",
  "",
  figure(
    "La somma di $\\vec F_1$ e $\\vec F_2$ con la regola del parallelogramma.",
    "fig, ax = plt.subplots(figsize=(5, 4))\nfor (dx, dy, c, name) in [(3, 1, '#3262db', 'F1'), (1, 2, '#1a9165', 'F2'), (4, 3, '#b7790c', 'F1 + F2')]:\n    ax.annotate('', xy=(dx, dy), xytext=(0, 0), arrowprops=dict(arrowstyle='->', color=c, lw=2))\n    ax.text(dx + 0.1, dy + 0.1, name, color=c)\nax.plot([3, 4, 1], [1, 3, 2], ls='--', color='gray')\nax.set_xlim(-0.5, 5)\nax.set_ylim(-0.5, 4)\nax.set_aspect('equal')",
  ),
  "",
  figure("Un circuito che non si disegna.", "raise ValueError('figura rotta')"),
  "",
  block("check", {
    question: "Se raddoppi il tempo, la posizione…",
    options: ["quadruplica", "raddoppia", "non cambia"],
    answer: 0,
    explanation: "$x$ è proporzionale a $t^2$.",
  }),
].join("\n");

// A recorded Ask answer with one figure.
const answer = [
  "Il seno oscilla tra $-1$ e $1$ con periodo $2\\pi$.",
  "",
  figure(
    "Il grafico di $\\sin x$ su due periodi.",
    "x = np.linspace(0, 4 * np.pi, 400)\nplt.plot(x, np.sin(x), color='#3262db')\nplt.axhline(0, color='gray', lw=0.8)\nplt.xlabel('x')",
  ),
  "",
  "Il massimo è in $x = \\pi/2$.",
].join("\n");

async function look(
  page: Page,
  value: "it" | "en",
  theme: "light" | "dark",
  width: number,
) {
  await page.evaluate(
    async ({ value, theme }) => {
      localStorage.setItem("pyxis.lang", value);
      await window.pyxis.setAppearance(theme);
    },
    { value, theme },
  );
  await page.setViewportSize({ width, height: 900 });
  await page.reload();
}

test("figures in a lesson and an Ask answer are drawn in the Python sandbox, and a failed one is left out", async () => {
  test.skip(
    !existsSync(".tmp/pyodide/pyodide.js"),
    "Requires the pinned Pyodide runtime fixture in .tmp/pyodide.",
  );
  // Each figure starts a fresh Pyodide worker that loads numpy and matplotlib.
  test.setTimeout(300000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-figures-"));
  const { version } = JSON.parse(
    readFileSync("resources/pyodide-manifest.json", "utf8"),
  ) as { version: string };
  const pack = join(userData, "workspace/runtimes/pyodide", version);
  mkdirSync(pack, { recursive: true });
  cpSync(".tmp/pyodide", pack, { recursive: true });
  const book = join(userData, "fisica.ptsb");
  writeFileSync(
    book,
    zipSync({
      "smartbook.json": strToU8(
        JSON.stringify({
          id: "figures",
          title: "Fisica",
          access: "public",
          chapters: [{ id: "c1", number: 1, title: "Moto", file: "01.md" }],
        }),
      ),
      "chapters/01.md": strToU8(
        "## p1 | Moto\nNel moto accelerato la posizione cresce col quadrato del tempo.\n",
      ),
    }),
  );
  const replies = {
    markdown: { markdown: lesson },
    questions: {
      questions: Array.from({ length: 10 }, (_, i) => ({
        stem: `Come cresce la posizione ${i + 1}?`,
        options: [
          "Col quadrato del tempo",
          "Col tempo",
          "Non cresce",
          "Col cubo",
        ],
        correct: 0,
        topicIndex: 0,
        passageIds: ["{{passage:0}}"],
        explanation: "x = at²/2.",
      })),
    },
  };
  const env = {
    PYXIS_E2E_PLAN_REPLIES: JSON.stringify(replies),
    PYXIS_E2E_REPLY: answer,
  };
  const app = await launchPyxis({ userData, env });
  const shots = ".shots/figures";
  mkdirSync(shots, { recursive: true });
  try {
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByRole("button", { name: "Salta" }).click();
    await expect(page).toHaveURL(/#\/exams$/);
    const { sourceId } = (await importPickedSource(page, app, book)) as {
      sourceId: string;
    };
    await expect
      .poll(
        async () =>
          (
            (await page.evaluate(() =>
              window.pyxis.invoke("sources.list", {}),
            )) as Array<{ id: string; status: string }>
          ).find((row) => row.id === sourceId)?.status,
      )
      .toBe("ready");
    const { planId } = (await page.evaluate(
      (sourceId) =>
        window.pyxis.invoke("plans.create", {
          title: "Fisica 1",
          sourceIds: [sourceId],
          language: "it",
        }),
      sourceId,
    )) as { planId: string };
    await expect
      .poll(
        async () =>
          (
            (await page.evaluate(
              (planId) => window.pyxis.invoke("plans.build", { planId }),
              planId,
            )) as {
              state: string;
            } | null
          )?.state,
        { timeout: 60000 },
      )
      .toBe("succeeded");
    const plan = (await page.evaluate(
      (planId) => window.pyxis.invoke("plans.read", { planId }),
      planId,
    )) as {
      topics: Array<{ id: string }>;
    };
    const topicId = plan.topics[0]!.id;

    await page.evaluate(
      ({ planId, topicId }) => {
        location.hash = `/plans/${planId}/lesson/${topicId}`;
      },
      { planId, topicId },
    );
    const figures = page.locator("figure.px-figure");
    await expect(figures).toHaveCount(2, { timeout: 120000 });
    await expect(figures.first().getByRole("img")).toHaveAttribute(
      "alt",
      /La posizione/,
    );
    await expect(figures.nth(1).getByRole("img")).toHaveAttribute(
      "alt",
      /regola del parallelogramma/,
    );
    expect(
      await figures
        .getByRole("img")
        .evaluateAll((images) =>
          images.map((image) => (image as HTMLImageElement).naturalWidth),
        ),
    ).toEqual([expect.any(Number), expect.any(Number)]);
    // The failed figure is gone, with no code or JSON left on the page; the lesson around it is whole.
    await expect(page.getByText("Un circuito che non si disegna.")).toHaveCount(
      0,
    );
    await expect(page.getByText("figura rotta")).toHaveCount(0);
    await expect(page.getByText("pyxis-")).toHaveCount(0);
    await expect(
      page.getByText("Se raddoppi il tempo, la posizione…"),
    ).toBeVisible();
    expect(
      (await new AxeBuilder({ page }).setLegacyMode(true).analyze()).violations,
    ).toEqual([]);
    for (const [lang, theme, width] of [
      ["it", "light", 1280],
      ["it", "dark", 1280],
      ["en", "dark", 960],
      ["en", "light", 960],
    ] as const) {
      await look(page, lang, theme, width);
      // Reopening reads the cached lesson and its images; nothing runs again.
      await expect(figures).toHaveCount(2);
      await figures.first().scrollIntoViewIfNeeded();
      await page.screenshot({
        path: `${shots}/lesson-${lang}-${theme}-${width}.png`,
      });
      await figures.nth(1).scrollIntoViewIfNeeded();
      await page.screenshot({
        path: `${shots}/lesson-vectors-${lang}-${theme}-${width}.png`,
      });
    }

    const asked = (await page.evaluate(() =>
      window.pyxis.invoke("chats.ask", {
        text: "Com'è fatto il seno?",
        allowGeneral: true,
      }),
    )) as { chatId: string; message: { figures?: Record<string, string> } };
    expect(Object.keys(asked.message.figures ?? {})).toHaveLength(1);
    await page.evaluate((chatId) => {
      location.hash = `/ask/${chatId}`;
    }, asked.chatId);
    await expect(page.locator(".px-msg figure.px-figure")).toHaveCount(1);
    await expect(page.getByText("Il massimo è in")).toBeVisible();
    await expect(page.getByText("pyxis-")).toHaveCount(0);
    expect(
      (await new AxeBuilder({ page }).setLegacyMode(true).analyze()).violations,
    ).toEqual([]);
    for (const [lang, theme, width] of [
      ["it", "dark", 1280],
      ["en", "light", 1280],
    ] as const) {
      await look(page, lang, theme, width);
      await expect(page.locator(".px-msg figure.px-figure")).toHaveCount(1);
      await page.screenshot({
        path: `${shots}/ask-${lang}-${theme}-${width}.png`,
      });
    }
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
