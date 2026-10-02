import { receiveRuntimeReply, setRuntimeSender } from "./math/runtime-client";
import { recordedPlanRun } from "./engine/recorded-plan";
import { join } from "node:path";
import { openDatabase } from "./db/connection";
import { getFunnel, setApiKeys, setScratch } from "./engine/funnel";
import {
  attachRendererPort,
  bindEngines,
  bindRunner,
  bindChat,
  bindTools,
  bindMaps,
  bindPlans,
  bindStudy,
  bindProfile,
  bindSources,
  broadcast,
} from "./ipc/server";
import { demoJob } from "./jobs/demo";
import { createRunner } from "./jobs/runner";

import { setSourceWorkerDirectory } from "./sources/worker-client";

setSourceWorkerDirectory(import.meta.dirname);

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
    id?: string;
    result?: unknown;
    error?: string;
  };
  ports: CorePort[];
};

type ParentPort = {
  postMessage(message: unknown): void;
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
    if (data?.type === "runtime-result" && data.id)
      receiveRuntimeReply({
        id: data.id,
        result: data.result,
        error: data.error,
      });
    if (data?.type === "bootstrap" && !booted) {
      if (!data.workspacePath) {
        console.error("pyxis-core: workspace missing");
        return;
      }
      booted = true;
      setRuntimeSender((message) => parent.postMessage(message));
      const db = openDatabase(join(data.workspacePath, "pyxis.db"));
      setScratch(join(data.workspacePath, "scratch"));
      bindEngines(db);
      const runner = createRunner(db, (job) => {
        if (
          job.kind === "source-import" &&
          ["failed", "cancelled", "interrupted"].includes(job.state)
        ) {
          db.prepare(
            `UPDATE sources SET status = ?, updated_at = ?
            WHERE id = (SELECT json_extract(params_json, '$.sourceId') FROM jobs WHERE id = ?)
              AND status != 'removed'`,
          ).run(job.state, Date.now(), job.id);
        }
        broadcast("job.updated", job);
      });
      bindSources(db, data.workspacePath, runner);
      // ponytail: unpackaged tests pass a recorded reply; a packaged app never reads it. Upgrade path is the engine fixture files in plan section 12.
      bindChat(
        db,
        data.workspacePath,
        data.dev === true ? process.env["PYXIS_E2E_REPLY"] : undefined,
      );
      bindProfile(db);
      const planFixture =
        data.dev === true ? process.env["PYXIS_E2E_PLAN_REPLIES"] : undefined;
      bindPlans(
        db,
        data.workspacePath,
        runner,
        planFixture
          ? recordedPlanRun(
              planFixture,
              Number(process.env["PYXIS_E2E_PLAN_DELAY"] ?? 0),
            )
          : undefined,
      );
      bindMaps(db);
      bindTools();
      bindStudy(
        db,
        runner,
        planFixture
          ? recordedPlanRun(
              planFixture,
              Number(process.env["PYXIS_E2E_PLAN_DELAY"] ?? 0),
            )
          : undefined,
      );
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
      process.parentPort.postMessage({ type: "keys-applied" });
    }
    if (data?.type === "shutdown") process.exit(0);
    const rendererPort = event.ports[0];
    if (rendererPort) attachRendererPort(rendererPort);
  });
}
