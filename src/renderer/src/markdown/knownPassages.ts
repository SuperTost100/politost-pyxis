import { createContext } from "react";
import type { KnownPassage } from "./citations";

/**
 * The passages a page knows, for the texts inside it that are not given them, such as a worked example or a quiz option
 * in a lesson part. A text with neither shows its [Pn] as it is stored: only a page with a sources row hides its marks.
 * A .ts file, so `InlineMarkdown` can read it in the node-side typecheck and tests.
 */
export const KnownPassages = createContext<KnownPassage | undefined>(undefined);
