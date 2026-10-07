import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { _electron as electron, type Page } from "playwright";

/** Captures the README screenshots from invented fixture material. Run `npm run build` first. */

const require = createRequire(import.meta.url);
const electronPath = require("electron") as string;
const root = join(import.meta.dirname, "..");
const out = join(root, "docs", "screenshots");
const userData = mkdtempSync(join(tmpdir(), "pyxis-readme-"));
const day = 86_400_000;

const lesson = `# Newton's second law

The net force on a body equals its mass times its acceleration, $F = ma$ [P1]. Force and acceleration point the same way, so a push to the right speeds a cart up to the right.

## Worked example

A $2\\,\\text{kg}$ cart accelerates at $3\\,\\text{m/s}^2$. The net force is

$$F = 2 \\cdot 3 = 6\\,\\text{N}.$$

Double the mass at the same force and the acceleration halves [P2].`;

function seed(db: DatabaseSync) {
  const now = Date.now();
  db.exec(`
    INSERT INTO subjects(id,name,position,created_at) VALUES('s','Physics',0,1);
    INSERT INTO sources(id,kind,title,status,library,created_at,updated_at) VALUES('src','excerpt','Physics 1 lecture notes','ready',1,1,1);
    INSERT INTO source_documents(id,source_id,version,tree_json,created_at) VALUES('doc','src',1,'{"kind":"excerpt"}',1);
    INSERT INTO passages(id,source_id,document_id,text,locator_json,section_path,created_at) VALUES
      ('p1','src','doc','The net force acting on a body is equal to the product of its mass and its acceleration.','{"chapter":2,"paragraph":"p1"}','2. Dynamics',1),
      ('p2','src','doc','For a constant force, acceleration is inversely proportional to mass.','{"chapter":2,"paragraph":"p4"}','2. Dynamics',1);
    INSERT INTO plans(id,subject_id,title,status,content_language,target,exam_at,style,created_at,updated_at)
      VALUES('plan','s','Physics 1','ready','en',0.8,${now + 18 * day},'decide',1,1);
    INSERT INTO plan_sources(plan_id,source_id) VALUES('plan','src');
    INSERT INTO topics(id,plan_id,title,position,created_at) VALUES
      ('kin','plan','Kinematics',0,1),
      ('dyn','plan','Dynamics',1,1),
      ('work','plan','Work and energy',2,1);
    INSERT INTO topic_passages(topic_id,passage_id) VALUES('dyn','p1'),('dyn','p2'),('kin','p1'),('work','p2');
    INSERT INTO cards(id,plan_id,topic_id,front,back,passage_id,grounding,created_at)
      VALUES('card','plan','dyn','What does Newton''s second law state?','$F = ma$: net force equals mass times acceleration.','p1','sources',1);
    INSERT INTO chats(id,title,subject,created_at,updated_at) VALUES('chat','Newton''s second law','Physics',1,2);
    INSERT INTO messages(id,chat_id,role,body,created_at) VALUES('m1','chat','user','If I double the mass and keep the force the same, what happens to the acceleration?',1);
    INSERT INTO messages(id,chat_id,role,body,grounding,engine_provider,model_id,model_source,created_at)
      VALUES('m2','chat','assistant','It halves. From $F = ma$ you get $a = F/m$, so with $F$ fixed, $a$ is inversely proportional to $m$ [P1].\n\nTry it with numbers: $F = 6\\,\\text{N}$ gives $a = 3\\,\\text{m/s}^2$ for $2\\,\\text{kg}$ and $1.5\\,\\text{m/s}^2$ for $4\\,\\text{kg}$. Your notes state the same rule for a constant force [P2].','sources','claude','claude-sonnet-5','reported',2);
    INSERT INTO message_passages(message_id,passage_id,label) VALUES('m2','p1','P1'),('m2','p2','P2');
  `);
  // The same stage order plan creation writes, with the opening stages and Kinematics done.
  const stages: Array<[string | null, string, string]> = [
    [null, "intro", "Physics 1"],
    [null, "diagnostic", "Physics 1"],
  ];
  for (const [topic, title] of [
    ["kin", "Kinematics"],
    ["dyn", "Dynamics"],
    ["work", "Work and energy"],
  ] as const)
    for (const stage of ["learn", "practice", "cards", "gaps"])
      stages.push([topic, stage, title]);
  stages.push([null, "simulation", "Physics 1"], [null, "final", "Physics 1"]);
  const node = db.prepare(
    "INSERT INTO path_nodes(id,plan_id,topic_id,kind,position,title,created_at) VALUES(?,'plan',?,?,?,?,1)",
  );
  const event = db.prepare(
    "INSERT INTO learning_events(id,kind,plan_id,topic_id,payload_json,created_at) VALUES(?,?,'plan',?,?,?)",
  );
  stages.forEach(([topic, kind, title], i) => {
    node.run(`n${i}`, topic, kind, i, title);
    if (i < 6)
      event.run(
        `done${i}`,
        "lesson_completed",
        kind === "learn" ? topic : null,
        JSON.stringify({ nodeId: `n${i}` }),
        now - (6 - i) * day,
      );
  });
  for (let i = 0; i < 8; i++)
    event.run(
      `answer${i}`,
      "answer_given",
      "kin",
      JSON.stringify({ score: 0.9, scores: [0.9] }),
      now - i * 3_600_000,
    );
}

type Host = {
  pyxis: {
    setAppearance: (next: string) => Promise<unknown>;
    invoke: (channel: string, input: unknown) => Promise<unknown>;
  };
  location: { hash: string };
  localStorage: { setItem: (key: string, value: string) => void };
  scrollTo: (x: number, y: number) => void;
};

async function shoot(page: Page, hash: string, name: string, wait: string) {
  for (const theme of ["dark", "light"] as const) {
    await page.evaluate(
      ([t, next]) => {
        const host = globalThis as unknown as Host;
        host.location.hash = next;
        return host.pyxis.setAppearance(t);
      },
      [theme, hash] as const,
    );
    await page.reload();
    try {
      await page.getByText(wait).first().waitFor({ timeout: 10_000 });
    } catch (error) {
      await page.screenshot({ path: join(out, `${name}-failed.png`) });
      throw error;
    }
    await page.waitForTimeout(1000);
    await page.evaluate(() => (globalThis as unknown as Host).scrollTo(0, 0));
    await page.screenshot({ path: join(out, `${name}-${theme}.png`) });
  }
}

mkdirSync(out, { recursive: true });
const app = await electron.launch({
  executablePath: electronPath,
  args: [join(root, "out/main/index.js")],
  env: {
    ...process.env,
    PYXIS_USER_DATA: userData,
    PYXIS_E2E: "1",
    // The recorded-reply seam writes the lesson, so it renders the way a generated one does.
    PYXIS_E2E_PLAN_REPLIES: JSON.stringify({ markdown: { markdown: lesson } }),
  },
});
try {
  const page = await app.firstWindow();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.evaluate(() =>
    (globalThis as unknown as Host).localStorage.setItem("pyxis.lang", "en"),
  );
  await page.reload();
  await page.getByRole("button", { name: "Skip" }).click();
  // A first core request finishes migrations before the fixture rows go in.
  await page.evaluate(() =>
    (globalThis as unknown as Host).pyxis.invoke("plans.list", {}),
  );
  const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"));
  seed(db);
  db.close();
  await page.reload();
  await shoot(page, "#/plans/plan", "plan", "Physics 1");
  await shoot(page, "#/plans/plan/lesson/dyn", "lesson", "Worked example");
  await shoot(page, "#/ask/chat", "ask", "It halves.");
} finally {
  await app.close();
  rmSync(userData, { recursive: true, force: true });
}
