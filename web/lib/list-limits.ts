// How many items a bounded list keeps (#662: a leaf). The words that quote them (ui-glossary.ts, the message catalog)
// read them from here, so a locale table chunk carries no file-timeline or git code; those modules re-export them.

/** Steps kept per file; the older ones are counted, not listed. */
export const FILE_TIMELINE_MAX_STEPS = 50

/** Commits and pull requests the git strip lists; the older ones are counted. */
export const GIT_STRIP_MAX_COMMITS = 20
export const GIT_STRIP_MAX_PRS = 5
