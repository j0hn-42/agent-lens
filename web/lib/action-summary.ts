// Per-action summaries for the tool cards (#317). Each figure is read from the call's own input;
// when the input does not carry it, the function returns null / [] and the card shows nothing.

export interface EditStats {
  added: number
  removed: number
  /** Number of edit blocks for MultiEdit, null for a single Edit */
  blocks: number | null
}

export interface ShellCommand {
  tool: 'git' | 'gh'
  /** Subcommand as written in the command: `commit`, `checkout -b`, `pr create` */
  sub: string
}

export type ToolingKind = 'python' | 'test' | 'docker' | 'package'

export interface ToolingCommand {
  kind: ToolingKind
  /** The command as written, trimmed to what identifies it: `python analyse.py`, `pnpm test` */
  label: string
}

const lineCount = (s: string) => (s === '' ? 0 : s.split('\n').length)

function pairStats(old: unknown, next: unknown): { added: number; removed: number } | null {
  if (typeof old !== 'string' || typeof next !== 'string') return null
  return { added: lineCount(next), removed: lineCount(old) }
}

/** Lines added / removed by an Edit or MultiEdit call, from its old_string / new_string. */
export function editStats(toolName: string, input: Record<string, unknown>): EditStats | null {
  if (toolName === 'Edit') {
    const s = pairStats(input.old_string, input.new_string)
    return s && { ...s, blocks: null }
  }
  if (toolName === 'MultiEdit') {
    const edits = input.edits
    if (!Array.isArray(edits) || edits.length === 0) return null
    let added = 0
    let removed = 0
    for (const e of edits) {
      const s = e && typeof e === 'object' ? pairStats((e as Record<string, unknown>).old_string, (e as Record<string, unknown>).new_string) : null
      if (!s) return null
      added += s.added
      removed += s.removed
    }
    return { added, removed, blocks: edits.length }
  }
  return null
}

/** Lines of the content a Write call carries (null when the input has none). */
export function writeStats(input: Record<string, unknown>): { lines: number } | null {
  return typeof input.content === 'string' ? { lines: lineCount(input.content) } : null
}

const positive = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0

/** Line range a Read call asked for; `to` is null when only an offset was given. Null when neither is stated. */
export function readRange(input: Record<string, unknown>): { from: number; to: number | null } | null {
  const offset = positive(input.offset) ? input.offset : null
  const limit = positive(input.limit) ? input.limit : null
  if (offset == null && limit == null) return null
  const from = offset ?? 1
  return { from, to: limit == null ? null : from + limit - 1 }
}

/** Progress of a TodoWrite list, counted from the list the call carries. Null when it is not a usable list. */
export function todoProgress(input: Record<string, unknown>): { done: number; active: number; total: number } | null {
  const todos = input.todos
  if (!Array.isArray(todos) || todos.length === 0) return null
  let done = 0
  let active = 0
  for (const t of todos) {
    if (!t || typeof t !== 'object') return null
    const { content, status } = t as Record<string, unknown>
    if (typeof content !== 'string' || typeof status !== 'string') return null
    if (status === 'completed') done++
    else if (status === 'in_progress') active++
  }
  return { done, active, total: todos.length }
}

/** Host of an http(s) URL; null for anything else. */
export function urlHost(url: unknown): string | null {
  if (typeof url !== 'string') return null
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.host : null
  } catch {
    return null
  }
}

/** The cell and mode a NotebookEdit call states (each null when absent). */
export function notebookCell(input: Record<string, unknown>): { cell: string | null; mode: string | null } {
  const cell = typeof input.cell_number === 'number' ? `cell ${input.cell_number}` : typeof input.cell_id === 'string' ? `cell ${input.cell_id}` : null
  return { cell, mode: typeof input.edit_mode === 'string' ? input.edit_mode : null }
}

/** Split a shell line into segments on unquoted `&&`, `||`, `;`, `|` and newlines, each into words. */
function splitShell(command: string): string[][] {
  const segments: string[][] = []
  let words: string[] = []
  let word = ''
  let inWord = false
  let quote: '"' | "'" | null = null
  const endWord = () => {
    if (inWord) words.push(word)
    word = ''
    inWord = false
  }
  const endSegment = () => {
    endWord()
    if (words.length) segments.push(words)
    words = []
  }
  for (let i = 0; i < command.length; i++) {
    const c = command[i]
    if (quote) {
      if (c === quote) quote = null
      else word += c
    } else if (c === '"' || c === "'") {
      quote = c
      inWord = true
    } else if (c === ';' || c === '|' || c === '&' || c === '\n') {
      endSegment()
    } else if (c === ' ' || c === '\t') {
      endWord()
    } else {
      word += c
      inWord = true
    }
  }
  endSegment()
  return segments
}

const ENV_ASSIGNMENT = /^[A-Za-z_]\w*=/
const GIT_OPTIONS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace'])
const NODE_PM_OPTIONS_WITH_VALUE = new Set(['--dir', '--filter', '-C', '-F', '--prefix', '--cwd'])
const WORD = /^[a-z][a-z-]*$/
const PYTHON = /^python[\d.]*$/
const PACKAGE_SUBS = new Set(['install', 'i', 'add', 'ci', 'remove', 'update', 'sync'])

function gitSub(args: string[]): string | null {
  let i = 0
  while (i < args.length && args[i].startsWith('-')) i += GIT_OPTIONS_WITH_VALUE.has(args[i]) ? 2 : 1
  const sub = args[i]
  if (!sub || !WORD.test(sub)) return null
  return sub === 'checkout' && args.slice(i + 1).includes('-b') ? 'checkout -b' : sub
}

function ghSub(args: string[]): string | null {
  const [area, action] = args.filter(a => !a.startsWith('-'))
  if (!area || !WORD.test(area)) return null
  return action && WORD.test(action) ? `${area} ${action}` : area
}

/** Non-flag words of `args`, skipping the value of the flags in `withValue`. */
function positionals(args: string[], withValue: ReadonlySet<string> = new Set()): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('-')) {
      if (withValue.has(args[i])) i++
    } else out.push(args[i])
  }
  return out
}

type Recognised = { kind: 'git' | 'gh'; sub: string } | { kind: ToolingKind; label: string }

function recognise(words: string[]): Recognised | null {
  let i = 0
  while (i < words.length && ENV_ASSIGNMENT.test(words[i])) i++
  let tool = words[i]
  let args = words.slice(i + 1)
  if (!tool) return null
  if ((tool === 'npx' || tool === 'bunx') && args.length) [tool, ...args] = args
  if ((tool === 'uv' || tool === 'poetry' || tool === 'pipenv') && args[0] === 'run' && args.length > 1) [tool, ...args] = args.slice(1)

  if (tool === 'git') {
    const sub = gitSub(args)
    return sub ? { kind: 'git', sub } : null
  }
  if (tool === 'gh') {
    const sub = ghSub(args)
    return sub ? { kind: 'gh', sub } : null
  }
  if (PYTHON.test(tool)) {
    const m = args.indexOf('-m')
    if (m >= 0 && args[m + 1]) {
      const mod = args[m + 1]
      return { kind: mod === 'pytest' || mod === 'unittest' ? 'test' : 'python', label: `python -m ${mod}` }
    }
    const script = args.includes('-c') ? undefined : args.find(a => !a.startsWith('-'))
    return { kind: 'python', label: script && script.endsWith('.py') ? `python ${script}` : 'python' }
  }
  if (tool === 'pytest' || tool === 'vitest' || tool === 'jest') return { kind: 'test', label: tool }
  if (tool === 'node') return args.includes('--test') ? { kind: 'test', label: 'node --test' } : null
  if (tool === 'npm' || tool === 'pnpm' || tool === 'yarn' || tool === 'bun') {
    const [sub, next] = positionals(args, NODE_PM_OPTIONS_WITH_VALUE)
    if (sub === 'test' || sub === 't') return { kind: 'test', label: `${tool} test` }
    if (sub === 'run' && next && /^test(:|$)/.test(next)) return { kind: 'test', label: `${tool} run ${next}` }
    if (sub && PACKAGE_SUBS.has(sub)) return { kind: 'package', label: `${tool} ${sub}` }
    return null
  }
  if (tool === 'cargo' || tool === 'go') {
    return positionals(args)[0] === 'test' ? { kind: 'test', label: `${tool} test` } : null
  }
  if (tool === 'pip' || tool === 'pip3' || tool === 'uv' || tool === 'poetry') {
    const sub = positionals(args)[0]
    return sub && PACKAGE_SUBS.has(sub) ? { kind: 'package', label: `${tool} ${sub}` } : null
  }
  if (tool === 'docker' || tool === 'docker-compose') {
    const [first, second] = positionals(args)
    if (!first) return null
    return { kind: 'docker', label: tool === 'docker' && first === 'compose' && second ? `docker compose ${second}` : `${tool} ${first}` }
  }
  return null
}

function recogniseAll(command: string): Recognised[] {
  return splitShell(command).flatMap(words => recognise(words) ?? [])
}

/** The distinct `git` and `gh` calls a Bash command line runs, in order of appearance. */
export function shellCommands(command: string): ShellCommand[] {
  const found: ShellCommand[] = []
  for (const r of recogniseAll(command)) {
    if (!('sub' in r)) continue
    if (!found.some(f => f.tool === r.kind && f.sub === r.sub)) found.push({ tool: r.kind, sub: r.sub })
  }
  return found
}

/** The distinct Python, test, docker and package-manager calls a Bash command line runs, in order of appearance. */
export function toolingCommands(command: string): ToolingCommand[] {
  const found: ToolingCommand[] = []
  for (const r of recogniseAll(command)) {
    if (!('label' in r)) continue
    if (!found.some(f => f.kind === r.kind && f.label === r.label)) found.push({ kind: r.kind, label: r.label })
  }
  return found
}

export type ToolGlyph =
  | 'read' | 'search' | 'write' | 'edit' | 'shell' | 'git' | 'gh'
  | 'todo' | 'web' | 'ask' | 'task' | 'notebook'
  | 'python' | 'test' | 'docker' | 'package'

const GLYPH_BY_TOOL: Record<string, ToolGlyph> = {
  Read: 'read', Grep: 'search', Glob: 'search', Write: 'write', Edit: 'edit', MultiEdit: 'edit',
  TodoWrite: 'todo', WebSearch: 'web', WebFetch: 'web', AskUserQuestion: 'ask', Task: 'task', Agent: 'task', NotebookEdit: 'notebook',
}

/** Shape drawn on a tool card. Bash takes the shape of the first git / gh / Python / test / docker / package call its command line runs. MCP and unknown tools: none. */
export function toolGlyph(toolName: string, input?: Record<string, unknown>): ToolGlyph | null {
  if (toolName !== 'Bash') return GLYPH_BY_TOOL[toolName] ?? null
  // Drawn every frame: parse a given input object once
  const cached = input && BASH_GLYPHS.get(input)
  if (cached) return cached
  const command = typeof input?.command === 'string' ? input.command : ''
  const glyph = recogniseAll(command)[0]?.kind ?? 'shell'
  if (input) BASH_GLYPHS.set(input, glyph)
  return glyph
}

const BASH_GLYPHS = new WeakMap<object, ToolGlyph>()
