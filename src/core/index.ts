import { join } from "node:path";
import { openDatabase } from "./db/connection";
import { attachRendererPort, bindRunner, broadcast } from "./ipc/server";
import { demoJob } from "./jobs/demo";
import { createRunner } from "./jobs/runner";

type CorePort = {
  on(event: "message", listener: (event: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
  start(): void;
  close(): void;
};

type ParentEvent = {
  data?: { type?: string; workspacePath?: string; dev?: boolean };
  ports: CorePort[];
};

type ParentPort = {
  on(event: "message", listener: (event: ParentEvent) => void): void;
};

const parent = (process as NodeJS.Process & { parentPort?: ParentPort })
  .parentPort;

if (!parent) {
  console.error("pyxis-core: parentPort missing");
} else {
  let booted = false;
  parent.on("message", (event) => {
    const data = event.data;
    if (data?.type === "bootstrap" && !booted) {
      if (!data.workspacePath) {
        console.error("pyxis-core: workspace missing");
        return;
      }
      booted = true;
      const db = openDatabase(join(data.workspacePath, "pyxis.db"));
      const runner = createRunner(db, (job) => broadcast("job.updated", job));
      runner.register("demo", demoJob);
      bindRunner(runner, data.dev === true);
      console.log("pyxis-core ready");
    }
    if (data?.type === "shutdown") process.exit(0);
    const rendererPort = event.ports[0];
    if (rendererPort) attachRendererPort(rendererPort);
  });
}
