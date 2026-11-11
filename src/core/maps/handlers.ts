import type Database from "better-sqlite3";
import type { MapOp } from "./graph";
import type { Runner } from "../jobs/runner";
import type { GenerateInput } from "../engine/generate";
import {
  deleteMapAndBuilds,
  editMap,
  mapBuild,
  enqueueMaps,
  registerMapJobs,
} from "./generate";
import {
  listMaps,
  moveMapNode,
  openMap,
  patchMap,
  setMapLayout,
  undoMap,
  redoMap,
  renameMap,
} from "./store";
import { listAllMaps } from "./library";
import { exportMap, type MapExportLanguage } from "./export";
import { describeScope, mapScope, type MapAddress } from "./scope";

/** Every map request names a topic or a subject (`MapAddress`); `mapScope` turns that into the row it means. */
export function mapHandlers(
  db: Database.Database,
  runner: Runner,
  run?: GenerateInput["run"],
) {
  registerMapJobs(db, runner, run);
  const scope = (input: MapAddress) => mapScope(db, input);
  return {
    scope(input: MapAddress) {
      return describeScope(db, scope(input));
    },
    build(input: MapAddress & { jobId?: string }) {
      return mapBuild(db, scope(input), input.jobId);
    },
    all(input: { query?: string }) {
      return listAllMaps(db, input.query);
    },
    export(input: MapAddress & { mapId?: string; language: MapExportLanguage }) {
      return exportMap(db, scope(input), input);
    },
    list(input: MapAddress) {
      return listMaps(db, scope(input));
    },
    generate(input: MapAddress & { instruction?: string }) {
      return enqueueMaps(db, runner, scope(input), input.instruction);
    },
    edit(input: MapAddress & { mapId?: string; instruction: string }, signal?: AbortSignal) {
      return editMap(
        db,
        { ...scope(input), mapId: input.mapId, instruction: input.instruction },
        run,
        signal,
      );
    },
    open(input: MapAddress & { mapId?: string }) {
      return openMap(db, scope(input), Date.now(), input.mapId);
    },
    layout(input: MapAddress & { mapId?: string; layout: "tree" | "radial" }) {
      return setMapLayout(db, scope(input), input.layout, input.mapId);
    },
    move(input: MapAddress & { mapId?: string; nodeId: string; x: number; y: number }) {
      return moveMapNode(db, scope(input), input.nodeId, input.x, input.y, input.mapId);
    },
    patch(input: MapAddress & { mapId?: string; ops: MapOp[] }) {
      return patchMap(db, scope(input), input.ops, input.mapId);
    },
    rename(input: MapAddress & { mapId: string; title: string }) {
      return renameMap(db, scope(input), input.mapId, input.title);
    },
    delete(input: MapAddress & { mapId?: string; jobId?: string }) {
      return { deleted: deleteMapAndBuilds(db, runner, scope(input), input) };
    },
    redo(input: MapAddress & { mapId?: string }) {
      return redoMap(db, scope(input), input.mapId);
    },
    undo(input: MapAddress & { mapId?: string }) {
      return undoMap(db, scope(input), input.mapId);
    },
  };
}
