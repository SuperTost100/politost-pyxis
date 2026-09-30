import type Database from "better-sqlite3";
import type { MapOp } from "./graph";
import {
  moveTopicNode,
  openTopicMap,
  patchTopicMap,
  setTopicLayout,
  undoTopicMap,
} from "./store";

export function mapHandlers(db: Database.Database) {
  return {
    open(input: { planId: string; topicId: string }) {
      return openTopicMap(db, input.planId, input.topicId);
    },
    layout(input: { planId: string; topicId: string; layout: "tree" | "radial" }) {
      return setTopicLayout(db, input.planId, input.topicId, input.layout);
    },
    move(input: { planId: string; topicId: string; nodeId: string; x: number; y: number }) {
      return moveTopicNode(db, input.planId, input.topicId, input.nodeId, input.x, input.y);
    },
    patch(input: { planId: string; topicId: string; ops: MapOp[] }) {
      return patchTopicMap(db, input.planId, input.topicId, input.ops);
    },
    undo(input: { planId: string; topicId: string }) {
      return undoTopicMap(db, input.planId, input.topicId);
    },
  };
}
