/**
 * Copy and export of communications (dispatch prompt, return report, teammate messages). Pure text
 * builders, no React. Only fields the panels already display go in: label, sender, receiver, time and the
 * message content. Nothing is inferred: every cut (hidden tool rows, search filter, dropped older
 * messages, per-message character cap) is stated in the export instead of being left silent.
 * Secrets are masked with the session export's redaction (`secret-redaction.ts`), best effort, and counted.
 */
import { createRedactionCounts, redactText } from '@/lib/secret-redaction'

export interface CommsExportEntry {
  /** 'DISPATCH' | 'RETURN' | 'MESSAGE' | ... */
  label: string
  sender?: string
  receiver?: string
  /** "m:ss" as shown in the panel */
  time: string
  content: string
  isError?: boolean
  /** Characters lost to the display cap, when the content shown is itself cut */
  truncatedChars?: number
}

function fence(text: string): string {
  let ticks = 3
  for (const m of text.matchAll(/`+/g)) ticks = Math.max(ticks, m[0].length + 1)
  const bar = '`'.repeat(ticks)
  return `${bar}text\n${text}\n${bar}`
}

/** One message as Markdown: heading line, then the content in a fence long enough to contain it. */
export function messageToMarkdown(e: CommsExportEntry, level = 3): string {
  const route = e.sender || e.receiver ? ` ${e.sender ?? '?'} -> ${e.receiver ?? '?'}` : ''
  const head = `${'#'.repeat(level)} ${e.label}${e.isError ? ' (error)' : ''}${route} (${e.time})`
  const body = e.content ? fence(e.content) : '(empty message)'
  const cut = e.truncatedChars && e.truncatedChars > 0
    ? `\n\n> Truncated: ${e.truncatedChars} characters were cut before this export.`
    : ''
  return `${head}\n\n${body}${cut}`
}

export interface ConversationExport {
  title: string
  entries: CommsExportEntry[]
  /** Statements about what this export does NOT contain (hidden rows, filter, dropped messages) */
  notes: string[]
}

/** The file text, with secrets masked, and how many were masked (title, notes and every message included). */
export function conversationExport({ title, entries, notes }: ConversationExport): { markdown: string; redactions: number } {
  const parts = [`# ${title}`, `${entries.length} ${entries.length === 1 ? 'message' : 'messages'}`]
  if (notes.length > 0) parts.push(notes.map(n => `> Incomplete: ${n}`).join('\n'))
  for (const e of entries) parts.push(messageToMarkdown(e))
  const counts = createRedactionCounts()
  const markdown = redactText(parts.join('\n\n') + '\n', counts)
  return { markdown, redactions: counts.total }
}

/** Text of a single message for the clipboard: secrets masked like the export, and how many were masked. */
export function redactForCopy(content: string): { text: string; redactions: number } {
  const counts = createRedactionCounts()
  const text = redactText(content, counts)
  return { text, redactions: counts.total }
}

/** Status line after a successful Copy: says how many secrets were masked and what was cut. */
export function copiedMessage(label: string, truncatedChars: number, redactions: number): string {
  const masked = redactions > 0 ? `; ${redactions} ${redactions === 1 ? 'secret' : 'secrets'} redacted (best effort)` : ''
  const cut = truncatedChars > 0 ? ` (truncated: ${truncatedChars} characters were cut)` : ''
  return `${label} copied${masked}${cut}`
}

/** Failure message shared by every export (session replay and Markdown conversation). */
export const EXPORT_FAILED_MESSAGE = 'Export failed: this view cannot save files'

/** Success message of a Markdown conversation export; says how many secrets were masked. */
export function exportSavedMessage(redactions: number): string {
  const masked = redactions > 0 ? `; ${redactions} ${redactions === 1 ? 'secret' : 'secrets'} redacted (best effort)` : ''
  return `Conversation exported as Markdown${masked}`
}

/** Notes to put in an export from the state of the panel it comes from. */
export function exportNotes(opts: { droppedText?: string | null; toolsHidden?: boolean; searchQuery?: string }): string[] {
  const notes: string[] = []
  if (opts.droppedText) notes.push(`${opts.droppedText.replace(/\.+$/, '')}.`)
  if (opts.toolsHidden) notes.push('tool calls and results were hidden in the panel and are not included.')
  if (opts.searchQuery && opts.searchQuery.trim()) notes.push(`only messages matching the search "${opts.searchQuery.trim()}" are included.`)
  return notes
}

/** Safe file name for a download: lowercase ASCII words joined by dashes. */
export function exportFileName(title: string, ext = 'md'): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
  return `${slug || 'conversation'}.${ext}`
}

/** Copy text to the clipboard. Resolves false (never throws) when the browser refuses or has no clipboard. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // fall through to the selection-based fallback
  }
  try {
    if (typeof document === 'undefined') return false
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.setAttribute('aria-hidden', 'true')
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    const active = document.activeElement as HTMLElement | null
    document.body.appendChild(ta)
    ta.select()
    const ok = typeof document.execCommand === 'function' && document.execCommand('copy')
    ta.remove()
    active?.focus?.({ preventScroll: true })
    return !!ok
  } catch {
    return false
  }
}

/** Save text as a file through a temporary link. Returns false when the environment cannot. */
export function downloadText(fileName: string, text: string, mime = 'text/markdown'): boolean {
  try {
    if (typeof document === 'undefined' || typeof Blob === 'undefined' || !URL.createObjectURL) return false
    const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }))
    const a = document.createElement('a')
    a.href = url
    a.download = fileName
    a.style.display = 'none'
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 0)
    return true
  } catch {
    return false
  }
}
