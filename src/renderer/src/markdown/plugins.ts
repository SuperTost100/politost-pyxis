import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import "katex/dist/katex.min.css";
// Chemistry: \ce and \pu.
import "katex/contrib/mhchem";

// The plugins every Markdown view uses, so messages, lessons, inline text and printed pages draw math the same way.
// Built once: react-markdown can then reuse its pipeline across renders.

/** Tables, task lists and autolinks, plus `$...$` math. */
export const remarkPlugins = [remarkGfm, remarkMath];
/** Math only, for text that sits inside a button or label and can hold no blocks. */
export const inlineRemarkPlugins = [remarkMath];
export const rehypePlugins = [rehypeKatex];
