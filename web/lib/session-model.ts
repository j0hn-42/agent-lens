/**
 * Which model each session runs, learned from its events: the main agent's model (reported by
 * agent_spawn or model_detected), else the latest model any of its agents reported. Pure (no React).
 */

const MAX_SESSIONS = 200
const MAX_AGENTS_PER_SESSION = 100
const MAX_MODEL_LEN = 120

interface Entry {
  mainAgent?: string
  /** agent name -> last model reported (insertion order = report order) */
  models: Map<string, string>
}

export interface ModelEventLike {
  type: string
  payload: Record<string, unknown>
  sessionId?: string
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v.slice(0, MAX_MODEL_LEN) : undefined
}

export class SessionModelTracker {
  private entries = new Map<string, Entry>()

  /** Feed one event; true when the resolved model of its session changed. */
  ingest(event: ModelEventLike): boolean {
    const sessionId = event.sessionId
    if (!sessionId) return false
    if (event.type !== 'agent_spawn' && event.type !== 'model_detected') return false
    const agent = str(event.payload.agent) ?? str(event.payload.name)
    if (!agent) return false
    const model = str(event.payload.model)
    const isMainSpawn = event.type === 'agent_spawn' && event.payload.isMain === true
    if (!model && !isMainSpawn) return false

    const before = this.modelOf(sessionId)
    let entry = this.entries.get(sessionId)
    if (!entry) {
      entry = { models: new Map() }
      this.entries.set(sessionId, entry)
      if (this.entries.size > MAX_SESSIONS) {
        const oldest = this.entries.keys().next().value
        if (oldest !== undefined) this.entries.delete(oldest)
      }
    }
    if (isMainSpawn) entry.mainAgent = agent
    if (model) {
      entry.models.delete(agent)
      entry.models.set(agent, model)
      if (entry.models.size > MAX_AGENTS_PER_SESSION) {
        const oldest = entry.models.keys().next().value
        if (oldest !== undefined && oldest !== entry.mainAgent) entry.models.delete(oldest)
      }
    }
    return this.modelOf(sessionId) !== before
  }

  modelOf(sessionId: string): string | undefined {
    const entry = this.entries.get(sessionId)
    if (!entry) return undefined
    if (entry.mainAgent) {
      const main = entry.models.get(entry.mainAgent)
      if (main) return main
    }
    let last: string | undefined
    for (const m of entry.models.values()) last = m
    return last
  }

  /** Snapshot of the resolved model per session. */
  snapshot(): Map<string, string> {
    const out = new Map<string, string>()
    for (const id of this.entries.keys()) {
      const m = this.modelOf(id)
      if (m) out.set(id, m)
    }
    return out
  }

  clear(): void {
    this.entries.clear()
  }
}
