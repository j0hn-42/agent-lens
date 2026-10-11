/**
 * Capabilities of a session (#242): the instruction files, skills, plugins and MCP servers its MAIN transcript
 * recorded. Only what the session received or used is reported, never what is installed on the machine.
 *
 * Evidence, per line of the transcript (sub-agent / sidechain lines are skipped):
 * - attachment `instructions` (`files[].type` + base name) and `nested_memory` (base name): instruction files;
 * - attachment `skill_listing` (`names`): skills offered to the session (union);
 * - `tool_use` of `Skill` (`input.skill`): skill invocations, counted;
 * - `tool_use` named `mcp__<server>__<tool>`: MCP tool calls, counted per server and tool;
 * - attachment `mcp_instructions_delta` (`addedNames`): MCP servers announced to the session.
 *
 * Only names leave this module: no path, no file content, no skill argument, no description, no tool input.
 * The read is bounded (head of the file), refuses symlinks and files outside `rootDir`, and an unreadable
 * transcript is reported as such, never as empty lists.
 */
import * as fs from 'fs'
import * as path from 'path'
import { isPathInside, PRESCAN_CHUNK_BYTES } from './fs-utils'
import { SESSION_CAPABILITIES_MAX_BYTES, SESSION_CAPABILITIES_MAX_ITEMS, SESSION_CAPABILITIES_MAX_NAME } from './constants'

export interface CapabilityCount { name: string; calls: number }
export interface McpServerCapability {
  name: string
  /** Named in an `mcp_instructions_delta` attachment */
  announced: boolean
  /** Tool calls seen for this server */
  calls: number
  tools: CapabilityCount[]
}
export interface InstructionFile {
  /** Type recorded by the runtime (for example Project, User, AutoMem), or `nested` for a nested memory file */
  type: string
  /** Base name only, never a path */
  name: string
}

export interface CollectedCapabilities {
  instructions: InstructionFile[]
  skillsInvoked: CapabilityCount[]
  skillsListed: string[]
  mcpServers: McpServerCapability[]
  /** At least one list hit SESSION_CAPABILITIES_MAX_ITEMS: entries are missing */
  truncated: boolean
}

export interface SessionCapabilities extends CollectedCapabilities {
  /** 'unreadable': the transcript could not be read; the lists are then empty and mean nothing */
  status: 'ok' | 'unreadable'
  /** The transcript is larger than the bound: only its head was read, counts are lower bounds */
  partial: boolean
}

const MCP_PREFIX = 'mcp__'
const TYPE_MAX = 40

function cleanName(value: unknown, max = SESSION_CAPABILITIES_MAX_NAME): string | null {
  if (typeof value !== 'string') return null
  // Control characters (C0, DEL, C1) would break a log line or a terminal
  const s = value.replace(/[\u0000-\u001F\u007F-\u009F]/g, '').trim().slice(0, max)
  return s.length > 0 ? s : null
}

/** Base name of a path written on any OS (the transcript may come from another platform). */
function baseName(p: unknown): string | null {
  if (typeof p !== 'string') return null
  const parts = p.split(/[\\/]/)
  return cleanName(parts[parts.length - 1])
}

/** `mcp__<server>__<tool>`, split on the last `__` (mirrors web/lib/mcp-tool.ts). */
function parseMcp(name: string): { server: string; tool: string } | null {
  if (!name.startsWith(MCP_PREFIX)) return null
  const rest = name.slice(MCP_PREFIX.length)
  const sep = rest.lastIndexOf('__')
  if (sep <= 0 || sep + 2 >= rest.length) return null
  const server = cleanName(rest.slice(0, sep))
  const tool = cleanName(rest.slice(sep + 2))
  return server && tool ? { server, tool } : null
}

export function collectSessionCapabilities(lines: Iterable<string>): CollectedCapabilities {
  const max = SESSION_CAPABILITIES_MAX_ITEMS
  let truncated = false
  const instructions = new Map<string, InstructionFile>()
  const invoked = new Map<string, number>()
  const listed = new Set<string>()
  const servers = new Map<string, { announced: boolean; calls: number; tools: Map<string, number> }>()

  const addInstruction = (type: string | null, name: string | null) => {
    if (!type || !name) return
    const key = `${type}\u0000${name}`
    if (instructions.has(key)) return
    if (instructions.size >= max) { truncated = true; return }
    instructions.set(key, { type, name })
  }
  const server = (name: string) => {
    let s = servers.get(name)
    if (!s) {
      if (servers.size >= max) { truncated = true; return undefined }
      s = { announced: false, calls: 0, tools: new Map() }
      servers.set(name, s)
    }
    return s
  }
  const count = (m: Map<string, number>, key: string) => {
    if (!m.has(key) && m.size >= max) { truncated = true; return }
    m.set(key, (m.get(key) ?? 0) + 1)
  }

  for (const raw of lines) {
    // Cheap pre-filter: most lines (results, text) carry no capability evidence
    if (!raw || (!raw.includes('"attachment"') && !raw.includes('"tool_use"'))) continue
    let entry: unknown
    try { entry = JSON.parse(raw) } catch { continue }
    if (typeof entry !== 'object' || entry === null) continue
    const e = entry as Record<string, unknown>
    if (e.isSidechain === true) continue

    const a = e.attachment
    if (e.type === 'attachment' && typeof a === 'object' && a !== null) {
      const att = a as Record<string, unknown>
      if (att.type === 'instructions' && Array.isArray(att.files)) {
        for (const f of att.files) {
          if (typeof f !== 'object' || f === null) continue
          const file = f as Record<string, unknown>
          addInstruction(cleanName(file.type, TYPE_MAX), baseName(file.path ?? file.name))
        }
      } else if (att.type === 'nested_memory') {
        addInstruction('nested', baseName(att.path))
      } else if (att.type === 'skill_listing' && Array.isArray(att.names)) {
        for (const n of att.names) {
          const name = cleanName(n)
          if (!name || listed.has(name)) continue
          if (listed.size >= max) { truncated = true; break }
          listed.add(name)
        }
      } else if (att.type === 'mcp_instructions_delta' && Array.isArray(att.addedNames)) {
        for (const n of att.addedNames) {
          const name = cleanName(n)
          const s = name ? server(name) : undefined
          if (s) s.announced = true
        }
      }
      continue
    }

    const content = (e.message as { content?: unknown } | undefined)?.content
    if (e.type !== 'assistant' || !Array.isArray(content)) continue
    for (const block of content) {
      if (typeof block !== 'object' || block === null) continue
      const b = block as Record<string, unknown>
      if (b.type !== 'tool_use' || typeof b.name !== 'string') continue
      if (b.name === 'Skill') {
        const skill = cleanName((b.input as { skill?: unknown } | undefined)?.skill)
        if (skill) count(invoked, skill)
        continue
      }
      const mcp = parseMcp(b.name)
      if (!mcp) continue
      const s = server(mcp.server)
      if (!s) continue
      s.calls++
      count(s.tools, mcp.tool)
    }
  }

  return {
    instructions: [...instructions.values()],
    skillsInvoked: [...invoked].map(([name, calls]) => ({ name, calls })),
    skillsListed: [...listed],
    mcpServers: [...servers].map(([name, s]) => ({
      name, announced: s.announced, calls: s.calls, tools: [...s.tools].map(([tool, calls]) => ({ name: tool, calls })),
    })),
    truncated,
  }
}

/** Complete lines of the first `size` bytes of an open file, read in chunks; the fragment after the last newline is dropped. */
function* headLines(fd: number, size: number): Generator<string> {
  let offset = 0
  let carry: Buffer = Buffer.alloc(0)
  while (offset < size) {
    const len = Math.min(PRESCAN_CHUNK_BYTES, size - offset)
    const buf = Buffer.alloc(len)
    const n = fs.readSync(fd, buf, 0, len, offset)
    if (n <= 0) break
    offset += n
    const data = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n)
    const cut = data.lastIndexOf(0x0a)
    if (cut < 0) { carry = Buffer.from(data); continue }
    carry = Buffer.from(data.subarray(cut + 1))
    yield* data.subarray(0, cut).toString('utf-8').split(/\r?\n/)
  }
}

/** The answer when the transcript cannot be read: an explicit status, never lists that would read as "nothing". */
export function unreadableCapabilities(): SessionCapabilities {
  return { status: 'unreadable', partial: false, truncated: false, instructions: [], skillsInvoked: [], skillsListed: [], mcpServers: [] }
}

/**
 * Read the capabilities recorded by a transcript. `rootDir` bounds where the file may live (its real path);
 * symlinks and non-regular files are refused. Only the first `maxBytes` bytes are read.
 */
export function readSessionCapabilities(filePath: string, rootDir: string, maxBytes = SESSION_CAPABILITIES_MAX_BYTES): SessionCapabilities {
  let fd: number | undefined
  try {
    const st = fs.lstatSync(filePath)
    if (!st.isFile()) return unreadableCapabilities()
    if (!isPathInside(fs.realpathSync(filePath), fs.realpathSync(rootDir))) return unreadableCapabilities()
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
    const size = fs.fstatSync(fd).size
    const collected = collectSessionCapabilities(headLines(fd, Math.min(size, maxBytes)))
    return { status: 'ok', partial: size > maxBytes, ...collected }
  } catch {
    return unreadableCapabilities()
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd) } catch { /* already closed */ }
  }
}

/**
 * Memoised {@link readSessionCapabilities}: a transcript is parsed again only when its size or mtime changed.
 * Bounded to `maxEntries` files (oldest forgotten first). An unreadable result is never kept.
 */
export function createSessionCapabilitiesReader(maxEntries = 20, read = readSessionCapabilities) {
  const cache = new Map<string, { stamp: string; value: SessionCapabilities }>()
  return (filePath: string, rootDir: string): SessionCapabilities => {
    let stamp = ''
    try { const st = fs.lstatSync(filePath); stamp = `${st.size}:${st.mtimeMs}:${st.ino}:${path.resolve(rootDir)}` } catch { /* read() reports it */ }
    const hit = cache.get(filePath)
    if (stamp && hit && hit.stamp === stamp) return hit.value
    const value = read(filePath, rootDir)
    cache.delete(filePath)
    if (stamp && value.status === 'ok') {
      cache.set(filePath, { stamp, value })
      while (cache.size > maxEntries) cache.delete(cache.keys().next().value as string)
    }
    return value
  }
}
