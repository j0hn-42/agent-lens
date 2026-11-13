/**
 * Burrow view: the words of one row of the *Burrow agents* list. The list is the text path of the scene (bubbles, tags
 * and badges are aria-hidden), so a row says what the scene shows of its agent and the facts the graph shows of it:
 * a proven loop (the graph's loop badge) and the events its session could not replay (the graph's lower bounds).
 * Pure (no React): the view passes its `t`.
 */
import type { MessageKey } from '../messages'
import type { BurrowRoomId } from './burrow-types'
import type { BurrowRow } from './burrow-sync'

type Translate = (key: MessageKey, params?: Readonly<Record<string, string | number>>) => string

function baseLabel(r: BurrowRow, t: Translate): string {
  if (r.presence === 'finished') return t('burrow.agent.done', { name: r.name })
  const state = t(`state.${r.state}` as 'state.idle')
  if (r.stale) return t('burrow.agent.stale', { name: r.name, state })
  const room = t(`burrow.room.${r.room satisfies BurrowRoomId}` as 'burrow.room.lounge')
  return r.tool
    ? t('burrow.agent.tool', { name: r.name, state, room, tool: r.tool })
    : t('burrow.agent', { name: r.name, state, room })
}

/** A sub-agent names its orchestrator (found in `rows`); an orchestrator says how many sub-agents it still waits for */
export function burrowRowLabel(r: BurrowRow, rows: readonly BurrowRow[], t: Translate): string {
  let label = baseLabel(r, t)
  if (r.loop) label = t('burrow.agent.loop', { row: label })
  const lost = r.replayLost ?? 0
  if (lost > 0) label = lost === 1 ? t('burrow.agent.replayLost.one', { row: label }) : t('burrow.agent.replayLost.many', { row: label, n: lost })
  const n = r.delegating ?? 0
  if (n > 0) label = n === 1 ? t('burrow.agent.delegating.one', { row: label }) : t('burrow.agent.delegating.many', { row: label, n })
  const parent = r.parentId ? rows.find((o) => o.id === r.parentId) : undefined
  if (parent) label = t('burrow.agent.child', { row: label, parent: parent.name })
  return label
}
