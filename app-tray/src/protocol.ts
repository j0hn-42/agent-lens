/**
 * JSON line protocol between the tray driver (Node) and the native menu binary (#335).
 * One JSON object per line on stdin/stdout, no socket. The binary only ever sends back an item id:
 * never a command, a path or a URL. Every incoming line is size-capped and strictly validated.
 */
import type { MenuItem, TrayItemId } from './menu-model'

export const PROTOCOL_VERSION = 1

/** A click is ~40 bytes; anything near this cap is not our binary. */
export const MAX_INCOMING_LINE_BYTES = 1024

/** Driver to binary. */
export type DriverMessage =
  | { type: 'menu'; tooltip: string; items: MenuItem[] }
  /** Remove the icon and exit */
  | { type: 'quit' }

/** Binary to driver. */
export type BinaryMessage =
  /** The icon is up (also sent again if the binary restarts its UI): the driver resends the menu */
  | { type: 'ready' }
  | { type: 'click'; id: TrayItemId }
  /** The icon is gone (the user closed it or the system removed it) */
  | { type: 'closed' }

export function encodeMessage(message: DriverMessage): string {
  return `${JSON.stringify({ v: PROTOCOL_VERSION, ...message })}\n`
}

const ITEM_IDS: Readonly<Record<TrayItemId, true>> = { open: true, copyUrl: true, state: true, skipped: true, quit: true }

export type ParseResult = { ok: true; message: BinaryMessage } | { ok: false; reason: string }

const fail = (reason: string): ParseResult => ({ ok: false, reason })

function hasExactKeys(o: object, keys: string[]): boolean {
  const own = Object.keys(o)
  return own.length === keys.length && keys.every(k => Object.hasOwn(o, k))
}

/** Validate one line from the binary. Unknown types, unknown or extra keys and wrong versions are refused. */
export function parseBinaryMessage(line: string): ParseResult {
  if (Buffer.byteLength(line, 'utf8') > MAX_INCOMING_LINE_BYTES) return fail('line too long')
  let raw: unknown
  try { raw = JSON.parse(line) } catch { return fail('invalid JSON') }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return fail('not an object')
  const o = raw as Record<string, unknown>
  if (o.v !== PROTOCOL_VERSION) return fail('unsupported version')
  if (o.type === 'ready' || o.type === 'closed') {
    return hasExactKeys(o, ['v', 'type']) ? { ok: true, message: { type: o.type } } : fail('unexpected key')
  }
  if (o.type === 'click') {
    if (!hasExactKeys(o, ['v', 'type', 'id'])) return fail('unexpected key')
    if (typeof o.id !== 'string' || !Object.hasOwn(ITEM_IDS, o.id)) return fail('unknown item id')
    return { ok: true, message: { type: 'click', id: o.id as TrayItemId } }
  }
  return fail('unknown type')
}

export type LineEvent = { line: string } | { overflow: true }

export interface LineSplitter {
  push(chunk: Buffer): void
  bufferedBytes(): number
}

/**
 * Split a byte stream into lines of at most `maxBytes`. A longer line is reported once as an overflow,
 * dropped up to the next newline, and never buffered: memory stays bounded whatever the peer sends.
 */
export function createLineSplitter(maxBytes: number, onEvent: (event: LineEvent) => void): LineSplitter {
  let parts: Buffer[] = []
  let size = 0
  let discarding = false
  const reset = () => { parts = []; size = 0 }
  return {
    bufferedBytes: () => size,
    push(input: Buffer) {
      let chunk = input
      while (chunk.length > 0) {
        const nl = chunk.indexOf(10)
        if (discarding) {
          if (nl < 0) return
          discarding = false
          chunk = chunk.subarray(nl + 1)
          continue
        }
        const piece = nl < 0 ? chunk : chunk.subarray(0, nl)
        if (size + piece.length > maxBytes) {
          reset()
          onEvent({ overflow: true })
          if (nl < 0) { discarding = true; return }
          chunk = chunk.subarray(nl + 1)
          continue
        }
        parts.push(piece)
        size += piece.length
        if (nl < 0) return
        const text = Buffer.concat(parts).toString('utf8').replace(/\r$/, '')
        reset()
        onEvent({ line: text })
        chunk = chunk.subarray(nl + 1)
      }
    },
  }
}
