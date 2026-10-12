/**
 * Context compactions (#232). A `context_compacted` event carries only what the transcript proves:
 * Claude Code's trigger ('auto' | 'manual') and the context size before the compaction (preTokens).
 * Codex reports neither. The cost of the compaction has no source in any transcript, so it is never
 * shown as a number: the row says "Cost not reported".
 */

export type CompactionTrigger = 'auto' | 'manual'

export interface CompactionInfo {
  trigger?: CompactionTrigger
  /** Context size before the compaction, as reported by the runtime */
  preTokens?: number
}

/** Label of the Conversation row */
export const COMPACTION_LABEL = 'COMPACTED'

/** The provable fields of a payload: a known trigger, a positive whole size. Anything else is absent. */
export function readCompaction(payload: Record<string, unknown>): CompactionInfo {
  const trigger = payload.trigger === 'auto' || payload.trigger === 'manual' ? payload.trigger : undefined
  const pre = payload.preTokens
  const preTokens = typeof pre === 'number' && Number.isSafeInteger(pre) && pre > 0 ? pre : undefined
  return { ...(trigger ? { trigger } : {}), ...(preTokens !== undefined ? { preTokens } : {}) }
}

const TRIGGER_TEXT: Record<CompactionTrigger, string> = { auto: 'automatic', manual: 'manual, /compact' }

/** The sentence of the row: it names what is not reported instead of leaving it out. */
export function compactionText(c: CompactionInfo): string {
  const trigger = c.trigger ? TRIGGER_TEXT[c.trigger] : 'trigger not reported'
  const size = c.preTokens !== undefined
    ? `Size before: ${c.preTokens.toLocaleString('en-US')} tokens, reported by the runtime.`
    : 'Size before not reported.'
  return `Context compacted (${trigger}). ${size} Cost not reported.`
}
