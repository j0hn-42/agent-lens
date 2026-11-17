/**
 * Burrow view: the words of one row of the *Burrow agents* list. The list is the text path of the scene (bubbles, tags
 * and badges are aria-hidden), so a row says what the scene shows of its agent and the facts the graph shows of it:
 * a proven loop (the graph's loop badge) and the events its session could not replay (the graph's lower bounds).
 * Pure (no React): the view passes its `t`.
 */
import type { MessageKey } from '../messages'
import type { BurrowRoomId } from './burrow-types'
import type { BurrowRow } from './burrow-sync'
import { burrowRoomOfTool } from './burrow-model'

type Translate = (key: MessageKey, params?: Readonly<Record<string, string | number>>) => string

function baseLabel(r: BurrowRow, t: Translate): string {
  if (r.presence === 'finished') return t('burrow.agent.done', { name: r.name })
  const state = t(`state.${r.state}` as 'state.idle')
  if (r.stale) return t('burrow.agent.stale', { name: r.name, state })
  const room = t(`burrow.room.${r.room satisfies BurrowRoomId}` as 'burrow.room.lounge')
  if (!r.tool) return t('burrow.agent', { name: r.name, state, room })
  // the animal follows the room of most of its recent calls: when that is not the running tool's room, the row says so
  return burrowRoomOfTool(r.tool) === r.room
    ? t('burrow.agent.tool', { name: r.name, state, room, tool: r.tool })
    : t('burrow.agent.toolElsewhere', { name: r.name, state, room, tool: r.tool })
}

/** A sub-agent names its orchestrator (found in `rows`); an orchestrator says how many sub-agents it still waits for */
export function burrowRowLabel(r: BurrowRow, rows: readonly BurrowRow[], t: Translate): string {
  let label = baseLabel(r, t)
  // how long it has waited for you at the post beside the front door: a lower bound, counted from when the burrow saw it there
  const waited = r.waited ?? 0
  if (waited > 0) label = waited === 1 ? t('burrow.agent.waited.one', { row: label }) : t('burrow.agent.waited.many', { row: label, n: waited })
  // a tool call just seen failing (the animal stumbles): its tool and its exit code, each only when received
  const f = r.failed
  if (f) {
    label = f.tool === undefined ? t('burrow.agent.failed.unnamed', { row: label })
      : f.exit === undefined ? t('burrow.agent.failed', { row: label, tool: f.tool })
        : t('burrow.agent.failed.code', { row: label, tool: f.tool, code: f.exit })
  }
  // the team or workflow the floor ring stands for (the ring itself is drawn in the canvas, not read)
  if (r.team) label = t(r.team.kind === 'workflow' ? 'burrow.agent.workflow' : 'burrow.agent.team', { row: label, team: r.team.name })
  if (r.loop) label = t('burrow.agent.loop', { row: label })
  const lost = r.replayLost ?? 0
  if (lost > 0) label = lost === 1 ? t('burrow.agent.replayLost.one', { row: label }) : t('burrow.agent.replayLost.many', { row: label, n: lost })
  const n = r.delegating ?? 0
  if (n > 0) label = n === 1 ? t('burrow.agent.delegating.one', { row: label }) : t('burrow.agent.delegating.many', { row: label, n })
  const parent = r.parentId ? rows.find((o) => o.id === r.parentId) : undefined
  if (parent) label = t('burrow.agent.child', { row: label, parent: parent.name })
  return label
}
