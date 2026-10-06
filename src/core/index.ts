import type { FileGrant } from "./ipc/file-grants";
import { receiveRuntimeReply, setRuntimeSender } from "./math/runtime-client";
import { recordedPlanRun } from "./engine/recorded-plan";
import { join } from "node:path";
import { openDatabase } from "./db/connection";
import { getFunnel, setApiKeys, setScratch } from "./engine/funnel";
import {
  attachRendererPort,
  addFileGrants,
  bindEngines,
  refreshAutoEngines,
  removeEngineSelections,
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
import { markStoppedImport } from "./sources/jobs";

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
    grants?: FileGrant[];
    dev?: boolean;
    removedProvider?: string;
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
  const port = parent;
  let booted = false;
  let jobRunner: ReturnType<typeof createRunner> | undefined;
  let developmentSeam = false;

  function failBootstrap(err: unknown): void {
    console.error(
      "pyxis-core: bootstrap failed",
      err instanceof Error ? err.message : "unknown",
    );
    port.postMessage({ type: "core-failed" });
    // Main also terminates this process; exiting here covers a lost message.
    setTimeout(() => process.exit(1), 100);
  }

  function bootstrap(workspacePath: string, dev: boolean): void {
    setRuntimeSender((message) => port.postMessage(message));
    const db = openDatabase(join(workspacePath, "pyxis.db"));
    setScratch(join(workspacePath, "scratch"));
    // Explicit recorded fixtures may use a deterministic selection in their
    // private test workspace. Normal launches require a confirmed engine.
    const recordedFixture =
      dev &&
      [
        "PYXIS_E2E_PLAN_REPLIES",
        "PYXIS_E2E_MAP_REPLIES",
        "PYXIS_E2E_SIMULATION_REPLIES",
        "PYXIS_E2E_REPLY",
      ].some((key) => process.env[key]);
    if (recordedFixture) {
      db.prepare(
        "INSERT OR IGNORE INTO feature_engines (feature, selection_json, updated_at) VALUES ('default', ?, ?)",
      ).run(
        JSON.stringify({ provider: "claude", model: "recorded-fixture" }),
        Date.now(),
      );
    }
    bindEngines(db);
    const runner = createRunner(
      db,
      (job) => {
        markStoppedImport(db, job);
        broadcast("job.updated", job);
      },
      undefined,
      true,
    );
    jobRunner = runner;
    bindSources(db, workspacePath, runner);
    // Recorded replies require the explicit dev/test seam; packaged launches only enable it with PYXIS_E2E=1.
    bindChat(
      db,
      workspacePath,
      dev ? process.env["PYXIS_E2E_REPLY"] : undefined,
    );
    bindProfile(db);
    const planFixture = dev ? process.env["PYXIS_E2E_PLAN_REPLIES"] : undefined;
    bindPlans(
      db,
      workspacePath,
      runner,
      planFixture
        ? recordedPlanRun(
            planFixture,
            Number(process.env["PYXIS_E2E_PLAN_DELAY"] ?? 0),
          )
        : undefined,
    );
    const mapFixture = dev ? process.env["PYXIS_E2E_MAP_REPLIES"] : undefined;
    bindMaps(
      db,
      runner,
      mapFixture
        ? recordedPlanRun(
            mapFixture,
            Number(process.env["PYXIS_E2E_MAP_DELAY"] ?? 0),
          )
        : undefined,
    );
    bindTools(workspacePath, runner);
    bindStudy(
      db,
      runner,
      planFixture
        ? recordedPlanRun(
            planFixture,
            Number(process.env["PYXIS_E2E_PLAN_DELAY"] ?? 0),
          )
        : undefined,
      dev && process.env["PYXIS_E2E_SIMULATION_REPLIES"]
        ? recordedPlanRun(
            process.env["PYXIS_E2E_SIMULATION_REPLIES"]!,
            Number(process.env["PYXIS_E2E_SIMULATION_DELAY"] ?? 0),
          )
        : undefined,
    );
    runner.register("demo", demoJob);
    bindRunner(runner, dev);
    void getFunnel()
      .overview()
      .catch((err: unknown) => {
        console.error(
          "pyxis-core: overview failed",
          err instanceof Error ? err.message : "unknown",
        );
      });
    // Fixture workspaces keep their seeded engine; real ones pick engines from what is ready now.
    if (!recordedFixture) refreshAutoEngines();
    console.log("pyxis-core ready");
    // Healthy-ready handshake: main waits for this before sending keys/ports.
    port.postMessage({ type: "core-ready" });
  }

  port.on("message", (event) => {
    const data = event.data;
    if (data?.type === "runtime-result" && data.id)
      receiveRuntimeReply({
        id: data.id,
        result: data.result,
        error: data.error,
      });
    if (data?.type === "file-grants" && data.grants) {
      addFileGrants(data.grants);
      port.postMessage({ type: "file-grants-applied", id: data.id });
    }
    if (data?.type === "bootstrap" && !booted) {
      addFileGrants(data.grants ?? []);
      const workspacePath = data.workspacePath;
      if (!workspacePath) {
        failBootstrap(new Error("workspace missing"));
        return;
      }
      booted = true;
      const dev = data.dev === true;
      developmentSeam = dev && process.env["PYXIS_E2E"] === "1";
      // Deterministic slow-start seam for the recovery E2E; needs PYXIS_E2E=1.
      const delay =
        dev && process.env["PYXIS_E2E"] === "1"
          ? Math.min(Number(process.env["PYXIS_E2E_CORE_DELAY"]) || 0, 15_000)
          : 0;
      void (async () => {
        if (delay > 0) await new Promise((r) => setTimeout(r, delay));
        try {
          bootstrap(workspacePath, dev);
        } catch (err) {
          failBootstrap(err);
        }
      })();
    }
    if (data?.type === "keys") {
      void (async () => {
        const delay = developmentSeam
          ? Math.min(Number(process.env["PYXIS_E2E_KEYS_DELAY"]) || 0, 15000)
          : 0;
        if (delay > 0)
          await new Promise((resolve) => setTimeout(resolve, delay));
        setApiKeys({ anthropic: data.anthropic, openai: data.openai });
        if (
          data.removedProvider === "anthropic-api" ||
          data.removedProvider === "openai-api"
        )
          removeEngineSelections(data.removedProvider);
        refreshAutoEngines();
        port.postMessage({ type: "keys-applied" });
        jobRunner?.activate();
      })();
    }
    if (data?.type === "shutdown") process.exit(0);
    const rendererPort = event.ports[0];
    if (rendererPort) attachRendererPort(rendererPort);
  });
}
