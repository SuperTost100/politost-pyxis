/**
 * Chromium draws :focus-visible on every click into a text field, and antd's Select keeps a text input inside,
 * so :focus-visible alone cannot tell a click from Tab. This marks the root with where the latest focus came
 * from: "keyboard" when a key press led to it, "pointer" when a click or tap did. Before any input it reads
 * "pointer". The focus rings that must stay off clicks check `html[data-focus-source="keyboard"]` (global.css, Composer.css).
 */
let pointer = true;
const root = document.documentElement;
root.dataset.focusSource = "pointer";

window.addEventListener("pointerdown", () => (pointer = true), true);
window.addEventListener("keydown", () => (pointer = false), true);
window.addEventListener(
  "focusin",
  () => (root.dataset.focusSource = pointer ? "pointer" : "keyboard"),
  true,
);
