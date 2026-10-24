/// <reference path="./locale-query.d.ts" />
// The English table (#662): every domain of ../domains.ts, imported with `?locale=en`. The query makes the bundler build
// one instance of each domain module for this table, where only `en` is used, so the French table is not in this
// chunk (this one is the default locale: web/lib/messages.ts imports it statically). A domain added to
// domains.ts is added here and in fr.ts; scripts/lazy-bundle.test.ts fails otherwise.
import type { MessageTable } from '../../messages'
import { en as common } from '../common?locale=en'
import { en as topbar } from '../topbar?locale=en'
import { en as canvas } from '../canvas?locale=en'
import { en as agentCard } from '../agent-card?locale=en'
import { en as relay } from '../relay?locale=en'
import { en as playback } from '../playback?locale=en'
import { en as sessions } from '../sessions?locale=en'
import { en as conversation } from '../conversation?locale=en'
import { en as timeline } from '../timeline?locale=en'
import { en as files } from '../files?locale=en'
import { en as context } from '../context?locale=en'
import { en as operator } from '../operator?locale=en'
import { en as settings } from '../settings?locale=en'
import { en as announcements } from '../announcements?locale=en'
import { en as palette } from '../palette?locale=en'
import { en as tour } from '../tour?locale=en'
import { en as tray } from '../tray?locale=en'

/** In the order of domains.ts; scripts/messages.test.ts checks no key is in two domains */
export const TABLE = Object.freeze(Object.assign({}, common, topbar, canvas, agentCard, relay, playback, sessions, conversation, timeline, files, context, operator, settings, announcements, palette, tour, tray)) as MessageTable
