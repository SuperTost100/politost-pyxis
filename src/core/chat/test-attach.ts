import { commitStaged, stageFiles, type PreparedFiles } from "./attach";

/** Reads and extracts a set of files, then stores it. A caller with more to write in the same step uses `stageFiles` and `commitStaged`. */
export async function prepareFiles(...args: Parameters<typeof stageFiles>): Promise<PreparedFiles> {
  const staged = await stageFiles(...args);
  return { sourceIds: commitStaged(args[0], args[1], staged).sourceIds, notes: staged.notes, images: staged.images };
}
