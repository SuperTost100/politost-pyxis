import type Database from "better-sqlite3";
import { z } from "zod";
import { uuidv7 } from "../../shared/ids";
import type { MapResultView } from "../../shared/ipc";
import { activityOf } from "../jobs/activity";
import { SCHEMA_VERSION } from "../db/migrate";
import { GIVEN_UP } from "../jobs/runner";
import { startChatMap } from "../maps/generate";
import { mapShape } from "../maps/library";
import { deleteMap, readStoredMap, storeMap, type StoredMap } from "../maps/store";
import { goOnWithJob, hideJob, jobRow, jobState, showJob, stopJob, toolRunner } from "./jobs";
import type { Tool, ToolTurn } from "./server";

/** Characters of the topic the model names. A topic is a few words; the map's root and title are this text. */
export const MAP_TOPIC_MAX = 120;

export const mapInput = z
  .object({
    topic: z
      .string()
      .max(MAP_TOPIC_MAX * 2)
      .transform((text) => text.replace(/\s+/g, " ").trim().slice(0, MAP_TOPIC_MAX))
      .pipe(z.string().min(2))
      .describe('What the map is about, in a few words in the student\'s language, such as "Dinamica" or "Le leggi di Newton".'),
  })
  .strict();

export const MAP_DESCRIPTION = [
  "Creates a concept map in Pyxis's Mappe section, under the subject of this chat, built from the student's material on that subject.",
  "Call it when the student asks for a concept map or a mind map of a topic (\"fammi una mappa su…\"), or accepts your offer to make one. Never call it on your own initiative, and never to draw a diagram that explains something in your answer (an automaton, a circuit, a graph of a function): draw those as figures.",
  "Give `topic` as a few words naming what the map covers, in the student's language: it becomes the map's title.",
  "Pyxis builds the map in the background, which takes a minute or two: the call returns once it has started, and the student sees it in the chat while it is made and when it is ready.",
  "At most one map per answer. After the call, write one short sentence and do not draw the map or list its concepts.",
].join(" ");

/** What a map result stores: the job that builds it, where the map goes and the id the finished map takes. */
export type MapData = { jobId: string; subjectId: string; subject: string; topic: string; mapId: string };

/** What «Annulla» took away: the map as it was, with the student's edits, and whether its build was stopped on the way. */
export type MapUndone = {
  map: StoredMap | null;
  stopped: boolean;
  dismissed: number | null;
  /** The schema version the record was written at (`SCHEMA_VERSION`); absent in records written before it was kept. */
  schema?: number;
};

const TOOL_NAME = "create_map";

/** The chat's subject, from its exam when it has one: maps belong to a subject (or to an exam's topic). */
function mapSubject(db: Database.Database, place: ReturnType<ToolTurn["place"]>): { id: string; name: string } | null {
  if (place.planId) {
    const row = db
      .prepare(`SELECT s.id, s.name FROM plans p JOIN subjects s ON s.id = p.subject_id WHERE p.id = ? AND p.archived_at IS NULL`)
      .get(place.planId) as { id: string; name: string } | undefined;
    if (row) return row;
  }
  if (!place.subject) return null;
  return (
    (db.prepare(`SELECT id, name FROM subjects WHERE name = ? COLLATE NOCASE`).get(place.subject.trim()) as
      | { id: string; name: string }
      | undefined) ?? null
  );
}

/** "dinamica" becomes "Dinamica": the topic is the map's title, which Mappe shows as a name. */
const asTitle = (text: string) => text.charAt(0).toLocaleUpperCase() + text.slice(1);

export function mapTool(db: Database.Database): Tool {
  return {
    name: TOOL_NAME,
    description: MAP_DESCRIPTION,
    input: mapInput,
    run(turn, raw) {
      const args = raw as z.infer<typeof mapInput>;
      if ((turn.tally.maps ?? 0) >= 1)
        return {
          declined: true,
          text: "This answer already created a map, and one answer may create one. Nothing more was created: tell the student they can ask for another map in their next message.",
        };
      const subject = mapSubject(db, turn.place());
      if (!subject)
        return {
          declined: true,
          text: "This chat has no subject, so the map has nowhere to go and none was created. Tell the student to choose a subject for the chat (the subject button above the conversation) and ask again.",
        };
      turn.tally.maps = 1;
      const topic = asTitle(args.topic);
      const resultId = db.transaction(() => {
        const { jobId, mapId } = startChatMap(db, toolRunner(), subject.id, topic);
        const id = uuidv7();
        const data: MapData = { jobId, subjectId: subject.id, subject: subject.name, topic, mapId };
        db.prepare(
          `INSERT INTO chat_tool_results (id, chat_id, message_id, tool, data_json, created_at)
           VALUES (?, ?, NULL, 'create_map', ?, ?)`,
        ).run(id, turn.chatId, JSON.stringify(data), Date.now());
        return id;
      })();
      return {
        text: `Pyxis is building the concept map "${topic}" in Mappe, under ${subject.name}. It takes a minute or two, and the student sees it in the chat while it is made. Write one short sentence and do not draw the map or list its concepts.`,
        shown: { resultId },
      };
    },
  };
}

/** The map as Mappe holds it now, or undefined once it is gone (deleted in Mappe, or its subject deleted). */
function storedMap(db: Database.Database, data: MapData): StoredMap | undefined {
  if (!db.prepare("SELECT 1 FROM subjects WHERE id = ?").get(data.subjectId)) return undefined;
  try {
    return readStoredMap(db, { subjectId: data.subjectId }, data.mapId);
  } catch {
    return undefined;
  }
}

export function mapView(db: Database.Database, id: string, data: MapData, undone: MapUndone | null): MapResultView {
  const job = jobRow(db, data.jobId);
  const map = undone ? (undone.map ?? undefined) : storedMap(db, data);
  const state = jobState(job);
  const root = map?.graph.nodes.find((node) => node.parent === null);
  return {
    id,
    tool: "create_map",
    // A build that stored its map is done, whatever its row says now; one whose map is gone without an undo was deleted.
    job: map && !undone ? "done" : state,
    error: state === "failed" ? (job?.error ?? null) : null,
    activity: state === "working" && !undone ? activityOf(data.jobId) : null,
    undone: undone !== null,
    stopped: !!undone && undone.stopped && !undone.map,
    restorable: !undone || restorableMap(db, data, undone),
    // Deleted in Mappe: after it was made, or while it was built, which gives its build up for good (`deleteMapAndBuilds`).
    gone: !undone && !map && (state === "done" || (job?.dismissed ?? 0) >= GIVEN_UP),
    topic: map?.title ?? data.topic,
    subject: data.subject,
    subjectId: data.subjectId,
    mapId: data.mapId,
    concepts: map?.graph.nodes.length ?? 0,
    branches: root ? map!.graph.nodes.filter((node) => node.parent === root.id).length : 0,
    shape: map ? mapShape(map.graph) : [],
  };
}

/**
 * «Annulla», and «Ferma» while the map is built: a build still going stops and leaves Attività, and a finished map leaves
 * Mappe whole, edits and undo history included, into the result's own record. Nothing else in the app reads that record,
 * so every list, count, search and export of maps leaves it out without knowing about it.
 */
export function undoMap(db: Database.Database, data: MapData): MapUndone {
  const stopped = stopJob(db, data.jobId);
  const map = storedMap(db, data) ?? null;
  if (map) deleteMap(db, { subjectId: data.subjectId }, data.mapId);
  // A finished build leaves Attività's "finished today" too, since it opens a map that is not there.
  return { map, stopped, dismissed: stopped ? null : hideJob(db, data.jobId), schema: SCHEMA_VERSION };
}

/**
 * Whether «Ripristina» can bring the map back: its subject is still there, and the record is not from a newer Pyxis
 * than this one (after a downgrade). The card says so plainly otherwise, with no button.
 */
function restorableMap(db: Database.Database, data: MapData, undone: MapUndone): boolean {
  return !!db.prepare("SELECT 1 FROM subjects WHERE id = ?").get(data.subjectId) && (undone.schema ?? 0) <= SCHEMA_VERSION;
}

/** «Ripristina»: the map comes back as it was, or its build goes on from where «Ferma» stopped it. */
export function restoreMap(db: Database.Database, data: MapData, undone: MapUndone): void {
  if (!restorableMap(db, data, undone)) throw new Error("tool-restore-gone");
  if (undone.map) {
    storeMap(db, { subjectId: data.subjectId }, undone.map);
  }
  if (undone.stopped) goOnWithJob(db, data.jobId);
  else showJob(db, data.jobId, undone.dismissed);
}

/** «Riprova» or «Riprendi» on a build that failed or stopped. */
export function retryMap(db: Database.Database, data: MapData): void {
  goOnWithJob(db, data.jobId);
}

/**
 * A result no reply shows any more takes its map with it: its build stops for good and the map leaves Mappe. A map
 * already undone is only in the result's record, which goes with the result.
 */
export function dropMap(db: Database.Database, data: MapData, undone: boolean): void {
  toolRunner().discard(data.jobId);
  if (!undone && storedMap(db, data)) deleteMap(db, { subjectId: data.subjectId }, data.mapId);
}
