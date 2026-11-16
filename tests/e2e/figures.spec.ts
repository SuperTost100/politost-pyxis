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
  readdirSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { figureProgram } from "../../src/core/math/figure-program";
import { importPickedSource } from "./picked-source";
import { launchPyxis } from "./app-under-test";
import { makeBook } from "./book";
import { expectNoAxeViolations } from "./axe";
import { saveShot } from "./shots";
import { removeTestFolder } from "./cleanup";
import { fromChiediToExams } from "./doors";

// Without a kind the block is a plot, as every figure was before circuits.
const figure = (caption: string, code: string, kind?: "circuit") =>
  ["```pyxis-figure", JSON.stringify({ kind, caption, code }), "```"].join("\n");
const block = (kind: string, body: unknown) =>
  ["```pyxis-" + kind, JSON.stringify(body), "```"].join("\n");

const rc =
  "d += elm.SourceV().up().label('$V_s$')\nd += elm.Resistor().right().label('R = 1 kΩ')\nd += elm.Capacitor().down().label('C = 1 µF', loc='bottom')\nd += elm.Line().left()";
const divider =
  "d += elm.SourceV().up().label('12 V')\nd += elm.Line().right()\nd += elm.Resistor().down().label('$R_1$')\nd += elm.Dot()\nd.push()\nd += elm.Line().right().length(1.5)\nd += elm.Dot(open=True).label('$V_{out}$', loc='right')\nd.pop()\nd += elm.Resistor().down().label('$R_2$')\nd += elm.Line().left()\nd += elm.Line().up()";

/** Stages the pinned packs as a workspace that finished the Python download has them. */
function stagePacks(userData: string) {
  for (const pack of ["pyodide", "drawing"]) {
    const { version } = JSON.parse(
      readFileSync(`resources/${pack}-manifest.json`, "utf8"),
    ) as { version: string };
    const folder = join(userData, "workspace/runtimes", pack, version);
    mkdirSync(folder, { recursive: true });
    cpSync(`.tmp/${pack}`, folder, { recursive: true });
  }
}
const packsPinned = () =>
  existsSync(".tmp/pyodide/pyodide.js") &&
  existsSync(".tmp/drawing/schemdraw-0.23-py3-none-any.whl");

const vectors =
  "fig, ax = plt.subplots(figsize=(5, 4))\nfor (dx, dy, c, name) in [(3, 1, '#3262db', 'F1'), (1, 2, '#1a9165', 'F2'), (4, 3, '#b7790c', 'F1 + F2')]:\n    ax.annotate('', xy=(dx, dy), xytext=(0, 0), arrowprops=dict(arrowstyle='->', color=c, lw=2))\n    ax.text(dx + 0.1, dy + 0.1, name, color=c)\nax.plot([3, 4, 1], [1, 3, 2], ls='--', color='gray')\nax.set_xlim(-0.5, 5)\nax.set_ylim(-0.5, 4)\nax.set_aspect('equal')";
// The same code with one method misspelt: Python's AttributeError is what the fix call is sent.
const vectorsTypo = vectors.replace("ax.annotate", "ax.annotat");

// A recorded lesson with three figures that draw (a function plot, a vector diagram whose first code fails and is fixed,
// and a circuit) and one whose code fails and whose fix fails too.
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
    vectorsTypo,
  ),
  "",
  figure("Un circuito che non si disegna.", "raise ValueError('figura rotta')"),
  "",
  "## Un circuito RC",
  "",
  "Un condensatore si carica attraverso un resistore con costante di tempo $\\tau = RC$.",
  "",
  figure("Il circuito RC in serie con il generatore $V_s$.", rc, "circuit"),
  "",
  block("check", {
    question: "Se raddoppi il tempo, la posizione…",
    options: ["quadruplica", "raddoppia", "non cambia"],
    answer: 0,
    explanation: "$x$ è proporzionale a $t^2$.",
  }),
].join("\n");

// A recorded Ask answer with a plot and a circuit.
const answer = [
  "Il seno oscilla tra $-1$ e $1$ con periodo $2\\pi$.",
  "",
  figure(
    "Il grafico di $\\sin x$ su due periodi.",
    "x = np.linspace(0, 4 * np.pi, 400)\nplt.plot(x, np.sin(x), color='#3262db')\nplt.axhline(0, color='gray', lw=0.8)\nplt.xlabel('x')",
  ),
  "",
  "Il massimo è in $x = \\pi/2$.",
  "",
  "Un partitore di tensione divide la tensione in proporzione alle resistenze.",
  "",
  figure("Un partitore di tensione con uscita su $R_2$.", divider, "circuit"),
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

test("plots and circuits in a lesson and an Ask answer are drawn in the Python sandbox, and a failed one is left out", async () => {
  test.skip(
    !packsPinned(),
    "Requires the pinned Pyodide and drawing fixtures in .tmp/pyodide and .tmp/drawing.",
  );
  // Each figure starts a fresh Pyodide worker that loads numpy and matplotlib.
  test.setTimeout(300000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-figures-"));
  stagePacks(userData);
  const book = join(userData, "fisica.ptsb");
  writeFileSync(
    book,
    makeBook({
      id: "figures",
      chapters: [{ title: "Moto", text: "## p1 | Moto\nNel moto accelerato la posizione cresce col quadrato del tempo.\n" }],
    }),
  );
  const replies = {
    markdown: { markdown: lesson },
    // Fixes are answered in the order the figures are written: the vector diagram's typo is corrected, and the
    // circuit that cannot be drawn gets a fix call that fails.
    figureFix: [{ code: vectors }, { fail: "the engine is out" }],
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
  const prompts = join(userData, "study-prompts.log");
  const env = {
    PYXIS_E2E_PLAN_REPLIES: JSON.stringify(replies),
    PYXIS_E2E_PLAN_PROMPTS: prompts,
    PYXIS_E2E_REPLY: answer,
  };
  const app = await launchPyxis({ userData, env });
  try {
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(page);
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
    await expect(figures).toHaveCount(3, { timeout: 120000 });
    await expect(figures.first().getByRole("img")).toHaveAttribute(
      "alt",
      /La posizione/,
    );
    await expect(figures.nth(1).getByRole("img")).toHaveAttribute(
      "alt",
      /regola del parallelogramma/,
    );
    await expect(figures.nth(2).getByRole("img")).toHaveAttribute(
      "alt",
      /circuito RC in serie/,
    );
    const widths = await figures
      .getByRole("img")
      .evaluateAll((images) =>
        images.map((image) => (image as HTMLImageElement).naturalWidth),
      );
    expect(widths).toHaveLength(3);
    // Every image is a real drawing, the circuit at a size that reads in the text column.
    for (const width of widths) {
      expect(width).toBeGreaterThanOrEqual(200);
      expect(width).toBeLessThanOrEqual(2000);
    }
    // Two figures failed and each was sent to the model once, with its block and the error and nothing else.
    const fixes = readFileSync(prompts, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string)
      .filter((prompt) => prompt.startsWith('{"kind":'))
      .map((prompt) => JSON.parse(prompt) as Record<string, string>);
    expect(fixes.map((fix) => [fix.kind, fix.caption])).toEqual([
      ["plot", "La somma di $\\vec F_1$ e $\\vec F_2$ con la regola del parallelogramma."],
      // Written without a kind, so a plot, whatever its caption says.
      ["plot", "Un circuito che non si disegna."],
    ]);
    expect(Object.keys(fixes[0]!).sort()).toEqual(["caption", "code", "error", "kind"]);
    expect(fixes[0]!.error).toContain("AttributeError");
    expect(fixes[0]!.code).toBe(vectorsTypo);
    expect(fixes[1]!.error).toContain("figura rotta");
    // The vector diagram that was fixed shows, and the circuit that was not is gone, with no code or JSON left on the page;
    // the lesson around it is whole.
    await expect(page.getByText("Un circuito che non si disegna.")).toHaveCount(
      0,
    );
    await expect(page.getByText("figura rotta")).toHaveCount(0);
    await expect(page.getByText("pyxis-")).toHaveCount(0);
    await expect(
      page.getByText("Se raddoppi il tempo, la posizione…"),
    ).toBeVisible();
    await expectNoAxeViolations(page);
    for (const [lang, theme, width] of [
      ["it", "light", 1280],
      ["it", "dark", 1280],
      ["en", "dark", 960],
      ["en", "light", 960],
    ] as const) {
      await look(page, lang, theme, width);
      // Reopening reads the cached lesson and its images; nothing runs again.
      await expect(figures).toHaveCount(3);
      await figures.first().scrollIntoViewIfNeeded();
      await saveShot(page, `figures/lesson-${lang}-${theme}-${width}.png`);
      await figures.nth(1).scrollIntoViewIfNeeded();
      await saveShot(page, `figures/lesson-vectors-${lang}-${theme}-${width}.png`);
      await figures.nth(2).scrollIntoViewIfNeeded();
      await saveShot(page, `figures/lesson-circuit-${lang}-${theme}-${width}.png`);
    }

    const asked = (await page.evaluate(() =>
      window.pyxis.invoke("chats.ask", {
        text: "Com'è fatto il seno?",
        allowGeneral: true,
      }),
    )) as { chatId: string; message: { figures?: Record<string, string> } };
    expect(Object.keys(asked.message.figures ?? {})).toHaveLength(2);
    await page.evaluate((chatId) => {
      location.hash = `/ask/${chatId}`;
    }, asked.chatId);
    const drawn = page.locator(".px-msg figure.px-figure");
    await expect(drawn).toHaveCount(2);
    await expect(drawn.nth(1).getByRole("img")).toHaveAttribute(
      "alt",
      /partitore di tensione/,
    );
    await expect(page.getByText("Il massimo è in")).toBeVisible();
    await expect(page.getByText("pyxis-")).toHaveCount(0);
    await expectNoAxeViolations(page);
    for (const [lang, theme, width] of [
      ["it", "dark", 1280],
      ["en", "light", 1280],
    ] as const) {
      await look(page, lang, theme, width);
      await expect(drawn).toHaveCount(2);
      await saveShot(page, `figures/ask-${lang}-${theme}-${width}.png`);
      await drawn.nth(1).scrollIntoViewIfNeeded();
      await saveShot(page, `figures/ask-circuit-${lang}-${theme}-${width}.png`);
    }
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("a circuit whose code reaches for the network or the host fails with an error, and nothing leaves the sandbox", async () => {
  test.skip(
    !packsPinned(),
    "Requires the pinned Pyodide and drawing fixtures in .tmp/pyodide and .tmp/drawing.",
  );
  // Each run starts a fresh Pyodide worker that loads matplotlib.
  test.setTimeout(300000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-figures-hostile-"));
  stagePacks(userData);
  // Something to reach: a local server that counts what arrives, a path on this machine that must stay empty, and a
  // file on this machine that must stay as it is and never be read.
  const arrived: string[] = [];
  const server = createServer((request, response) => {
    arrived.push(request.url ?? "");
    response.end("leaked");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const leak = `http://127.0.0.1:${(server.address() as AddressInfo).port}/leak`;
  // A folder of its own, which only the test writes to: the profile's folder next to it fills with the app's files.
  const bait = join(userData, "bait");
  mkdirSync(bait);
  const planted = join(bait, "planted.txt");
  const secretFile = join(bait, "secret.txt");
  const secret = `SECRET-${Math.random().toString(36).slice(2)}`;
  writeFileSync(secretFile, secret);
  // The same paths with forward slashes, which is how the sandbox's own file system spells a path on every platform.
  // On Windows the native form, `C:\Users\...`, has none, and the sandbox takes it for one file name in its working
  // folder, so only this form is a path to a folder that does not exist there.
  const slashed = (path: string) => path.replaceAll("\\", "/");
  const hostFiles = () => ({
    secret: readFileSync(secretFile, "utf8"),
    folder: readdirSync(bait).sort(),
  });
  const hostBefore = hostFiles();
  // Each adds a resistor first, so schemdraw is at work and the code would give a drawing if its reach were allowed.
  // The error is the one the reach itself gets, on the last line of Python's traceback.
  const hostile = {
    fetch: [
      `d += elm.Resistor()\nimport js\nawait js.fetch(${JSON.stringify(leak)})`,
      /JsException: TypeError: Failed to fetch$/,
    ],
    urlopen: [
      `d += elm.Resistor()\nimport urllib.request\nurllib.request.urlopen(${JSON.stringify(leak)})`,
      /URLError: <urlopen error .*Socket not connected>$/,
    ],
    importScripts: [
      `d += elm.Resistor()\nimport js\njs.importScripts(${JSON.stringify(leak)})`,
      /JsException: NetworkError: .*failed to load\.$/,
    ],
    open: [
      `d += elm.Resistor()\nopen(${JSON.stringify(slashed(planted))}, 'w').write('x')`,
      /FileNotFoundError: .*No such file or directory/,
    ],
    read: [
      `d += elm.Resistor()\nprint(open(${JSON.stringify(slashed(secretFile))}).read())`,
      /FileNotFoundError: .*No such file or directory/,
    ],
    node: [
      `d += elm.Resistor()\nimport js\njs.require('fs').writeFileSync(${JSON.stringify(planted)}, 'x')`,
      /AttributeError: require$/,
    ],
    subprocess: [
      `d += elm.Resistor()\nimport subprocess\nsubprocess.run(['touch', ${JSON.stringify(planted)}])`,
      /OSError: .*emscripten does not support processes\.$/,
    ],
  } as const;
  // The answer a model, or a plan file, could carry: one honest circuit and three that reach out.
  const reply = [
    "Un partitore di tensione.",
    "",
    figure("Un partitore onesto.", divider, "circuit"),
    "",
    figure("Chiama la rete.", hostile.fetch[0], "circuit"),
    "",
    figure("Apre un indirizzo.", hostile.urlopen[0], "circuit"),
    "",
    figure("Scrive sul disco.", hostile.open[0], "circuit"),
    "",
    figure("Legge dal disco.", hostile.read[0], "circuit"),
    "",
    "Fine.",
  ].join("\n");
  const app = await launchPyxis({ userData, env: { PYXIS_E2E_REPLY: reply } });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(page);
    const run = async (name: string, code: string) =>
      (await page.evaluate(
        (code) => window.pyxis.invoke("tools.python", { code }),
        figureProgram({ caption: name, code, figureKind: "circuit" }),
      )) as { stdout: string; stderr: string; images?: string[]; timedOut: boolean };
    for (const [name, [code, error]] of Object.entries(hostile)) {
      const result = await run(name, code);
      // Python's own error, and no image: the drawing after the code never ran.
      expect(result.stderr.trim().split("\n").at(-1), name).toMatch(error);
      expect(result.images ?? [], name).toEqual([]);
      expect(result.timedOut, name).toBe(false);
    }
    // The paths as the platform spells them, on Linux and macOS with their slashes and on Windows with backslashes. A
    // Windows path is one file name to the sandbox, so writing it can succeed there, in the sandbox's own memory: the
    // outcome that holds everywhere is that the host's file is neither read nor written, and a run gives back an error
    // or a PNG and nothing else.
    const native = {
      write: `d += elm.Resistor()\nopen(${JSON.stringify(planted)}, 'w').write('x')`,
      read: `d += elm.Resistor()\nprint(open(${JSON.stringify(secretFile)}).read())`,
      // A Windows path on any platform, which the sandbox takes as a name in its own working folder: the file it
      // makes is there, in memory, and the host has no such file.
      windows: `import os\nd += elm.Resistor()\nopen('C:\\\\pyxis-sandbox\\\\planted.txt', 'w').write('x')\nprint(sorted(os.listdir('.')))`,
    };
    for (const [name, code] of Object.entries(native)) {
      const result = await run(name, code);
      expect(result.stdout, name).not.toContain(secret);
      expect(result.timedOut, name).toBe(false);
      for (const image of result.images ?? [])
        expect(image, name).toMatch(/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/);
      // Either Python's error with no image, or the run went on and drew: never a half answer.
      expect((result.images ?? []).length > 0 || result.stderr.trim() !== "", name).toBe(true);
      if (name === "windows") {
        expect(result.stderr, name).toBe("");
        // The list's repr writes each backslash of the name twice.
        expect(result.stdout, name).toContain("C:\\\\pyxis-sandbox\\\\planted.txt");
      }
    }
    expect(existsSync(planted)).toBe(false);
    expect(existsSync(join(process.cwd(), "C:\\pyxis-sandbox\\planted.txt"))).toBe(false);
    expect(hostFiles()).toEqual(hostBefore);
    // Through the whole path of an answer: the honest circuit is stored and shown, the others are gone.
    const asked = (await page.evaluate(() =>
      window.pyxis.invoke("chats.ask", {
        text: "Come funziona un partitore?",
        allowGeneral: true,
      }),
    )) as {
      chatId: string;
      message: { body: string; figures?: Record<string, string> };
    };
    expect(Object.keys(asked.message.figures ?? {})).toHaveLength(1);
    expect(asked.message.body).toContain("Un partitore onesto.");
    for (const caption of ["Chiama la rete.", "Apre un indirizzo.", "Scrive sul disco.", "Legge dal disco."])
      expect(asked.message.body).not.toContain(caption);
    expect(asked.message.body).toContain("Fine.");
    await page.evaluate((chatId) => {
      location.hash = `/ask/${chatId}`;
    }, asked.chatId);
    await expect(page.locator(".px-msg figure.px-figure")).toHaveCount(1);
    await expect(page.getByText("pyxis-")).toHaveCount(0);
    // Nothing reached the server, and nothing was written on this machine.
    expect(arrived).toEqual([]);
    expect(existsSync(planted)).toBe(false);
  } finally {
    await app.close();
    await new Promise((resolve) => server.close(resolve));
    removeTestFolder(userData);
  }
});

const answerWith = (...blocks: string[]) =>
  ["Un partitore di tensione divide la tensione in proporzione alle resistenze.", "", ...blocks, "", "Fine della risposta."].join("\n");

/** Sends a question from the Ask page and returns once the first reply is on its way. */
async function askFromPage(page: Page, text: string) {
  await page.evaluate(() => {
    location.hash = "/ask";
  });
  const box = page.getByRole("textbox", { name: "Messaggio" });
  await box.fill(text);
  await box.press("Enter");
}

test("an answer's figure that failed shows its working state while it is fixed, then shows the fixed figure in place", async () => {
  test.skip(
    !packsPinned(),
    "Requires the pinned Pyodide and drawing fixtures in .tmp/pyodide and .tmp/drawing.",
  );
  test.setTimeout(300000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-figures-retry-"));
  stagePacks(userData);
  const release = join(userData, "release-fix");
  const brokenCircuit = divider.replace("elm.Dot(open=True)", "elm.DotOpen()");
  const env = {
    // No signed-in AI tools of this machine in view.
    HOME: userData,
    PYXIS_E2E_REPLY: answerWith(figure("Un partitore di tensione.", brokenCircuit, "circuit")),
    // The answer streams for a moment, so the page is in its working state; the fix waits for the test.
    PYXIS_E2E_REPLY_DELAY: "1500",
    PYXIS_E2E_PLAN_REPLIES: JSON.stringify({ figureFix: [{ code: divider, hold: release }] }),
  };
  const app = await launchPyxis({ userData, env });
  try {
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(page);
    await askFromPage(page, "Come funziona un partitore di tensione?");
    // The first drawing fails (a misspelt element), and the call that corrects it waits for the test. All this time the
    // figure's place holds its working state, with the answer's text around it.
    const working = page.locator(".px-figure.is-drawing");
    await expect(working).toBeVisible({ timeout: 120000 });
    await expect(page.getByText("Un partitore di tensione divide la tensione")).toBeVisible();
    // Long enough for the first drawing to have failed and the fix call to be waiting.
    await page.waitForTimeout(15000);
    await expect(working).toBeVisible();
    await expect(page.getByText("Fine della risposta.")).toBeVisible();
    await expect(page.locator("figure.px-figure")).toHaveCount(0);
    await saveShot(page, "retry/working-it-light.png");
    await page.evaluate(() => window.pyxis.setAppearance("dark"));
    // The theme fades in; the shot waits for it to settle.
    await page.waitForTimeout(600);
    await saveShot(page, "retry/working-it-dark.png");
    await page.evaluate(() => window.pyxis.setAppearance("light"));

    writeFileSync(release, "go");
    // The figure takes the place the working state held: one figure on the page where the placeholder was.
    const shown = page.locator("figure.px-figure");
    await expect(shown).toHaveCount(1, { timeout: 120000 });
    await expect(working).toHaveCount(0);
    await expect(shown.getByRole("img")).toHaveAttribute("alt", /partitore di tensione/);
    await expect
      .poll(() => shown.getByRole("img").evaluate((image) => (image as HTMLImageElement).naturalWidth))
      .toBeGreaterThanOrEqual(200);
    await expect(page.getByText("Fine della risposta.")).toBeVisible();
    await expect(page.getByText("pyxis-")).toHaveCount(0);
    await expect(page.getByText("DotOpen")).toHaveCount(0);
    await expectNoAxeViolations(page);
    await saveShot(page, "retry/fixed-it-light.png");
    await page.evaluate(() => window.pyxis.setAppearance("dark"));
    // The theme fades in; the shot waits for it to settle.
    await page.waitForTimeout(600);
    await saveShot(page, "retry/fixed-it-dark.png");
    // The saved message carries the corrected block and its image.
    const chats = (await page.evaluate(() => window.pyxis.invoke("chats.list", {}))) as Array<{ id: string }>;
    const saved = (await page.evaluate(
      (chatId) => window.pyxis.invoke("chats.read", { chatId }),
      chats[0]!.id,
    )) as { messages: Array<{ role: string; body: string; figures?: Record<string, string> }> };
    const reply = saved.messages.find((message) => message.role === "assistant")!;
    expect(Object.keys(reply.figures ?? {})).toHaveLength(1);
    expect(reply.body).toContain("elm.Dot(open=True)");
    expect(reply.body).not.toContain("DotOpen");
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("when the fix fails too, the figure is dropped and the answer around it is whole", async () => {
  test.skip(
    !packsPinned(),
    "Requires the pinned Pyodide and drawing fixtures in .tmp/pyodide and .tmp/drawing.",
  );
  test.setTimeout(300000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-figures-retry-fails-"));
  stagePacks(userData);
  const brokenCircuit = "d += elm.SourceV().up()\nd += elm.NoSuchElement().right()";
  const brokenPlot = "plt.plot(this_name_does_not_exist)";
  const env = {
    HOME: userData,
    PYXIS_E2E_REPLY: answerWith(
      figure("Un partitore che non si disegna.", brokenCircuit, "circuit"),
      figure("Un grafico che non si disegna.", brokenPlot),
      figure("Un partitore che si disegna.", divider, "circuit"),
    ),
    // The first fix call fails, and the second answers with code that fails again.
    PYXIS_E2E_PLAN_REPLIES: JSON.stringify({
      figureFix: [{ fail: "the engine is out" }, { code: "plt.plot(still_not_defined)" }],
    }),
  };
  const app = await launchPyxis({ userData, env });
  try {
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(page);
    await askFromPage(page, "Come funziona un partitore di tensione?");
    const shown = page.locator("figure.px-figure");
    await expect(shown).toHaveCount(1, { timeout: 180000 });
    await expect(page.locator(".px-figure.is-drawing")).toHaveCount(0);
    await expect(shown.getByRole("img")).toHaveAttribute("alt", /che si disegna/);
    await expect(page.getByText("Un partitore di tensione divide la tensione")).toBeVisible();
    await expect(page.getByText("Fine della risposta.")).toBeVisible();
    for (const gone of ["che non si disegna", "NoSuchElement", "this_name_does_not_exist", "still_not_defined", "pyxis-"])
      await expect(page.getByText(gone)).toHaveCount(0);
    await saveShot(page, "retry/dropped-it-light.png");
    const chats = (await page.evaluate(() => window.pyxis.invoke("chats.list", {}))) as Array<{ id: string }>;
    const saved = (await page.evaluate(
      (chatId) => window.pyxis.invoke("chats.read", { chatId }),
      chats[0]!.id,
    )) as { messages: Array<{ role: string; body: string; figures?: Record<string, string> }> };
    const reply = saved.messages.find((message) => message.role === "assistant")!;
    expect(Object.keys(reply.figures ?? {})).toHaveLength(1);
    expect(reply.body).toBe(
      [
        "Un partitore di tensione divide la tensione in proporzione alle resistenze.",
        "",
        figure("Un partitore che si disegna.", divider, "circuit"),
        "",
        "Fine della risposta.",
      ].join("\n"),
    );
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});
