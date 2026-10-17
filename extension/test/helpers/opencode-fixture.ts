/** Real node:sqlite database with the OpenCode tables reduced to the columns the reader uses (#346). */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

type Db = { exec(sql: string): void; close(): void }
type DbCtor = new (p: string) => Db

export function sqliteAvailable(): boolean {
  try { require('node:sqlite'); return true } catch { return false }
}

export function tmpDir(prefix = 'opencode-watch-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

const q = (s: string): string => `'${s.replace(/'/g, "''")}'`

export class OpenCodeFixture {
  private readonly db: Db
  constructor(readonly file: string) {
    const Ctor = (require('node:sqlite') as { DatabaseSync: DbCtor }).DatabaseSync
    this.db = new Ctor(file)
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
