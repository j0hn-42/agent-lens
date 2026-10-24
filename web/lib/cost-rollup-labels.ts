// The English words of a cost or token total (#501), a leaf (#662): the message catalog reads them from here, so a
// locale table chunk carries no cost or usage code; cost-rollup.ts re-exports them.

export const ROLLUP_UNKNOWN_TEXT = 'unknown'
export const ROLLUP_INCOMPLETE_TEXT = '(incomplete)'

/** Accessible explanation of the incomplete badge. */
export const ROLLUP_INCOMPLETE_HELP =
  'Incomplete total: some agents have an unknown token count, a missing parent, a session of the family has no data, branches are nested too deeply, or the relay (or the VS Code extension) could not replay events of a session this total counts, so the real figure may differ.'
