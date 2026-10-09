/**
 * Safe read-modify-write of Claude Code's settings.json (vscode-free).
 * The file belongs to the user: if it cannot be parsed we refuse to touch it (starting from {}
 * would wipe permissions, env, model and other hooks). Writes are atomic (tmp + rename) and the
 * original is kept once as settings.json.bak before the first modification.
 * scripts/setup.js mirrors this behaviour for the standalone installer.
 */
import * as fs from 'fs'
import * as path from 'path'
import { SETTINGS_FILE_MAX_BYTES } from './constants'

export class SettingsUnreadableError extends Error {
  constructor(readonly filePath: string, readonly reason: string) {
    super(`Cannot read ${filePath} (${reason}). Agent Lens will not modify it: fix or remove the file, then retry.`)
    this.name = 'SettingsUnreadableError'
  }
}

/** Parsed settings object, or null when the file does not exist. Throws SettingsUnreadableError otherwise. */
export function readSettingsStrict(filePath: string, maxBytes = SETTINGS_FILE_MAX_BYTES): Record<string, unknown> | null {
  let stat: fs.Stats
  try {
    stat = fs.statSync(filePath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') { return null }
    throw new SettingsUnreadableError(filePath, (err as Error).message)
  }
  if (!stat.isFile()) { throw new SettingsUnreadableError(filePath, 'not a regular file') }
  if (stat.size > maxBytes) { throw new SettingsUnreadableError(filePath, 'file too large') }
  let raw: string
  try {
    raw = fs.readFileSync(filePath, 'utf-8')
  } catch (err) {
    throw new SettingsUnreadableError(filePath, (err as Error).message)
  }
  if (raw.trim() === '') { throw new SettingsUnreadableError(filePath, 'empty file') }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new SettingsUnreadableError(filePath, `invalid JSON: ${(err as Error).message}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SettingsUnreadableError(filePath, 'not a JSON object')
  }
  return parsed as Record<string, unknown>
}

/**
 * Write via a temporary file then rename, so readers never see a truncated settings.json.
 * A symlinked file is written through (the link survives) and the original file mode is kept.
 */
export function writeFileAtomic(filePath: string, content: string): void {
  let target = filePath
  let mode: number | undefined
  try {
    target = fs.realpathSync(filePath)
    mode = fs.statSync(target).mode & 0o777
  } catch { /* new file: default mode */ }
  const tmpPath = `${target}.${process.pid}.tmp`
  try {
    fs.writeFileSync(tmpPath, content, mode === undefined ? undefined : { mode })
    if (mode !== undefined) { fs.chmodSync(tmpPath, mode) }
    fs.renameSync(tmpPath, target)
  } catch (err) {
    try { fs.unlinkSync(tmpPath) } catch { /* nothing to clean */ }
    throw err
  }
}

/**
 * Apply `mutate` to the settings at `filePath` and write the result atomically.
 * Throws SettingsUnreadableError (file untouched) when the existing file is unusable.
 * Returns false (and writes nothing) when `mutate` changed nothing.
 */
export function updateSettings(filePath: string, mutate: (settings: Record<string, unknown>) => void): boolean {
  const existing = readSettingsStrict(filePath)
  const settings = existing ?? {}
  const before = JSON.stringify(settings)
  mutate(settings)
  if (existing && JSON.stringify(settings) === before) { return false }

  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  if (existing) {
    const backupPath = `${filePath}.bak`
    // Keep the very first original: a later run must not replace it with an already-modified copy.
    if (!fs.existsSync(backupPath)) { fs.copyFileSync(filePath, backupPath) }
  }
  writeFileAtomic(filePath, JSON.stringify(settings, null, 2) + '\n')
  return true
}
