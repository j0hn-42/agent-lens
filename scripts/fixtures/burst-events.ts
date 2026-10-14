// A history burst (#210): what a switch to 'All', a relay replay or a seek feeds the simulation at once.
import type { SimulationEvent } from '../../web/lib/agent-types'

const TOOLS = ['Read', 'Edit', 'Bash', 'Grep', 'Write']

/**
 * `total` events over `agentCount` main agents of `sessions` sessions: the spawns, then tool calls and
 * messages in turn. One end for every other start, so running tool calls pile up as in a real backlog.
 */
export function burstEvents(total: number, agentCount: number, sessions = 20): SimulationEvent[] {
  const events: SimulationEvent[] = []
  const agents: Array<{ sessionId: string; name: string }> = []
  for (let i = 0; i < agentCount && events.length < total; i++) {
    const sessionId = `s${i % sessions}`
    const name = `agent-${i}`
    agents.push({ sessionId, name })
    events.push({ time: events.length * 0.01, sessionId, type: 'agent_spawn', payload: { name, isMain: true, task: `task ${i}` } })
  }
  let n = 0
  while (events.length < total) {
    const k = n % agents.length
    const round = Math.floor(n / agents.length)
    const { sessionId, name } = agents[k]
    const tool = TOOLS[Math.floor(round / 3) % TOOLS.length]
    const time = events.length * 0.01
    const kind = round % 3
    if (kind === 0) {
      events.push({ time, sessionId, type: 'tool_call_start', payload: { agent: name, tool, args: `file-${n}.ts`, inputData: { file_path: `src/file-${n % 50}.ts` } } })
    } else if (kind === 1) {
      events.push({ time, sessionId, type: 'message', payload: { agent: name, role: n % 2 ? 'assistant' : 'user', content: `message ${n}` } })
    } else if ((Math.floor(round / 3) + k) % 2 === 0) {
      events.push({ time, sessionId, type: 'tool_call_end', payload: { agent: name, tool, result: 'ok', isError: false } })
    } else {
      events.push({ time, sessionId, type: 'context_update', payload: { agent: name, tokens: 1000 + n } })
    }
    n++
  }
  return events
}
