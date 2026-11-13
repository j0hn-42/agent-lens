/**
 * Burrow view: what the picture may say about delegation. Only observed link messages count: a dispatch (the prompt
 * sent to a sub-agent), a return (its report), a message between teammates. Nothing is inferred from timing or names.
 */
import type { AgentLink } from '../../hooks/simulation/types'

export type MailKind = 'dispatch' | 'return' | 'message'
export interface Mail { id: string; kind: MailKind; from: string; to: string }

export interface MailState {
  /** Ids of the link messages already seen (bounded by what the links still hold) */
  seen: Set<string>
  started: boolean
}
export const createMailState = (): MailState => ({ seen: new Set(), started: false })

const isMail = (t: string): t is MailKind => t === 'dispatch' || t === 'return' || t === 'message'

/**
 * Messages received since the last call, oldest first. The first call only takes note of the history: a view that
 * opens on a running session does not replay the letters already delivered.
 */
export function newMail(links: ReadonlyMap<string, AgentLink> | undefined, st: MailState): Mail[] {
  const out: Mail[] = []
  const live = new Set<string>()
  if (links) {
    for (const link of links.values()) {
      for (const m of link.messages) {
        if (!isMail(m.type)) continue
        live.add(m.id)
        if (st.seen.has(m.id)) continue
        st.seen.add(m.id)
        const from = m.from ?? link.from
        const to = m.to ?? link.to
        if (st.started && from && to && from !== to) out.push({ id: m.id, kind: m.type, from, to })
      }
    }
  }
  for (const id of st.seen) if (!live.has(id)) st.seen.delete(id)
  st.started = true
  return out
}

/** Cheap fingerprint of the links: changes when a message is added or dropped */
export function linksSignature(links: ReadonlyMap<string, AgentLink> | undefined): string {
  if (!links) return ''
  let n = 0
  let d = 0
  for (const l of links.values()) { n += l.messages.length; d += l.dropped }
  return `${links.size}|${n}|${d}`
}

/**
 * Sub-agents each orchestrator still waits for: a spawn link whose dispatches are not all answered by a return of the
 * same tool call, to a sub-agent that is still live (`isLive`). A sub-agent that finished without a recorded return
 * is not counted: nothing proves it is still working for its parent.
 */
export function openDelegations(links: ReadonlyMap<string, AgentLink> | undefined, isLive: (key: string) => boolean): Map<string, number> {
  const out = new Map<string, number>()
  if (!links) return out
  for (const link of links.values()) {
    if (link.kind !== 'spawn' || !isLive(link.to)) continue
    const pending = new Map<string, number>()
    for (const m of link.messages) {
      if (m.type !== 'dispatch' && m.type !== 'return') continue
      const k = m.toolUseId ?? ''
      pending.set(k, Math.max(0, (pending.get(k) ?? 0) + (m.type === 'dispatch' ? 1 : -1)))
    }
    let open = false
    for (const n of pending.values()) if (n > 0) open = true
    if (open) out.set(link.from, (out.get(link.from) ?? 0) + 1)
  }
  return out
}

/**
 * Orchestrators: the agents at least one known sub-agent names as its parent (the crown of the burrow). The link is
 * observed (a spawn), never guessed from a name; a parent missing from the data wears nothing.
 */
export function orchestratorsOf(agents: ReadonlyMap<string, { parentId: string | null }>): Set<string> {
  const out = new Set<string>()
  for (const [key, a] of agents) if (a.parentId && a.parentId !== key && agents.has(a.parentId)) out.add(a.parentId)
  return out
}

/** The parent and the children of an agent, among the keys `has` accepts (the animals drawn) */
export function relativesOf(
  id: string,
  agents: ReadonlyMap<string, { parentId: string | null }>,
  has: (key: string) => boolean,
): string[] {
  const out: string[] = []
  const parent = agents.get(id)?.parentId
  if (parent && parent !== id && has(parent)) out.push(parent)
  for (const [key, a] of agents) if (a.parentId === id && key !== id && has(key)) out.push(key)
  return out
}

/**
 * Rows in tree order: each agent is followed by its sub-agents (depth + 1). A row whose parent is not listed stays a
 * root. Order among siblings is the input order.
 */
export function treeOrder<T extends { id: string; parentId: string | null }>(rows: readonly T[]): Array<T & { depth: number }> {
  const ids = new Set(rows.map((r) => r.id))
  const children = new Map<string, T[]>()
  const roots: T[] = []
  for (const r of rows) {
    if (r.parentId && r.parentId !== r.id && ids.has(r.parentId)) {
      const list = children.get(r.parentId) ?? []
      list.push(r)
      children.set(r.parentId, list)
    } else roots.push(r)
  }
  const out: Array<T & { depth: number }> = []
  const done = new Set<string>()
  const visit = (r: T, depth: number): void => {
    if (done.has(r.id)) return
    done.add(r.id)
    out.push({ ...r, depth })
    for (const c of children.get(r.id) ?? []) visit(c, depth + 1)
  }
  for (const r of roots) visit(r, 0)
  for (const r of rows) visit(r, 0)            // a cycle in parentId: still listed once
  return out
}
