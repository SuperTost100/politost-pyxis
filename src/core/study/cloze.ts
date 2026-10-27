import { mathSpans } from "../../shared/math-delimiters";

// Anki cloze markup: {{c1::answer}} or {{c1::answer::hint}}. A card is a cloze when its front holds a deletion.

type Deletion = { start: number; end: number; answer: string; hint?: string };

/**
 * The deletions in `text`. A deletion ends at the first `}}` outside the braces it holds, so `{{c1::\mathbb{R}}}` keeps
 * its closing brace; `\{` and `\}` do not count. A deletion with no end is plain text.
 */
function deletions(text: string): Deletion[] {
  const found: Deletion[] = [];
  const open = /\{\{c\d{1,2}::/g;
  for (let match = open.exec(text); match; match = open.exec(text)) {
    const bodyStart = match.index + match[0].length;
    let depth = 0;
    let hintAt = -1;
    let end = -1;
    for (let i = bodyStart; i < text.length; i += 1) {
      const char = text[i];
      if (char === "\\") i += 1;
      else if (char === "{") depth += 1;
      else if (char === "}" && depth > 0) depth -= 1;
      else if (char === "}" && text[i + 1] === "}" && i > bodyStart) {
        end = i;
        break;
      } else if (char === ":" && text[i + 1] === ":" && depth === 0 && hintAt < 0 && i > bodyStart) {
        hintAt = i;
        i += 1;
      }
    }
    if (end < 0) continue;
    const answer = text.slice(bodyStart, hintAt < 0 ? end : hintAt);
    const hint = hintAt < 0 ? undefined : text.slice(hintAt + 2, end);
    found.push({ start: match.index, end: end + 2, answer, hint });
    open.lastIndex = end + 2;
  }
  return found;
}

export function isCloze(front: string): boolean {
  return deletions(front).length > 0;
}

/** Replaces every deletion; `inMath` is true for one written inside a `$ … $` formula, where `**` would be drawn as two asterisks. */
function replaceDeletions(
  text: string,
  render: (deletion: Deletion, inMath: boolean) => string,
): string {
  const spans = mathSpans(text);
  let out = "";
  let at = 0;
  for (const deletion of deletions(text)) {
    const inMath = spans.some(([from, to]) => deletion.start > from && deletion.start < to);
    out += text.slice(at, deletion.start) + render(deletion, inMath);
    at = deletion.end;
  }
  return out + text.slice(at);
}

/** A hint is typeset as text inside the box: TeX's own characters would break it. */
const texText = (hint: string) => hint.replace(/[\\{}%$&#_^~]/g, " ").trim();

/** Front shown while studying: every deletion becomes a bold blank, or its hint. */
export function clozeQuestion(text: string): string {
  return replaceDeletions(text, ({ hint }, inMath) => {
    const shown = hint?.trim();
    if (inMath) return shown && texText(shown) ? `\\boxed{\\text{${texText(shown)}}}` : "\\boxed{\\ldots}";
    return shown ? `**(${shown})**` : "**(…)**";
  });
}

/** Same sentence with every deletion filled in and emphasised. */
export function clozeAnswer(text: string): string {
  return replaceDeletions(text, ({ answer }, inMath) =>
    inMath ? `\\boxed{${answer.trim()}}` : `**${answer.trim()}**`,
  );
}
