import { join } from "node:path";
import { openDatabase } from "./db/connection";
import { getFunnel, setApiKeys, setScratch } from "./engine/funnel";
import {
  attachRendererPort,
  bindEngines,
  bindRunner,
  bindChat,
  bindMaps,
  bindPlans,
  bindStudy,
  bindProfile,
  bindSources,
  broadcast,
} from "./ipc/server";
import { demoJob } from "./jobs/demo";
import { createRunner } from "./jobs/runner";

type CorePort = {
  on(event: "message", listener: (event: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
  start(): void;
  close(): void;
};

type ParentEvent = {
  data?: {
    type?: string;
    workspacePath?: string;
    dev?: boolean;
    anthropic?: string;
    openai?: string;
  };
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
      setScratch(join(data.workspacePath, "scratch"));
      bindEngines(db);
      bindSources(db, data.workspacePath);
      bindChat(db);
      bindProfile(db);
      bindPlans(db);
      bindMaps(db);
      bindStudy(db);
      const runner = createRunner(db, (job) => broadcast("job.updated", job));
      runner.register("demo", demoJob);
      bindRunner(runner, data.dev === true);
      void getFunnel()
        .overview()
        .catch((err: unknown) => {
          console.error(
            "pyxis-core: overview failed",
            err instanceof Error ? err.message : "unknown",
          );
        });
      console.log("pyxis-core ready");
    }
    if (data?.type === "keys") {
      setApiKeys({ anthropic: data.anthropic, openai: data.openai });
    }
    if (data?.type === "shutdown") process.exit(0);
    const rendererPort = event.ports[0];
    if (rendererPort) attachRendererPort(rendererPort);
  });
}
