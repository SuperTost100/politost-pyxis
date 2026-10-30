/**
 * The text of a selection as a student would paste it. KaTeX draws a formula twice, as MathML for screen readers and as
 * HTML for the eye, and the browser's own `toString()` reads both ("X" and then "X"). Each formula here becomes its TeX
 * source once, between `$` (or `$$` for a display formula), so the text can be drawn again as math.
 */
export function selectedText(range: Range): string {
  const holder = document.createElement("div");
  holder.append(range.cloneContents());
  for (const formula of holder.querySelectorAll<HTMLElement>(".katex-display, .katex")) {
    // The `.katex` inside a display formula went with it.
    if (!holder.contains(formula)) continue;
    const tex = formula.querySelector('annotation[encoding="application/x-tex"]')?.textContent?.trim();
    if (!tex) {
      // A selection that starts or ends inside a formula carries a piece of it. With the screen-reader copy in it, keep
      // that one reading; a selection that began past that copy has only the drawn glyphs, which stay.
      if (formula.querySelector(".katex-mathml")) formula.querySelector(".katex-html")?.remove();
      continue;
    }
    formula.replaceWith(formula.classList.contains("katex-display") ? `$$${tex}$$` : `$${tex}$`);
  }
  // innerText needs the copy to be laid out, so it sits off screen for the moment it takes to read.
  holder.style.cssText = "position:fixed;left:-99999px;top:0;width:640px";
  document.body.append(holder);
  const text = holder.innerText;
  holder.remove();
  return text.trim();
}
