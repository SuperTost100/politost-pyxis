import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { inside, strictlyInside } from "./path-inside";

it("tells a path under a folder from a sibling, a parent and the folder itself", () => {
  const root = resolve("/data/workspace");
  expect(inside(root, join(root, "blobs", "ab"))).toBe(true);
  expect(inside(root, root)).toBe(true);
  expect(strictlyInside(root, root)).toBe(false);
  expect(strictlyInside(root, join(root, "a"))).toBe(true);
  // A name that only starts like the folder is outside it.
  expect(inside(root, `${root}-old`)).toBe(false);
  expect(inside(root, resolve(root, ".."))).toBe(false);
  expect(inside(root, join(root, "..", "workspace2", "x"))).toBe(false);
  // A file whose name begins with two dots is still inside.
  expect(strictlyInside(root, join(root, "..hidden"))).toBe(true);
});
