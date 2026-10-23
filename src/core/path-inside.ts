import { isAbsolute, relative, sep } from "node:path";

/** Whether `child` is `parent` itself or lies under it, compared as the platform compares paths. */
export function inside(parent: string, child: string): boolean {
  const part = relative(parent, child);
  return (
    part === "" ||
    (!part.startsWith(`..${sep}`) && part !== ".." && !isAbsolute(part))
  );
}

/** Whether `child` lies under `parent`, not counting `parent` itself. */
export function strictlyInside(parent: string, child: string): boolean {
  return relative(parent, child) !== "" && inside(parent, child);
}
