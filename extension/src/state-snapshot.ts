/**
 * Validated state snapshots shared between processes (#71).
 *
 * A producer publishes one JSON file per (kind, owner): written to a temp file, fsynced, then renamed
 * over the final name, so a reader sees either the previous complete file or the new one, never a
 * half-written one. A reader refuses anything that is not exactly the documented envelope (strict keys,
 * bounded size and depth) and computes freshness from the producer's own timestamp.
 *
 * `generation` orders the writes of ONE owner (monotonic, immune to a regressing clock); `owner` lets
 * concurrent producers be told apart. See docs/state-share.md for the decision on multi-window use.
 */
import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import { readTextFileSafe } from './fs-utils'
import { writeFileAtomic } from '../scripts/claude-hooks'
import {
  SNAPSHOT_SCHEMA_VERSION, SNAPSHOT_MAX_BYTES, SNAPSHOT_MAX_DEPTH, SNAPSHOT_MAX_ARRAY_LENGTH,
  SNAPSHOT_MAX_KEYS, SNAPSHOT_STALE_AFTER_MS, SNAPSHOT_FUTURE_TOLERANCE_MS,
} from './constants'

export type SnapshotFreshness = 'fresh' | 'stale'

export interface SnapshotOwner { id: string; pid: number }

export interface Snapshot {
  schema: typeof SNAPSHOT_SCHEMA_VERSION
  kind: string
  owner: SnapshotOwner
  generation: number
  /** Producer wall clock, ms since epoch */
  writtenAt: number
  payload: Record<string, unknown>
}

const KIND_RE = /^[a-z][a-z0-9-]{0,31}$/
const OWNER_ID_RE = /^[A-Za-z0-9_.-]{1,64}$/
const SNAPSHOT_KEYS = ['schema', 'kind', 'owner', 'generation', 'writtenAt', 'payload']

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype
}

/** JSON-only value within the depth / array / key bounds. */
function isBoundedJson(v: unknown, depth: number): boolean {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return true
  if (typeof v === 'number') return Number.isFinite(v)
  if (depth >= SNAPSHOT_MAX_DEPTH) return false
  if (Array.isArray(v)) return v.length <= SNAPSHOT_MAX_ARRAY_LENGTH && v.every(x => isBoundedJson(x, depth + 1))
  if (isPlainObject(v)) {
    const keys = Object.keys(v)
    return keys.length <= SNAPSHOT_MAX_KEYS && keys.every(k => isBoundedJson(v[k], depth + 1))
  }
  return false
}

/** Strict structural validation of a parsed envelope; null when anything is off. Pure. */
export function validateSnapshot(raw: unknown, expectedKind?: string): Snapshot | null {
  if (!isPlainObject(raw)) return null
  const keys = Object.keys(raw)
  if (keys.length !== SNAPSHOT_KEYS.length || !SNAPSHOT_KEYS.every(k => keys.includes(k))) return null
  if (raw.schema !== SNAPSHOT_SCHEMA_VERSION) return null
  if (typeof raw.kind !== 'string' || !KIND_RE.test(raw.kind)) return null
  if (expectedKind !== undefined && raw.kind !== expectedKind) return null
  const owner = raw.owner
  if (!isPlainObject(owner) || Object.keys(owner).length !== 2) return null
  if (typeof owner.id !== 'string' || !OWNER_ID_RE.test(owner.id)) return null
  if (!Number.isSafeInteger(owner.pid) || (owner.pid as number) <= 0) return null
  if (!Number.isSafeInteger(raw.generation) || (raw.generation as number) < 0) return null
  if (!Number.isSafeInteger(raw.writtenAt) || (raw.writtenAt as number) < 0) return null
  if (!isPlainObject(raw.payload) || !isBoundedJson(raw.payload, 0)) return null
  return raw as unknown as Snapshot
}

/**
 * fresh until `staleAfterMs` (inclusive) after the producer's timestamp, stale afterwards.
 * A timestamp in the future is not trusted: it is stale (the reader rejects far-future files outright).
 */
export function deriveSnapshotFreshness(writtenAt: number, now: number, staleAfterMs = SNAPSHOT_STALE_AFTER_MS): SnapshotFreshness {
  const age = now - writtenAt
  return age >= 0 && age <= staleAfterMs ? 'fresh' : 'stale'
}

export type SnapshotReadResult =
  | { ok: true; snapshot: Snapshot; freshness: SnapshotFreshness; ageMs: number }
  | { ok: false; reason: 'missing' | 'too_large' | 'unreadable' | 'corrupt' | 'invalid' | 'future' }

export interface ReadSnapshotOptions {
  now?: number
  staleAfterMs?: number
  expectedKind?: string
  /** Directory the file must really live in (symlinked parents cannot escape) */
  rootDir?: string
}

/** Read and validate one snapshot file. Never throws. */
export function readSnapshotFile(filePath: string, opts: ReadSnapshotOptions = {}): SnapshotReadResult {
  const now = opts.now ?? Date.now()
  let st: fs.Stats
  try { st = fs.lstatSync(filePath) } catch { return { ok: false, reason: 'missing' } }
  if (!st.isFile()) return { ok: false, reason: 'unreadable' }
  if (st.size > SNAPSHOT_MAX_BYTES) return { ok: false, reason: 'too_large' }
  const text = readTextFileSafe(filePath, SNAPSHOT_MAX_BYTES, opts.rootDir)
  if (text === undefined) return { ok: false, reason: 'unreadable' }
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { return { ok: false, reason: 'corrupt' } }
  const snapshot = validateSnapshot(parsed, opts.expectedKind)
  if (!snapshot) return { ok: false, reason: 'invalid' }
  if (snapshot.writtenAt - now > SNAPSHOT_FUTURE_TOLERANCE_MS) return { ok: false, reason: 'future' }
  return {
    ok: true, snapshot,
    freshness: deriveSnapshotFreshness(snapshot.writtenAt, now, opts.staleAfterMs),
    ageMs: Math.max(0, now - snapshot.writtenAt),
  }
}

// Atomic publish (unique temp file, exclusive create, fsync, rename; new files 0600): the single
// implementation shared with the settings.json writers (#217).
export { writeFileAtomic }

/**
 * Among snapshots of one kind, the one to believe. Per owner the highest generation wins (the clock may
 * go backwards, the counter cannot); across owners the most recent `writtenAt` wins, ties broken by the
 * smaller owner id so every reader picks the same one.
 */
export function selectSnapshot(snapshots: readonly Snapshot[]): Snapshot | undefined {
  const perOwner = new Map<string, Snapshot>()
  for (const s of snapshots) {
    const cur = perOwner.get(s.owner.id)
    if (!cur || s.generation > cur.generation) perOwner.set(s.owner.id, s)
  }
  let best: Snapshot | undefined
  for (const s of perOwner.values()) {
    if (!best || s.writtenAt > best.writtenAt || (s.writtenAt === best.writtenAt && s.owner.id < best.owner.id)) best = s
  }
  return best
}

export interface SnapshotWriterOptions {
  dir: string
  kind: string
  ownerId?: string
  now?: () => number
}

/** One producer: owns a file `<kind>.<owner>.json` in `dir` and a monotonic generation counter. */
export class SnapshotWriter {
  readonly owner: SnapshotOwner
  readonly filePath: string
  private generation = 0
  private removed = false
  private readonly kind: string
  private readonly now: () => number

  constructor(opts: SnapshotWriterOptions) {
    if (!KIND_RE.test(opts.kind)) throw new Error(`invalid snapshot kind: ${opts.kind}`)
    const id = opts.ownerId ?? `${process.pid}-${crypto.randomBytes(3).toString('hex')}`
    if (!OWNER_ID_RE.test(id)) throw new Error(`invalid snapshot owner id: ${id}`)
    this.owner = { id, pid: process.pid }
    this.kind = opts.kind
    this.now = opts.now ?? Date.now
    this.filePath = path.join(opts.dir, `${opts.kind}.${id}.json`)
  }

  /** Validate, serialize and publish atomically. Throws (writing nothing) on an invalid or oversized payload. */
  write(payload: Record<string, unknown>): Snapshot {
    if (this.removed) throw new Error('snapshot writer removed')
    const snapshot: Snapshot = {
      schema: SNAPSHOT_SCHEMA_VERSION, kind: this.kind, owner: this.owner,
      generation: this.generation + 1, writtenAt: Math.trunc(this.now()), payload,
    }
    if (!validateSnapshot(snapshot)) throw new Error('snapshot payload is not a bounded JSON object')
    const text = JSON.stringify(snapshot)
    if (Buffer.byteLength(text) > SNAPSHOT_MAX_BYTES) throw new Error('snapshot exceeds the size cap')
    writeFileAtomic(this.filePath, text)
    this.generation++
    return snapshot
  }

  /** Delete the published file; idempotent. No write is possible afterwards. */
  remove(): void {
    if (this.removed) return
    this.removed = true
    try { fs.unlinkSync(this.filePath) } catch { /* already gone */ }
  }
}

/** All valid snapshots of `kind` in `dir` (corrupt / oversized / foreign files are skipped), with freshness. */
export function readSnapshotDir(dir: string, kind: string, opts: Omit<ReadSnapshotOptions, 'expectedKind' | 'rootDir'> = {}) {
  const out: Extract<SnapshotReadResult, { ok: true }>[] = []
  let names: string[]
  try { names = fs.readdirSync(dir) } catch { return out }
  for (const n of names) {
    if (!n.startsWith(`${kind}.`) || !n.endsWith('.json')) continue
    const r = readSnapshotFile(path.join(dir, n), { ...opts, expectedKind: kind, rootDir: dir })
    if (r.ok) out.push(r)
  }
  return out
}
