import type { Agent, Discovery } from '@/lib/agent-types'
import type { SimulationState } from '@/hooks/simulation/types'
import { STATE_LABEL_LONG } from '@/lib/canvas-constants'
import { formatModelName } from '@/lib/utils'
import { agentStatusText, teammateActivity, cleanText, agentDrawRadius } from './team-style'
import type { NavNode } from './keyboard-nav'

export interface TooltipContent { title: string; lines: string[] }

/** Full name, state, model and task for an agent; name, state and args for a tool. */
export function describeTooltip(node: NavNode, sim: SimulationState): TooltipContent | null {
  if (node.type === 'agent') {
    const a = sim.agents.get(node.id)
    if (!a) return null
    const lines = [
      `State: ${STATE_LABEL_LONG[a.state] ?? a.state}`,
      `Model: ${a.model ? formatModelName(a.model) : 'unknown'}`,
    ]
    if (a.kind === 'teammate') {
      lines.unshift(`Teammate${a.teamName ? ` of team ${cleanText(a.teamName)}` : ''}: ${teammateActivity(a) ?? agentStatusText(a)}`)
    }
    if (a.archived) lines.unshift('Archived: finished, kept so its conversation stays reachable')
    if (a.task) lines.push(`Task: ${a.task.length > 160 ? a.task.slice(0, 159) + '…' : a.task}`)
    return { title: a.name, lines }
  }
  if (node.type === 'tool') {
    const t = sim.toolCalls.get(node.id)
    if (!t) return null
    const lines = [`State: ${t.state}`]
    if (t.args) lines.push(t.args.length > 160 ? t.args.slice(0, 159) + '…' : t.args)
    return { title: t.toolName, lines }
  }
  const d = sim.discoveries.find(x => x.id === node.id)
  if (!d) return null
  return { title: d.label, lines: [`Discovery: ${d.type}`] }
}

/** Anchor the tooltip above its node in screen space; hide when the node is gone or off-canvas. */
export function positionTooltip(
  el: HTMLDivElement | null,
  transform: { x: number; y: number; scale: number },
  canvasW: number,
  canvasH: number,
  scene: { agents: Map<string, Agent>; toolCalls: SimulationState['toolCalls']; discoveries: Discovery[] },
  target: NavNode | null,
) {
  if (!el) return
  let wx: number | null = null
  let wy: number | null = null
  let radius = 0
  if (target?.type === 'agent') {
    const a = scene.agents.get(target.id)
    if (a) { wx = a.x; wy = a.y; radius = agentDrawRadius(a) }
  } else if (target?.type === 'tool') {
    const t = scene.toolCalls.get(target.id)
    if (t) { wx = t.x; wy = t.y; radius = 16 }
  } else if (target?.type === 'discovery') {
    const d = scene.discoveries.find(x => x.id === target.id)
    if (d) { wx = d.x; wy = d.y; radius = 16 }
  }
  if (wx === null || wy === null) {
    if (el.style.visibility !== 'hidden') el.style.visibility = 'hidden'
    return
  }
  const sx = wx * transform.scale + transform.x
  const sy = wy * transform.scale + transform.y - radius * transform.scale - 8
  const tw = el.offsetWidth
  const th = el.offsetHeight
  const x = Math.min(Math.max(sx - tw / 2, 4), Math.max(4, canvasW - tw - 4))
  // Flip below the node when there is no room above
  const y = sy - th < 4 ? sy + radius * transform.scale * 2 + 16 : sy - th
  el.style.transform = `translate(${Math.round(x)}px, ${Math.round(Math.min(Math.max(y, 4), Math.max(4, canvasH - th - 4)))}px)`
  if (el.style.visibility !== 'visible') el.style.visibility = 'visible'
}
