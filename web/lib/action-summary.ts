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
const WORD = /^[a-z][a-z-]*$/

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

/** The distinct `git` and `gh` calls a Bash command line runs, in order of appearance. */
export function shellCommands(command: string): ShellCommand[] {
  const found: ShellCommand[] = []
  for (const words of splitShell(command)) {
    let i = 0
    while (i < words.length && ENV_ASSIGNMENT.test(words[i])) i++
    const tool = words[i]
    if (tool !== 'git' && tool !== 'gh') continue
    const args = words.slice(i + 1)
    const sub = tool === 'git' ? gitSub(args) : ghSub(args)
    if (sub && !found.some(f => f.tool === tool && f.sub === sub)) found.push({ tool, sub })
  }
  return found
}
