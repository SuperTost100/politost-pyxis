import type { MathfieldElement } from "mathlive";

/**
 * MathLive writes a typed `{` or `}` as a literal brace, so `t^{3}` would store `t^{\lbrace3\rbrace}`. A student who
 * knows LaTeX types braces to group, and `\{` for a brace that shows. This reads the keys the way LaTeX does while the
 * field is in math mode (in LaTeX mode, after a `\`, they stay text):
 *
 * - `{` in the empty exponent or index that `^` or `_` just opened opens nothing, since that script is already the
 *   group. Anywhere else it opens a group, written `\mathord{…}` in the field and `{…}` in the stored text (`cleanLatex`).
 * - `}` leaves the innermost group the student opened that still holds the caret, also from a script inside it that
 *   was written with no braces. With no such group it does nothing.
 * - A digit typed first in a group the student braced stays in it. MathLive's own rule ends an exponent after its first
 *   digit, which is right for `x^2` and wrong for `x^{12}`.
 *
 * Which groups the student opened is a list of the groups themselves (the atom that owns the group and its branch),
 * checked against where the caret is in MathLive's model at each key, so arrows, Home, End, a click, a deletion and a
 * selection that is typed over all leave the list right: a group that is gone is not in the caret's ancestors.
 *
 * MathLive rebuilds the whole model for an inline shortcut (`pi` becomes \pi), an undo and a redo, and then the atoms in
 * the list are no longer in the model. Each group also keeps where it is (the path from the root, as of the last key),
 * and a group whose atoms are gone is found again at that place, when the caret is in a group of the same kind there.
 * Where it is not found the group is not closed by a `}`, as for any group this does not know.
 *
 * shortcut: MathLive has no public call that says which group the caret is in, so this reads `_mathfield.model`, which
 * is not documented. `mathlive` is pinned to one exact version in package.json, and the sequences in
 * `math-composer.spec.ts` fail if an update changes the model; without it a brace stays a literal one, as before.
 * Upgrade when MathLive exposes the caret's ancestors.
 */

/** The part of MathLive's model this reads. */
type ModelAtom = {
  type: string;
  parent?: ModelAtom;
  parentBranch?: string | [number, number];
  branch(name: string): ModelAtom[] | undefined;
};
type Model = { position: number; at(position: number): ModelAtom; root?: ModelAtom };

/** A group the student opened: the atom that owns it, the name of its branch, that branch as it was made, and where it is. */
type Group = { owner: ModelAtom; name: string; branch: ModelAtom[]; path: string };

const modelOf = (field: MathfieldElement): Model | undefined =>
  (field as unknown as { _mathfield?: { model?: Model } })._mathfield?.model;

/** Where a group is in the model: the index and branch of each atom from the root down to its owner, and the branch. */
function pathOf(owner: ModelAtom, name: string): string {
  const steps = [name];
  for (let atom = owner; atom.parent; atom = atom.parent) {
    const branch = typeof atom.parentBranch === "string" ? atom.parent.branch(atom.parentBranch) : undefined;
    steps.push(`${String(atom.parentBranch)}:${branch ? branch.indexOf(atom) : "?"}`);
  }
  return `${steps.reverse().join("/")}#${owner.type}`;
}

/** The groups the caret is inside, innermost first. */
function around(model: Model): Group[] {
  const out: Group[] = [];
  for (let atom: ModelAtom | undefined = model.at(model.position); atom?.parent; atom = atom.parent) {
    const name = atom.parentBranch;
    const branch = typeof name === "string" ? atom.parent.branch(name) : undefined;
    if (typeof name === "string" && branch) out.push({ owner: atom.parent, name, branch, path: pathOf(atom.parent, name) });
  }
  return out;
}

/** The top of the atoms an atom belongs to: the model's root while the atom is in the model. */
function top(atom: ModelAtom): ModelAtom {
  let at = atom;
  while (at.parent) at = at.parent;
  return at;
}

const same = (a: Group, b: Group) => a.owner === b.owner && a.name === b.name && a.branch === b.branch;

export class TypedBraces {
  private opened: Group[] = [];

  /** Reads one key typed into `field`. True when the key was one this class dealt with. */
  key(field: MathfieldElement, key: string): boolean {
    if (field.mode !== "math") return false;
    const model = modelOf(field);
    if (!model) return false;
    const now = around(model);
    this.reconcile(model, now);
    if (key !== "{" && key !== "}" && !/^\d$/.test(key)) return false;
    if (key === "{") return this.open(field, model, now);
    if (key === "}") return this.close(field, model, now);
    // A digit first in a braced exponent: MathLive would end the exponent after it.
    const inner = now[0];
    if (!inner || inner.name !== "superscript" || !this.opened.some((group) => same(group, inner))) return false;
    const smart = field.smartSuperscript;
    field.smartSuperscript = false;
    try {
      field.executeCommand(["typedText", key, { focus: true, feedback: false }]);
    } finally {
      field.smartSuperscript = smart;
    }
    return true;
  }

  /**
   * Keeps the list true after MathLive rebuilt its model: a group whose atoms are no longer in the model is found again at
   * the place it had, if the caret is in a group of that kind there, and the others keep their place for a later redo.
   */
  private reconcile(model: Model, now: Group[]): void {
    const root = model.root;
    if (!root || this.opened.length === 0) return;
    this.opened = this.opened.map((group) => {
      if (top(group.owner) === root) return { ...group, path: pathOf(group.owner, group.name) };
      return now.find((live) => live.path === group.path) ?? group;
    });
  }

  private open(field: MathfieldElement, model: Model, now: Group[]): boolean {
    const slot = now[0];
    const atom = model.at(model.position);
    // The empty exponent or index that `^` or `_` just opened holds nothing yet but its own start.
    const empty = slot && (slot.name === "superscript" || slot.name === "subscript") && atom.type === "first" && slot.branch.length <= 1;
    if (!empty) {
      field.executeCommand(["insert", "\\mathord{#?}", { format: "latex", focus: true, feedback: false }]);
    }
    const inside = around(model)[0];
    if (inside) this.opened = [...this.opened.slice(-31), inside];
    return true;
  }

  private close(field: MathfieldElement, model: Model, now: Group[]): boolean {
    const target = now.find((group) => this.opened.some((opened) => same(opened, group)));
    if (!target) return true;
    // Out of every group inside the one being closed, then out of it.
    for (let step = 0; step < 32 && around(model).some((group) => same(group, target)); step += 1) {
      field.executeCommand("moveToGroupEnd");
      field.executeCommand("moveToNextChar");
    }
    this.opened = this.opened.filter((group) => !same(group, target));
    return true;
  }
}
