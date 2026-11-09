/** How the student keeps material: one folder whose subfolders are subjects, or one folder per subject. */
export const LINK_MODES = ["root", "subject"] as const;
export type LinkMode = (typeof LINK_MODES)[number];

/** The kinds of material a subject folder can hold, as setup lists them (libro, slide, temi d'esame...). */
export const MATERIAL_KINDS = ["book", "slides", "exams", "notes", "exercises", "handouts"] as const;
export type MaterialKind = (typeof MATERIAL_KINDS)[number];

/** Folders one request may link: a multiple pick in the per-subject mode. */
export const MAX_LINK_PATHS = 20;

/** A subject name, as `subjects` stores it. */
export const MAX_SUBJECT_NAME = 120;

/**
 * A linked folder is read with no cap on files, but folders nested deeper than this are not opened. Links are never
 * followed, so this only stops a tree that is absurdly deep.
 */
export const MAX_LINKED_DEPTH = 32;
