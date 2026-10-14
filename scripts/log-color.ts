// #402: ANSI colors for the relay's verbose logs. Plain text is never altered.
const RESET = '\x1b[0m'
const TAG_COLORS: Record<string, string> = {
  event: '36', // cyan
  sse: '90', // gray
  session: '32', // green
  scan: '34', // blue
  relay: '35', // magenta
}
const FAILURE = /\b(failed|dropping)\b/i

/** TTY only; NO_COLOR wins over FORCE_COLOR (https://no-color.org). */
export function colorEnabled(env: Record<string, string | undefined>, isTTY: boolean): boolean {
  if (env.NO_COLOR) return false
  if (env.FORCE_COLOR !== undefined) return env.FORCE_COLOR !== '0' && env.FORCE_COLOR !== 'false'
  return isTTY
}

export function colorizeLog(text: string, enabled: boolean): string {
  if (!enabled) return text
  const tag = /^\[([a-z]+)\]/.exec(text)?.[1]
  if (!tag || !(tag in TAG_COLORS)) return text
  const color = FAILURE.test(text) ? '33' : TAG_COLORS[tag]
  return `\x1b[${color}m${text}${RESET}`
}
