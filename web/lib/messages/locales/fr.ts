/// <reference path="./locale-query.d.ts" />
// The French table (#662): every domain of ../domains.ts, imported with `?locale=fr`. The query makes the bundler build
// one instance of each domain module for this table, where only `fr` is used, so the English table is not in this
// chunk (and this one is not in the first load: web/lib/messages.ts imports it on demand). A domain added to
// domains.ts is added here and in en.ts; scripts/lazy-bundle.test.ts fails otherwise.
import type { MessageTable } from '../../messages'
import { fr as common } from '../common?locale=fr'
import { fr as topbar } from '../topbar?locale=fr'
import { fr as canvas } from '../canvas?locale=fr'
import { fr as agentCard } from '../agent-card?locale=fr'
import { fr as relay } from '../relay?locale=fr'
import { fr as playback } from '../playback?locale=fr'
import { fr as sessions } from '../sessions?locale=fr'
import { fr as conversation } from '../conversation?locale=fr'
import { fr as timeline } from '../timeline?locale=fr'
import { fr as files } from '../files?locale=fr'
import { fr as context } from '../context?locale=fr'
import { fr as operator } from '../operator?locale=fr'
import { fr as settings } from '../settings?locale=fr'
import { fr as announcements } from '../announcements?locale=fr'
import { fr as palette } from '../palette?locale=fr'
import { fr as tour } from '../tour?locale=fr'
import { fr as tray } from '../tray?locale=fr'

/** In the order of domains.ts; scripts/messages.test.ts checks no key is in two domains */
export const TABLE = Object.freeze(Object.assign({}, common, topbar, canvas, agentCard, relay, playback, sessions, conversation, timeline, files, context, operator, settings, announcements, palette, tour, tray)) as MessageTable
