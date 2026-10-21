// Helpers shared by several domains of the message catalog (#612). Not a domain: no message here.

import { ROLLUP_INCOMPLETE_TEXT } from '../cost-rollup'

/** The word of the "(incomplete)" badge, as the totals spell it (cost-rollup), without its parentheses */
export const INCOMPLETE = ROLLUP_INCOMPLETE_TEXT.replace(/[()]/g, '')

/** The one French name of the Files & repeats panel (#518, WCAG 3.2.4): the English one is PANEL_NAMES.files. */
export const FILES_PANEL_FR = 'Fichiers et répétitions'
