import katex from "katex";
import type { MathfieldElement } from "mathlive";
import { loadMathLive, mathLive } from "./loadMathLive";
import { cleanLatex, parseMathText, serializeMathText, type MathSegment } from "./mathText";

/**
 * Drives one editable element that holds text with formulas inline. The text is plain, newlines
 * included; each formula is a chip that renders the math. A chip turns into a MathLive field while
 * the student edits it. The element's children belong to this class, never to React.
 *
 * Layout of the element: text nodes and chips, then one `<br>` that keeps an empty last line visible.
 */

export type MathEditorOptions = {
  onChange: (value: string) => void;
  /** Enter without Shift. Returns true when it handled the key, such as sending the message. */
  onSubmit: () => boolean;
  /** Keys pressed in the text, after the editor's own handling declined them. */
  onKeyDown: (event: KeyboardEvent) => void;
  maxLength: () => number | undefined;
  /** Accessible name of a formula, and the interface language for MathLive. */
  formulaLabel: () => string;
  language: () => string;
};

type Edit = {
  chip: HTMLElement;
  field: MathfieldElement | null;
  /** The chip came from a typed dollar sign: Backspace on it while empty gives the sign back. */
  typed: boolean;
  ready: Promise<MathfieldElement | null>;
  /** Characters typed before MathLive finished loading; they go into the field once it exists. */
  pending: string;
  onKey: (event: KeyboardEvent) => void;
};

type Snapshot = { value: string; caret: number };
type EditKind = "type" | "math" | "other";

const CHIP = "px-mathchip";
/** The on-screen formula keyboard. Focus may move there without closing the formula being edited. */
const KEYS = "[data-math-keys]";

function isChip(node: Node | null | undefined): node is HTMLElement {
  return node instanceof HTMLElement && node.classList.contains(CHIP);
}

function isText(node: Node | null | undefined): node is Text {
  return node?.nodeType === Node.TEXT_NODE;
}

/**
 * MathLive moves focus into its field 60 ms after `focus()`, so keys typed right away would land in
 * the text. Focusing its keyboard sink takes the keys at once; MathLive treats that as a normal focus.
 */
function focusField(field: MathfieldElement) {
  const sink = field.shadowRoot?.querySelector<HTMLElement>("[part=keyboard-sink]");
  if (sink) sink.focus({ preventScroll: true });
  else field.focus();
}

export class MathEditor {
  private edit: Edit | null = null;
  private value = "";
  private past: Snapshot[] = [];
  private future: Snapshot[] = [];
  private present: Snapshot = { value: "", caret: 0 };
  private lastKind: EditKind | null = null;
  private lastAt = 0;
  private lastRange: Range | null = null;
  private disabled = false;
  private composing = false;
  private readonly off: Array<() => void> = [];

  constructor(
    private readonly root: HTMLElement,
    private readonly options: MathEditorOptions,
  ) {
    root.contentEditable = "plaintext-only";
    const on = <K extends keyof HTMLElementEventMap>(
      target: HTMLElement | Document,
      type: K,
      listener: (event: HTMLElementEventMap[K]) => void,
    ) => {
      target.addEventListener(type, listener as EventListener);
      this.off.push(() => target.removeEventListener(type, listener as EventListener));
    };
    on(root, "beforeinput", (event) => this.onBeforeInput(event));
    on(root, "input", (event) => {
      if (this.fromChip(event) || this.composing) return;
      this.sync((event as InputEvent).inputType === "insertText" ? "type" : "other");
    });
    on(root, "compositionstart", (event) => {
      if (!this.fromChip(event)) this.composing = true;
    });
    on(root, "compositionend", (event) => {
      if (this.fromChip(event)) return;
      this.composing = false;
      this.sync("type");
    });
    on(root, "keydown", (event) => this.onKeyDown(event));
    on(root, "mousedown", (event) => this.onMouseDown(event));
    on(root, "paste", (event) => {
      if (this.fromChip(event) || this.disabled) return;
      event.preventDefault();
      this.insertText(event.clipboardData?.getData("text/plain") ?? "");
    });
    on(root, "copy", (event) => this.onCopy(event, false));
    on(root, "cut", (event) => this.onCopy(event, true));
    // Text dragged inside the field would carry the rendered math; external drops still arrive as plain text.
    on(root, "dragstart", (event) => event.preventDefault());
    // MathLive loads soon after the field appears, so the first formula opens without a wait.
    const preload = setTimeout(() => void loadMathLive().then(() => this.relabel()), 300);
    this.off.push(() => clearTimeout(preload));
    on(document, "selectionchange", () => this.onSelectionChange());
    on(document, "focusin", () => this.checkFocus());
    this.render("");
  }

  destroy() {
    for (const off of this.off.splice(0)) off();
    this.edit = null;
  }

  // ----- public API used by the React wrapper and the formula keyboard

  /** Shows `value` unless it is what the editor already holds. External changes start a new undo history. */
  setValue(value: string) {
    if (value === this.value) return;
    const hadFocus = this.hasFocus();
    this.render(value);
    this.past = [];
    this.future = [];
    this.present = { value, caret: this.unitLength() };
    this.lastKind = null;
    if (hadFocus) {
      this.root.focus({ preventScroll: true });
      this.setCaret(this.unitLength());
    }
  }

  setDisabled(disabled: boolean) {
    this.disabled = disabled;
    if (disabled) this.leave(null);
    this.root.contentEditable = disabled ? "false" : "plaintext-only";
  }

  focus() {
    if (this.edit) {
      if (this.edit.field) focusField(this.edit.field);
      return;
    }
    this.root.focus({ preventScroll: true });
    if (!this.selectionRange()) this.setCaret(this.unitLength());
  }

  editing(): boolean {
    return this.edit !== null;
  }

  /** Opens a new formula at the caret, or returns to the one being edited. */
  insertMath(): void {
    this.openChip(false);
  }

  /** Puts LaTeX into the formula being edited, opening one at the caret first when needed. */
  insertLatex(latex: string) {
    const edit = this.openChip(false);
    void this.withField(edit, (field) => {
      field.executeCommand(["insert", latex, { format: "latex", focus: true, feedback: false }]);
    });
  }

  command(name: "moveToPreviousChar" | "moveToNextChar" | "deleteBackward") {
    const edit = this.edit;
    if (!edit) return;
    void this.withField(edit, (field) => field.executeCommand(name));
  }

  /** Closes the formula being edited and puts the caret after it. */
  leaveMath() {
    if (this.edit) this.leave("after");
    else this.focus();
  }

  // ----- events

  private fromChip(event: Event): boolean {
    const target = event.target;
    return target instanceof Element && target !== this.root && target.closest(`.${CHIP}`) !== null;
  }

  private onBeforeInput(event: InputEvent) {
    if (this.fromChip(event) || this.composing || event.isComposing || this.disabled) return;
    const type = event.inputType;
    if (this.edit && !this.edit.field) {
      // A formula is opening; what the student types meanwhile belongs to it, not to the text.
      event.preventDefault();
      if (type === "insertText") this.edit.pending += event.data ?? "";
      return;
    }
    if (type === "historyUndo" || type === "historyRedo") {
      event.preventDefault();
      this.travel(type === "historyUndo" ? this.past : this.future, type === "historyUndo" ? this.future : this.past);
      return;
    }
    if (type === "insertParagraph" || type === "insertLineBreak") {
      event.preventDefault();
      this.insertText("\n");
      return;
    }
    if (type === "insertText" || type === "insertReplacementText") {
      const data = event.data ?? event.dataTransfer?.getData("text/plain") ?? "";
      if (type === "insertText" && data === "$") {
        event.preventDefault();
        this.openChip(true);
      } else if (data.includes("$") || data.includes("\n") || this.selectionHasChip()) {
        event.preventDefault();
        this.insertText(data);
      }
      return;
    }
    if (type.startsWith("insertFrom")) {
      event.preventDefault();
      const target = event.getTargetRanges()[0];
      if (target) this.select(target.startContainer, target.startOffset, target.endContainer, target.endOffset);
      this.insertText(event.dataTransfer?.getData("text/plain") ?? "");
      return;
    }
    if (type.startsWith("format")) {
      event.preventDefault();
      return;
    }
    if (type.startsWith("delete") && this.selectionHasChip()) {
      event.preventDefault();
      this.selectionRange()?.deleteContents();
      this.sync("other");
    }
  }

  private onKeyDown(event: KeyboardEvent) {
    if (this.fromChip(event) || event.isComposing || event.keyCode === 229) return;
    this.options.onKeyDown(event);
    if (event.defaultPrevented || this.disabled) return;
    if (event.key === "Enter" && !event.shiftKey && !event.altKey) {
      if (this.options.onSubmit()) event.preventDefault();
      return;
    }
    const key = event.key.toLowerCase();
    if ((event.ctrlKey || event.metaKey) && !event.altKey && (key === "z" || key === "y")) {
      event.preventDefault();
      if (key === "z" && !event.shiftKey) this.travel(this.past, this.future);
      else this.travel(this.future, this.past);
      return;
    }
    if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return;
    const forward = event.key === "ArrowRight" || event.key === "Delete";
    if (!forward && event.key !== "ArrowLeft" && event.key !== "Backspace") return;
    const chip = this.chipBesideCaret(forward);
    if (!chip) return;
    event.preventDefault();
    if (event.key.startsWith("Arrow")) {
      this.enter(chip, forward ? "start" : "end");
      return;
    }
    // The first Backspace or Delete selects the formula; the next one removes it.
    const range = document.createRange();
    range.selectNode(chip);
    this.selectRange(range);
  }

  private onMouseDown(event: MouseEvent) {
    if (this.disabled || event.button !== 0) return;
    const target = event.target;
    const chip = target instanceof Element ? target.closest(`.${CHIP}`) : null;
    if (!isChip(chip) || !this.root.contains(chip) || chip === this.edit?.chip) return;
    event.preventDefault();
    this.enter(chip, "end");
  }

  private onCopy(event: ClipboardEvent, cut: boolean) {
    if (this.fromChip(event)) return;
    const range = this.selectionRange();
    if (!range || range.collapsed) return;
    event.preventDefault();
    event.clipboardData?.setData("text/plain", serializeMathText(this.read(range.cloneContents())));
    if (cut && !this.disabled) {
      range.deleteContents();
      this.sync("other");
    }
  }

  private onSelectionChange() {
    // Home, End and clicks can put the caret inside a chip's drawing, where nothing can be typed.
    const selection = document.getSelection();
    const anchor = selection?.rangeCount ? selection.getRangeAt(0) : null;
    if (anchor?.collapsed && this.root.contains(anchor.startContainer)) {
      const element =
        anchor.startContainer instanceof Element ? anchor.startContainer : anchor.startContainer.parentElement;
      const chip = element?.closest(`.${CHIP}`);
      if (isChip(chip) && chip !== this.edit?.chip) {
        const lead = document.createRange();
        lead.setStart(chip, 0);
        lead.setEnd(anchor.startContainer, anchor.startOffset);
        const [node, offset] = lead.toString() ? this.afterNode(chip) : this.beforeNode(chip);
        this.select(node, offset);
        return;
      }
    }
    const range = this.selectionRange();
    if (range) this.lastRange = range.cloneRange();
    for (const chip of this.root.querySelectorAll<HTMLElement>(`.${CHIP}`))
      chip.classList.toggle(
        "is-selected",
        Boolean(range && !range.collapsed && selection?.containsNode(chip, false)),
      );
  }

  /** A formula closes once focus settles anywhere but the formula itself or the formula keyboard. */
  private checkFocus() {
    const edit = this.edit;
    if (!edit) return;
    setTimeout(() => {
      if (this.edit !== edit || !document.hasFocus()) return;
      const active = document.activeElement;
      if (active && (edit.chip.contains(active) || active.closest(KEYS))) return;
      this.leave(null);
    }, 0);
  }

  // ----- formulas

  private openChip(typed: boolean): Edit {
    if (this.edit) {
      if (this.edit.field) focusField(this.edit.field);
      return this.edit;
    }
    const range = this.editableRange();
    range.deleteContents();
    const chip = this.makeChip("");
    range.insertNode(chip);
    return this.enter(chip, "start", typed);
  }

  private enter(chip: HTMLElement, edge: "start" | "end", typed = false): Edit {
    if (this.edit?.chip === chip) {
      if (this.edit.field) focusField(this.edit.field);
      return this.edit;
    }
    if (this.edit) this.leave(null);
    chip.classList.add("is-editing");
    chip.classList.remove("is-selected");
    chip.removeAttribute("role");
    chip.removeAttribute("aria-label");
    const edit: Edit = {
      chip,
      field: null,
      typed,
      ready: Promise.resolve(null),
      pending: "",
      onKey: (event) => this.onChipKey(edit, event),
    };
    chip.addEventListener("keydown", edit.onKey, true);
    this.edit = edit;
    this.updateEmpty();
    const attach = (module: NonNullable<ReturnType<typeof mathLive>>) => {
      if (this.edit !== edit) return null;
      const field = this.makeField(module, chip);
      edit.field = field;
      chip.replaceChildren(field);
      // The menu offers LaTeX tools; the field is for typing math, so it has none.
      field.menuItems = [];
      focusField(field);
      field.position = edge === "start" ? 0 : field.lastOffset;
      if (edit.pending) field.executeCommand(["typedText", edit.pending, { focus: true, feedback: false }]);
      return field;
    };
    const loaded = mathLive();
    if (loaded) edit.ready = Promise.resolve(attach(loaded));
    else {
      chip.replaceChildren();
      edit.ready = loadMathLive().then(attach);
    }
    return edit;
  }

  private makeField(
    module: NonNullable<ReturnType<typeof mathLive>>,
    chip: HTMLElement,
  ): MathfieldElement {
    const { MathfieldElement } = module;
    MathfieldElement.locale = this.options.language().startsWith("it") ? "it" : "en";
    const field = new MathfieldElement();
    field.mathVirtualKeyboardPolicy = "manual";
    field.smartMode = false;
    field.popoverPolicy = "off";
    field.value = chip.dataset.latex ?? "";
    field.setAttribute("aria-label", this.options.formulaLabel());
    field.addEventListener("input", () => {
      chip.dataset.latex = cleanLatex(field.getValue("latex-without-placeholders"));
      this.sync("math");
    });
    field.addEventListener("move-out", (event) => {
      const { direction } = event.detail;
      if (direction !== "forward" && direction !== "backward") return;
      event.preventDefault();
      this.leave(direction === "forward" ? "after" : "before");
    });
    field.addEventListener("focusout", () => this.checkFocus());
    return field;
  }

  private onChipKey(edit: Edit, event: KeyboardEvent) {
    if (event.isComposing || this.edit !== edit) return;
    const field = edit.field;
    const empty = !field || !field.getValue("latex-without-placeholders").trim();
    if (event.key === "Escape" && field?.mode !== "latex") this.leave("after");
    else if (event.key === "Tab") this.leave(event.shiftKey ? "before" : "after");
    else if (event.key === "Enter" || event.key === "$") this.leave("after");
    else if (event.key === "Backspace" && empty) this.leave(null, edit.typed ? "dollar" : "drop");
    else return;
    event.preventDefault();
    event.stopPropagation();
  }

  /**
   * Turns the formula being edited back into a chip, or removes it when empty. With `place` the
   * caret goes before or after it in the text; without, focus has already moved elsewhere.
   */
  private leave(place: "before" | "after" | null, empty?: "drop" | "dollar") {
    const edit = this.edit;
    if (!edit) return;
    this.edit = null;
    const { chip } = edit;
    chip.removeEventListener("keydown", edit.onKey, true);
    // The field's input event can trail the last keystroke, so read the field itself.
    if (edit.field) chip.dataset.latex = cleanLatex(edit.field.getValue("latex-without-placeholders"));
    const latex = empty ? "" : (chip.dataset.latex ?? "");
    let caret: [Node, number];
    if (!latex) {
      const index = this.indexOf(chip);
      const before = chip.previousSibling;
      if (empty === "dollar") {
        const sign = document.createTextNode("$");
        chip.replaceWith(sign);
        caret = [sign, 1];
      } else {
        chip.remove();
        caret = isText(before) ? [before, before.length] : [this.root, index];
      }
      place ??= empty ? "after" : null;
    } else {
      this.paint(chip);
      caret = place === "before" ? this.beforeNode(chip) : this.afterNode(chip);
    }
    if (place) {
      this.root.focus({ preventScroll: true });
      this.select(caret[0], caret[1]);
    }
    this.sync("other");
    this.updateEmpty();
  }

  private async withField(edit: Edit, run: (field: MathfieldElement) => void) {
    const field = edit.field ?? (await edit.ready);
    if (!field || this.edit !== edit) return;
    focusField(field);
    run(field);
  }

  private makeChip(latex: string, display?: boolean): HTMLElement {
    const chip = document.createElement("span");
    chip.className = CHIP;
    chip.contentEditable = "false";
    chip.dataset.latex = latex;
    if (display) chip.dataset.display = "true";
    if (latex) this.paint(chip);
    return chip;
  }

  /** Draws a chip's formula. KaTeX draws nearly everything; MathLive draws what KaTeX refuses. */
  private paint(chip: HTMLElement) {
    const latex = chip.dataset.latex ?? "";
    chip.classList.remove("is-editing");
    chip.setAttribute("role", "img");
    chip.setAttribute("aria-label", this.speak(latex));
    const body = document.createElement("span");
    body.className = "px-mathchip-body";
    try {
      body.innerHTML = katex.renderToString(latex, {
        throwOnError: true,
        output: "html",
        strict: "ignore",
      });
    } catch {
      const module = mathLive();
      if (module) {
        const field = new module.MathfieldElement();
        field.readOnly = true;
        field.tabIndex = -1;
        field.value = latex;
        body.replaceChildren(field);
      } else
        void loadMathLive().then(() => {
          if (chip.isConnected && !chip.classList.contains("is-editing")) this.paint(chip);
        });
    }
    chip.replaceChildren(body);
  }

  private speak(latex: string): string {
    const label = this.options.formulaLabel();
    const module = mathLive();
    if (!module) return label;
    try {
      const spoken = module.convertLatexToSpeakableText(latex).trim();
      return spoken ? `${label}: ${spoken}` : label;
    } catch {
      return label;
    }
  }

  private relabel() {
    for (const chip of this.root.querySelectorAll<HTMLElement>(`.${CHIP}:not(.is-editing)`))
      chip.setAttribute("aria-label", this.speak(chip.dataset.latex ?? ""));
  }

  // ----- model

  private render(value: string) {
    const edit = this.edit;
    if (edit) edit.chip.removeEventListener("keydown", edit.onKey, true);
    this.edit = null;
    const nodes = parseMathText(value).map((segment) =>
      segment.kind === "text"
        ? document.createTextNode(segment.text)
        : this.makeChip(segment.latex, segment.display),
    );
    this.root.replaceChildren(...nodes, document.createElement("br"));
    this.value = value;
    this.updateEmpty();
  }

  /** Reads text and formulas out of the element or a copied piece of it. */
  private read(container: Node): MathSegment[] {
    const segments: MathSegment[] = [];
    const addText = (text: string) => {
      if (!text) return;
      const last = segments.at(-1);
      if (last?.kind === "text") last.text += text;
      else segments.push({ kind: "text", text });
    };
    const walk = (parent: Node, top: boolean) => {
      const children = [...parent.childNodes];
      children.forEach((node, index) => {
        if (isText(node)) addText(node.data);
        else if (isChip(node)) {
          const latex = node.dataset.latex ?? "";
          segments.push(
            node.dataset.display === "true"
              ? { kind: "math", latex, display: true }
              : { kind: "math", latex },
          );
        } else if (node.nodeName === "BR") {
          if (!top || index < children.length - 1) addText("\n");
        } else if (node instanceof Element) {
          if (/^(DIV|P|LI)$/.test(node.nodeName) && segments.length > 0) addText("\n");
          walk(node, false);
        }
      });
    };
    walk(container, true);
    return segments;
  }

  /**
   * Keeps the element in its layout after the browser edits it: text nodes and chips, then one `<br>`.
   * Merging text keeps the selection where it was; a rebuild puts the caret back by position.
   */
  private normalize() {
    const children = [...this.root.childNodes];
    const odd = children.some(
      (node, index) =>
        !isText(node) &&
        !isChip(node) &&
        !(node.nodeName === "BR" && index === children.length - 1),
    );
    if (odd) {
      const caret = this.caretOffset();
      const nodes: Node[] = [];
      for (const segment of this.read(this.root))
        nodes.push(
          segment.kind === "text"
            ? document.createTextNode(segment.text)
            : (children.find(
                (node): node is HTMLElement =>
                  isChip(node) && !nodes.includes(node) && node.dataset.latex === segment.latex,
              ) ?? this.makeChip(segment.latex, segment.display)),
        );
      this.root.replaceChildren(...nodes, document.createElement("br"));
      if (caret !== null) this.setCaret(caret);
      return;
    }
    if (this.root.lastChild?.nodeName !== "BR") this.root.append(document.createElement("br"));
    this.root.normalize();
  }

  private sync(kind: EditKind) {
    if (this.edit && !this.root.contains(this.edit.chip)) this.edit = null;
    this.normalize();
    const value = serializeMathText(this.read(this.root));
    this.updateEmpty(value);
    if (value === this.value) return;
    const limit = this.options.maxLength();
    if (limit !== undefined && value.length > limit && value.length > this.value.length) {
      this.restore(this.present);
      return;
    }
    this.value = value;
    const snapshot = { value, caret: this.caretOffset() ?? this.unitLength() };
    const now = Date.now();
    if (kind !== "other" && kind === this.lastKind && now - this.lastAt < 1000) this.present = snapshot;
    else {
      this.past.push(this.present);
      if (this.past.length > 200) this.past.shift();
      this.present = snapshot;
    }
    this.future = [];
    this.lastKind = kind;
    this.lastAt = now;
    this.options.onChange(value);
  }

  private travel(from: Snapshot[], to: Snapshot[]) {
    const next = from.pop();
    if (!next) return;
    to.push(this.present);
    this.present = next;
    this.lastKind = null;
    this.restore(next);
    this.options.onChange(next.value);
  }

  private restore(snapshot: Snapshot) {
    this.render(snapshot.value);
    this.root.focus({ preventScroll: true });
    this.setCaret(snapshot.caret);
  }

  private updateEmpty(value = this.value) {
    this.root.toggleAttribute("data-empty", value === "" && !this.edit);
  }

  // ----- caret and selection

  private hasFocus(): boolean {
    const active = document.activeElement;
    return active !== null && this.root.contains(active);
  }

  /** The selection when it lies in the text of this element, outside any formula. */
  private selectionRange(): Range | null {
    const selection = document.getSelection();
    if (!selection || selection.rangeCount === 0) return null;
    const range = selection.getRangeAt(0);
    const inside = (node: Node) =>
      this.root.contains(node) && !(node instanceof Element ? node : node.parentElement)?.closest(`.${CHIP}`);
    return inside(range.startContainer) && inside(range.endContainer) ? range : null;
  }

  /** Where new text or a formula goes: the selection, the last place the caret was, or the end. A copy, never the live selection. */
  private editableRange(): Range {
    const current = this.selectionRange();
    if (current) return current.cloneRange();
    const last = this.lastRange;
    if (last && this.root.contains(last.startContainer) && this.root.contains(last.endContainer))
      return last.cloneRange();
    const range = document.createRange();
    const end = this.root.lastChild;
    if (end) range.setStartBefore(end);
    else range.setStart(this.root, 0);
    range.collapse(true);
    return range;
  }

  private selectionHasChip(): boolean {
    const range = this.selectionRange();
    if (!range || range.collapsed) return false;
    return [...this.root.querySelectorAll(`.${CHIP}`)].some((chip) => range.intersectsNode(chip));
  }

  private chipBesideCaret(forward: boolean): HTMLElement | null {
    const range = this.selectionRange();
    if (!range || !range.collapsed) return null;
    const { startContainer: node, startOffset: offset } = range;
    let next: Node | null;
    if (isText(node)) {
      if (forward ? offset < node.length : offset > 0) return null;
      next = forward ? node.nextSibling : node.previousSibling;
    } else if (node === this.root) next = this.root.childNodes[forward ? offset : offset - 1] ?? null;
    else return null;
    while (isText(next) && next.length === 0) next = forward ? next.nextSibling : next.previousSibling;
    return isChip(next) ? next : null;
  }

  private insertText(text: string) {
    if (!text) return;
    const range = this.editableRange();
    range.deleteContents();
    const fragment = document.createDocumentFragment();
    for (const segment of parseMathText(text))
      fragment.append(
        segment.kind === "text"
          ? document.createTextNode(segment.text)
          : this.makeChip(segment.latex, segment.display),
      );
    const last = fragment.lastChild;
    if (!last) return;
    range.insertNode(fragment);
    this.root.focus({ preventScroll: true });
    const [node, offset] = this.afterNode(last);
    this.select(node, offset);
    this.sync(text.length === 1 ? "type" : "other");
  }

  private indexOf(node: Node): number {
    return Array.prototype.indexOf.call(this.root.childNodes, node) as number;
  }

  private afterNode(node: Node): [Node, number] {
    if (isText(node)) return [node, node.length];
    const next = node.nextSibling;
    return isText(next) ? [next, 0] : [this.root, this.indexOf(node) + 1];
  }

  private beforeNode(node: Node): [Node, number] {
    const previous = node.previousSibling;
    return isText(previous) ? [previous, previous.length] : [this.root, this.indexOf(node)];
  }

  private select(node: Node, offset: number, endNode = node, endOffset = offset) {
    const range = document.createRange();
    range.setStart(node, offset);
    range.setEnd(endNode, endOffset);
    this.selectRange(range);
  }

  private selectRange(range: Range) {
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    this.lastRange = range.cloneRange();
  }

  /** Counts a character of text, a formula and a line break as one unit each. */
  private unitOf(node: Node, last: boolean): number {
    if (isText(node)) return node.length;
    if (isChip(node)) return 1;
    if (node.nodeName === "BR") return last ? 0 : 1;
    return node.textContent?.length ?? 0;
  }

  private unitLength(): number {
    const children = [...this.root.childNodes];
    return children.reduce((sum, node, index) => sum + this.unitOf(node, index === children.length - 1), 0);
  }

  private caretOffset(): number | null {
    const selection = document.getSelection();
    if (!selection || selection.rangeCount === 0) return null;
    const range = selection.getRangeAt(0);
    const { endContainer: container, endOffset: offset } = range;
    if (!this.root.contains(container)) return null;
    const children = [...this.root.childNodes];
    let total = 0;
    for (const [index, child] of children.entries()) {
      if (container === this.root && offset === index) return total;
      if (child === container) return total + (isText(child) ? offset : 0);
      if (child.contains(container)) return total;
      total += this.unitOf(child, index === children.length - 1);
    }
    return total;
  }

  private setCaret(units: number) {
    const children = [...this.root.childNodes];
    let left = units;
    for (const [index, child] of children.entries()) {
      if (isText(child)) {
        if (left <= child.length) return this.select(child, left);
        left -= child.length;
        continue;
      }
      if (left === 0 || index === children.length - 1) return this.select(this.root, index);
      left -= this.unitOf(child, false);
    }
    this.select(this.root, children.length);
  }
}
