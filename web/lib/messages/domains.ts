// The domains of the message catalog (#612): one file per domain in this folder, each with its fr and en tables.
// A new domain file is imported and listed here, then spread in both tables of web/lib/messages.ts;
// scripts/messages.test.ts fails on a file that is not listed or not assembled.

import * as common from './common'
import * as topbar from './topbar'
import * as canvas from './canvas'
import * as agentCard from './agent-card'
import * as relay from './relay'
import * as playback from './playback'
import * as sessions from './sessions'
import * as conversation from './conversation'
import * as timeline from './timeline'
import * as files from './files'
import * as context from './context'
import * as operator from './operator'
import * as settings from './settings'
import * as announcements from './announcements'
import * as palette from './palette'
import * as tour from './tour'
import * as tray from './tray'

export const MESSAGE_DOMAINS = {
  common,
  topbar,
  canvas,
  'agent-card': agentCard,
  relay,
  playback,
  sessions,
  conversation,
  timeline,
  files,
  context,
  operator,
  settings,
  announcements,
  palette,
  tour,
  tray,
} as const
