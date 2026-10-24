/** Real node:sqlite database with the OpenCode tables reduced to the columns the reader uses (#346). */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

type Db = { exec(sql: string): void; close(): void }
type DbCtor = new (p: string) => Db

export function sqliteAvailable(): boolean {
  try { require('node:sqlite'); return true } catch { return false }
}

const handles: Array<{ close(): void }> = []
const dirs: string[] = []

/** Closes `h` at the next cleanupFixtures(), even when a test failed before its own close (#420). */
export function closeLater<T extends { close(): void }>(h: T): T {
  handles.push(h)
  return h
}

/** Closes every handle registered (a handle already closed is fine) and removes the temporary directories. */
export function cleanupFixtures(): void {
  for (const h of handles.splice(0)) { try { h.close() } catch { /* already closed */ } }
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
}

/** A new temporary directory, removed by cleanupFixtures(). */
export function tmpDir(prefix = 'opencode-watch-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

const q = (s: string): string => `'${s.replace(/'/g, "''")}'`

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

/**
 * An id in OpenCode's ascending format (packages/schema/src/identifier.ts, v1.19.0): `<prefix>_`, then
 * 12 hex digits of the low 48 bits of `ms * 0x1000 + counter`, then 14 base62 characters (random in
 * OpenCode, derived from the counter here so that a test is repeatable). Message and part ids are
 * ascending, so they sort by creation time (#420).
 */
export function openCodeId(prefix: 'msg' | 'prt', ms: number, counter: number): string {
  const value = (BigInt(ms) * 0x1000n + BigInt(counter)) & 0xffffffffffffn
  let tail = ''
  let n = counter
  for (let i = 0; i < 14; i++) { tail += BASE62[n % 62]; n = Math.floor(n / 62) }
  return `${prefix}_${value.toString(16).padStart(12, '0')}${tail}`
}

export class OpenCodeFixture {
  private readonly db: Db
  constructor(readonly file: string) {
    const Ctor = (require('node:sqlite') as { DatabaseSync: DbCtor }).DatabaseSync
    this.db = closeLater(new Ctor(file))
    this.db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, title TEXT, agent TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER)')
    this.db.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)')
    this.db.exec('CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)')
  }
  session(id: string, o: { parent?: string; dir?: string | null; title?: string; created: number; updated: number; archived?: number }): void {
    this.db.exec(`INSERT OR REPLACE INTO session VALUES (${q(id)}, ${o.parent ? q(o.parent) : 'NULL'}, ${o.dir === null ? 'NULL' : q(o.dir ?? '/w')}, ${q(o.title ?? 'T')}, 'build', ${o.created}, ${o.updated}, ${o.archived ?? 'NULL'})`)
  }
  message(id: string, sessionId: string, t: number, data: object): void {
    this.db.exec(`INSERT OR REPLACE INTO message VALUES (${q(id)}, ${q(sessionId)}, ${t}, ${t}, ${q(JSON.stringify(data))})`)
  }
  part(id: string, messageId: string, sessionId: string, created: number, updated: number, data: object): void {
    this.db.exec(`INSERT OR REPLACE INTO part VALUES (${q(id)}, ${q(messageId)}, ${q(sessionId)}, ${created}, ${updated}, ${q(JSON.stringify(data))})`)
  }
  /** One raw statement, for rows the helpers above cannot write (NULL or oversized data). */
  raw(sql: string): void { this.db.exec(sql) }
  /** Runs `fn` inside one transaction: thousands of inserts without one fsync each. */
  batch(fn: () => void): void {
    this.db.exec('BEGIN')
    try { fn() } catch (e) { this.db.exec('ROLLBACK'); throw e }
    this.db.exec('COMMIT')
  }
  close(): void { this.db.close() }
}
