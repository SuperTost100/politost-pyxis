import type Database from "better-sqlite3";
import type { MapOp } from "./graph";
import type { Runner } from "../jobs/runner";
import type { GenerateInput } from "../engine/generate";
import {
  editMap,
  mapBuild,
  enqueueMaps,
  registerMapJobs,
} from "./generate";
import {
  listTopicMaps,
  moveTopicNode,
  openTopicMap,
  patchTopicMap,
  setTopicLayout,
  undoTopicMap,
  redoTopicMap,
} from "./store";
import { listAllMaps } from "./library";
import { exportMap, type MapExportLanguage } from "./export";
export function mapHandlers(
  db: Database.Database,
  runner: Runner,
  run?: GenerateInput["run"],
) {
  registerMapJobs(db, runner, run);
  return {
    build(input: { planId: string; topicId: string }) {
      return mapBuild(db, input);
    },
    all(input: { query?: string }) {
      return listAllMaps(db, input.query);
    },
    export(input: {
      planId: string;
      topicId: string;
      mapId?: string;
      language: MapExportLanguage;
    }) {
      return exportMap(db, input);
    },
    list(input: { planId: string; topicId: string }) {
      return listTopicMaps(db, input.planId, input.topicId);
    },
    generate(input: { planId: string; topicId: string }) {
      return enqueueMaps(db, runner, input);
    },
    edit(input: {
      planId: string;
      topicId: string;
      mapId?: string;
      instruction: string;
    }, signal?: AbortSignal) {
      return editMap(db, input, run, signal);
    },
    open(input: { planId: string; topicId: string; mapId?: string }) {
      return openTopicMap(
        db,
        input.planId,
        input.topicId,
        Date.now(),
        input.mapId,
      );
    },
    layout(input: {
      planId: string;
      topicId: string;
      mapId?: string;
      layout: "tree" | "radial";
    }) {
      return setTopicLayout(
        db,
        input.planId,
        input.topicId,
        input.layout,
        input.mapId,
      );
    },
    move(input: {
      planId: string;
      topicId: string;
      mapId?: string;
      nodeId: string;
      x: number;
      y: number;
    }) {
      return moveTopicNode(
        db,
        input.planId,
        input.topicId,
        input.nodeId,
        input.x,
        input.y,
        input.mapId,
      );
    },
    patch(input: {
      planId: string;
      topicId: string;
      mapId?: string;
      ops: MapOp[];
    }) {
      return patchTopicMap(
        db,
        input.planId,
        input.topicId,
        input.ops,
        input.mapId,
      );
    },
    redo(input: { planId: string; topicId: string; mapId?: string }) {
      return redoTopicMap(db, input.planId, input.topicId, input.mapId);
    },
    undo(input: { planId: string; topicId: string; mapId?: string }) {
      return undoTopicMap(db, input.planId, input.topicId, input.mapId);
    },
  };
}
