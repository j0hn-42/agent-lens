/**
 * Capabilities of a session (#242), as sent by the relay in GET /context: instruction files, skills and MCP
 * servers recorded by the session's main transcript. The payload is untrusted: every field is checked and
 * bounded; anything off makes the whole block invalid (said so in the UI), never silently partial.
 */

/** Mirrors extension/src/session-capabilities.ts (kept separate, like bridge-types). */
export interface CapabilityCount { name: string; calls: number }
export interface McpServerCapability { name: string; announced: boolean; calls: number; tools: CapabilityCount[] }
export interface InstructionFile { type: string; name: string }
export interface SessionCapabilities {
  status: 'ok' | 'unreadable'
  /** Only the head of the transcript was read: every count is a lower bound */
  partial: boolean
  /** A list hit the relay's cap: entries are missing */
  truncated: boolean
  instructions: InstructionFile[]
  skillsInvoked: CapabilityCount[]
  skillsListed: string[]
  mcpServers: McpServerCapability[]
}

/** Mirrors SESSION_CAPABILITIES_MAX_BYTES (in MB, for the "partial" note) */
export const CAPABILITIES_READ_LIMIT_MB = 32
/** Mirrors SESSION_CAPABILITIES_MAX_ITEMS / SESSION_CAPABILITIES_MAX_NAME */
const MAX_ITEMS = 200
const MAX_NAME = 120

const isName = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= MAX_NAME
const isCount = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0
const isList = (v: unknown): v is unknown[] => Array.isArray(v) && v.length <= MAX_ITEMS

function parseCounts(v: unknown): CapabilityCount[] | null {
  if (!isList(v)) return null
  const out: CapabilityCount[] = []
  for (const x of v) {
    if (typeof x !== 'object' || x === null) return null
    const { name, calls } = x as Record<string, unknown>
    if (!isName(name) || !isCount(calls)) return null
    out.push({ name, calls })
  }
  return out
}

/** Validate the relay's `capabilities` field; null when it does not have the expected shape. */
export function parseSessionCapabilities(raw: unknown): SessionCapabilities | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if ((r.status !== 'ok' && r.status !== 'unreadable') || typeof r.partial !== 'boolean' || typeof r.truncated !== 'boolean') return null
  if (!isList(r.instructions) || !isList(r.skillsListed) || !isList(r.mcpServers)) return null

  const instructions: InstructionFile[] = []
  for (const x of r.instructions) {
    if (typeof x !== 'object' || x === null) return null
    const { type, name } = x as Record<string, unknown>
    if (!isName(type) || !isName(name)) return null
    instructions.push({ type, name })
  }
  if (!r.skillsListed.every(isName)) return null
  const skillsInvoked = parseCounts(r.skillsInvoked)
  if (!skillsInvoked) return null
  const mcpServers: McpServerCapability[] = []
  for (const x of r.mcpServers) {
    if (typeof x !== 'object' || x === null) return null
    const s = x as Record<string, unknown>
    const tools = parseCounts(s.tools)
    if (!isName(s.name) || typeof s.announced !== 'boolean' || !isCount(s.calls) || !tools) return null
    mcpServers.push({ name: s.name, announced: s.announced, calls: s.calls, tools })
  }
  return {
    status: r.status, partial: r.partial, truncated: r.truncated,
    instructions, skillsInvoked, skillsListed: [...r.skillsListed as string[]], mcpServers,
  }
}

export interface SkillRow {
  /** Name inside its plugin (the part after `plugin:`) */
  name: string
  fullName: string
  /** Invocations seen (0: listed only) */
  calls: number
  /** Present in a skill listing given to the session */
  listed: boolean
}
export interface PluginGroup {
  /** Plugin namespace of the skill names, null for skills without one */
  plugin: string | null
  skills: SkillRow[]
}

/** Plugin of a skill name: the part before the first `:` when both sides are non-empty. */
function splitSkill(fullName: string): { plugin: string | null; name: string } {
  const i = fullName.indexOf(':')
  return i > 0 && i < fullName.length - 1 ? { plugin: fullName.slice(0, i), name: fullName.slice(i + 1) } : { plugin: null, name: fullName }
}

/**
 * Skills invoked or listed, grouped by plugin. Plugins in alphabetical order, the group without plugin last;
 * inside a group, invoked skills first (most calls first), then listed-only ones alphabetically.
 */
export function groupSkillsByPlugin(caps: SessionCapabilities): PluginGroup[] {
  const rows = new Map<string, SkillRow & { plugin: string | null }>()
  const row = (fullName: string) => {
    let r = rows.get(fullName)
    if (!r) { const { plugin, name } = splitSkill(fullName); r = { plugin, name, fullName, calls: 0, listed: false }; rows.set(fullName, r) }
    return r
  }
  for (const s of caps.skillsInvoked) row(s.name).calls += s.calls
  for (const n of caps.skillsListed) row(n).listed = true

  const groups = new Map<string | null, SkillRow[]>()
  for (const { plugin, ...skill } of rows.values()) {
    const list = groups.get(plugin) ?? []
    list.push(skill)
    groups.set(plugin, list)
  }
  const byUse = (a: SkillRow, b: SkillRow) => (b.calls - a.calls) || a.name.localeCompare(b.name)
  return [...groups]
    .sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : a.localeCompare(b)))
    .map(([plugin, skills]) => ({ plugin, skills: skills.sort(byUse) }))
}
