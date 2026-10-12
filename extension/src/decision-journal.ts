/**
 * decisions.jsonl (#240): the append-only record of what the operator decided from Agent Lens for a permission
 * request, and how each request ended. Local, owner-only (0600), capped in size, and it holds no tool input:
 * only the SHA-256 of the input, so a line can be matched to a request without keeping its content. Each line also
 * carries the SHA-256 of the line itself (without that field): an edit of a line is detectable, not impossible.
 *
 * No `vscode` import. `append` never throws: it returns false when the line was not written, and the caller then
 * sends no decision (a decision that cannot be recorded is not applied).
 */
import * as fs from 'fs'
import * as path from 'path'
import { createHash } from 'crypto'
import { createLogger } from './logger'

const log = createLogger('DecisionJournal')

export type DecisionAction = 'approve' | 'deny' | 'redirect'
/** sent = the decision was handed to Claude Code (not proof it was applied); the others are requests that got none */
export type DecisionOutcome =
  | 'sent' | 'expired' | 'answered-elsewhere' | 'surface-closed' | 'shutdown'
  | 'rejected-replay' | 'rejected-mismatch'

export interface DecisionRecord {
  ts: string
  sessionId: string
  /** null when the PermissionRequest hook input does not name it (it carries none) and no single open call matches */
  toolUseId: string | null
  tool: string
  decision: DecisionAction | 'none'
  channel: 'vscode'
  /** SHA-256 of the canonical JSON of the tool input */
  inputSha256: string
  outcome: DecisionOutcome
  /** Length of the redirect message, never its text */
  messageChars?: number
}

export class DecisionJournal {
  constructor(private readonly file: string, private readonly maxBytes: number) {}

  append(record: DecisionRecord): boolean {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 })
      this.rotateIfFull()
      const body = JSON.stringify(record)
      const entrySha256 = createHash('sha256').update(body).digest('hex')
      const line = JSON.stringify({ ...record, entrySha256 }) + '\n'
      // O_NOFOLLOW: a symbolic link planted at the journal path is not written through
      const flags = fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW ?? 0)
      const fd = fs.openSync(this.file, flags, 0o600)
      try {
        if (!fs.fstatSync(fd).isFile()) return false
        fs.fchmodSync(fd, 0o600) // the create mode went through the umask; an older file may be looser
        fs.writeSync(fd, line)
      } finally {
        fs.closeSync(fd)
      }
      return true
    } catch (err) {
      log.warn('Could not write the decision journal:', err)
      return false
    }
  }

  /** One older generation is kept: decisions.jsonl.1 replaces the previous .1 */
  private rotateIfFull(): void {
    let st: fs.Stats
    try { st = fs.lstatSync(this.file) } catch { return }
    if (!st.isFile() || st.size < this.maxBytes) return
    fs.renameSync(this.file, `${this.file}.1`)
  }
}
