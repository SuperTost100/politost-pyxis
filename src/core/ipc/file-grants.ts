import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { MAX_SOURCE_BYTES } from "../../shared/source-types";

export type FileGrant = {
  path: string;
  selectedPath: string;
  directory: boolean;
  dev: number;
  ino: number;
};

/** Only main's native picker and core-created files may add grants. Never accept them over the renderer port. */
export function pickedFileGrant(path: string): FileGrant {
  const canonical = realpathSync(path);
  const stat = statSync(canonical);
  if (!stat.isFile() && !stat.isDirectory())
    throw new Error("file-access-denied");
  return {
    path: canonical,
    selectedPath: resolve(path),
    directory: stat.isDirectory(),
    dev: stat.dev,
    ino: stat.ino,
  };
}

/**
 * A file the user dropped on the window. Preload reads its path from the real `File`, so only a drop can name one.
 * ponytail: main cannot see the drag itself. The ceiling is a regular file with a supported extension, never a folder. Upgrade path is a one-time token minted by a trusted drop event.
 */
export function droppedFileGrant(
  path: string,
  extensions: ReadonlySet<string>,
): FileGrant {
  if (!path || !isAbsolute(path)) throw new Error("file-access-denied");
  const grant = pickedFileGrant(path);
  if (
    grant.directory ||
    !extensions.has(extname(path).toLowerCase()) ||
    !extensions.has(extname(grant.path).toLowerCase())
  )
    throw new Error("file-access-denied");
  return grant;
}

export class FileGrants {
  private grants = new Map<string, FileGrant>();
  add(grant: FileGrant): void {
    this.grants.set(grant.path, grant);
  }
  private authorize(path: string, directory: boolean): string {
    if (!isAbsolute(path)) throw new Error("file-access-denied");
    const canonical = realpathSync(path);
    const current = statSync(canonical);
    if (directory ? !current.isDirectory() : !current.isFile())
      throw new Error("file-access-denied");
    for (const grant of this.grants.values()) {
      let root: ReturnType<typeof statSync>;
      try {
        root = statSync(grant.path);
      } catch {
        continue;
      }
      if (
        root.dev !== grant.dev ||
        root.ino !== grant.ino ||
        root.isDirectory() !== grant.directory
      )
        continue;
      if (canonical === grant.path && directory === grant.directory)
        return canonical;
      if (!grant.directory) continue;
      const child = relative(grant.path, canonical);
      if (
        !child ||
        child === ".." ||
        child.startsWith(`..${sep}`) ||
        isAbsolute(child)
      )
        continue;
      // A renderer cannot use a symlink inside a selected folder to read another file.
      const lexical = resolve(path);
      const lexicalChild = relative(grant.selectedPath, lexical);
      if (lexical !== canonical && lexicalChild !== child) continue;
      const parts = child.split(sep);
      let ancestor = grant.path;
      let linked = false;
      for (const part of parts) {
        ancestor = resolve(ancestor, part);
        if (lstatSync(ancestor).isSymbolicLink()) {
          linked = true;
          break;
        }
      }
      if (!linked) return canonical;
    }
    throw new Error("file-access-denied");
  }
  directory(path: string): string {
    return this.authorize(path, true);
  }
  file(path: string): string {
    return this.authorize(path, false);
  }
  read(path: string, maxBytes = MAX_SOURCE_BYTES): Buffer {
    const canonical = this.file(path);
    const expected = statSync(canonical);
    const fd = openSync(
      canonical,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const opened = fstatSync(fd);
      if (
        !opened.isFile() ||
        opened.dev !== expected.dev ||
        opened.ino !== expected.ino ||
        this.file(path) !== canonical
      )
        throw new Error("file-access-denied");
      // The size is checked before the buffer exists. One spare byte shows a file that grew past the cap.
      if (opened.size > maxBytes) throw new Error("attach-too-big");
      const buffer = Buffer.allocUnsafe(opened.size + 1);
      let length = 0;
      for (;;) {
        const read = readSync(fd, buffer, length, buffer.length - length, null);
        if (read === 0) break;
        length += read;
        if (length === buffer.length) throw new Error("attach-too-big");
      }
      return buffer.subarray(0, length);
    } finally {
      closeSync(fd);
    }
  }
}
