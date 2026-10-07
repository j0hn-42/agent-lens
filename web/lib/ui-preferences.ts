/**
 * Persisted UI preferences (#32): versioned schema, validation/migration and a small external store.
 *
 * Pure (no React, no direct `window` access) so it can be unit-tested with node:test.
 *
 * Not stored here on purpose:
 * - mute / hide-inactive / single-key shortcuts / show-finished-sessions already persist under their own
 *   keys (use-audio-effects, inactive-agents, shortcuts, SHOW_FINISHED_STORAGE_KEY in
 *   hooks/simulation/session-visibility.ts): reuse those, never duplicate them;
 * - playback speed: it is locked outside review mode, restoring it would be a trap.
 *
 * Trust model: whatever sits in localStorage may be hand-edited, written by an older/newer build or
 * corrupted. Nothing is trusted: unknown keys are dropped, every value is checked against the schema
 * of its key (booleans must be booleans, numbers finite and clamped, strings bounded), and parsing
 * never throws.
 */

/** localStorage key of the preference blob */
export const UI_PREFS_STORAGE_KEY = 'agent-lens:ui-prefs'
/** Current schema version of the stored blob */
export const UI_PREFS_VERSION = 1

export const DOCK_RIGHT_WIDTH_MIN = 280
export const DOCK_RIGHT_WIDTH_MAX = 720
export const DOCK_RIGHT_WIDTH_DEFAULT = 380
/** Upper bound on the length of a stored session id */
export const SESSION_ID_MAX_LENGTH = 256

export interface UiPrefs {
  showHexGrid: boolean
  showStats: boolean
  showTimeline: boolean
  showFiles: boolean
  showConversation: boolean
  showCostOverlay: boolean
  /** Last selected session tab, restored with restoreSelectedSessionId (null = none) */
  lastSelectedSessionId: string | null
  /** Width in px of the right dock column */
  dockRightWidth: number
}

export type UiPrefKey = keyof UiPrefs

export const DEFAULT_UI_PREFS: Readonly<UiPrefs> = Object.freeze({
  showHexGrid: true,
  showStats: false,
  showTimeline: false,
  showFiles: false,
  showConversation: false,
  showCostOverlay: false,
  lastSelectedSessionId: null,
  dockRightWidth: DOCK_RIGHT_WIDTH_DEFAULT,
})

/** Every persisted key (own, fixed list: never derived from stored data) */
export const UI_PREF_KEYS = Object.freeze(Object.keys(DEFAULT_UI_PREFS) as UiPrefKey[])

/** Validate one value for one key; returns the sanitized value or the default when malformed */
export function sanitizePref<K extends UiPrefKey>(key: K, value: unknown): UiPrefs[K] {
  const fallback = DEFAULT_UI_PREFS[key]
  switch (key) {
    case 'lastSelectedSessionId': {
      const ok = typeof value === 'string' && value.length > 0 && value.length <= SESSION_ID_MAX_LENGTH
      return (ok ? value : null) as UiPrefs[K]
    }
    case 'dockRightWidth': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return fallback as UiPrefs[K]
      const clamped = Math.min(DOCK_RIGHT_WIDTH_MAX, Math.max(DOCK_RIGHT_WIDTH_MIN, Math.round(value)))
      return clamped as UiPrefs[K]
    }
    default:
      return (typeof value === 'boolean' ? value : fallback) as UiPrefs[K]
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Turn any decoded JSON value into valid preferences. Accepts the current envelope
 * `{ v: 1, prefs: {...} }` and the unversioned flat object `{ showHexGrid: false, ... }` (v0).
 * A newer version (v > UI_PREFS_VERSION) is ignored entirely: its meaning is unknown.
 */
export function sanitizePrefs(raw: unknown): UiPrefs {
  const out: UiPrefs = { ...DEFAULT_UI_PREFS }
  if (!isPlainObject(raw)) return out
  let source: Record<string, unknown> = raw
  if (Object.prototype.hasOwnProperty.call(raw, 'v')) {
    const v = raw.v
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > UI_PREFS_VERSION) return out
    const inner = Object.prototype.hasOwnProperty.call(raw, 'prefs') ? raw.prefs : undefined
    if (!isPlainObject(inner)) return out
    source = inner
  }
  const target = out as unknown as Record<string, unknown>
  for (const key of UI_PREF_KEYS) {
    // Own properties only: `__proto__`/`constructor` payloads never reach the result
    if (Object.prototype.hasOwnProperty.call(source, key)) target[key] = sanitizePref(key, source[key])
  }
  return out
}

/** Parse the stored text; never throws, returns defaults for null/garbage */
export function parsePrefs(text: string | null | undefined): UiPrefs {
  if (typeof text !== 'string' || text.length === 0 || text.length > 100_000) return { ...DEFAULT_UI_PREFS }
  try {
    return sanitizePrefs(JSON.parse(text))
  } catch {
    return { ...DEFAULT_UI_PREFS }
  }
}

export function serializePrefs(prefs: UiPrefs): string {
  return JSON.stringify({ v: UI_PREFS_VERSION, prefs: sanitizePrefs(prefs) })
}

export function prefsEqual(a: UiPrefs, b: UiPrefs): boolean {
  return UI_PREF_KEYS.every(k => a[k] === b[k])
}

/**
 * The remembered session tab is restored only when that session is still listed and not completed
 * (a finished session would open an empty, hidden tab). Anything else yields null (= default tab).
 */
export function restoreSelectedSessionId(
  stored: string | null | undefined,
  sessions: ReadonlyArray<{ id: string; status: 'active' | 'completed' }>,
): string | null {
  if (typeof stored !== 'string' || stored.length === 0) return null
  const found = sessions.find(s => s.id === stored)
  return found && found.status !== 'completed' ? found.id : null
}

// --- storage with in-memory fallback -----------------------------------------------------------

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/**
 * Wrap a storage getter: every access is try/catch'ed (private mode, blocked cookies, quota). When the
 * backing storage fails, values are kept in memory so the session still behaves consistently.
 */
export function createSafeStorage(getStorage: () => StorageLike | null | undefined): StorageLike {
  const memory = new Map<string, string>()
  return {
    getItem(key) {
      try {
        const s = getStorage()
        if (s) {
          const v = s.getItem(key)
          if (v !== null && v !== undefined) return v
        }
      } catch { /* fall through to memory */ }
      return memory.get(key) ?? null
    },
    setItem(key, value) {
      memory.set(key, value)
      try { getStorage()?.setItem(key, value) } catch { /* memory copy remains */ }
    },
    removeItem(key) {
      memory.delete(key)
      try { getStorage()?.removeItem(key) } catch { /* ignore */ }
    },
  }
}

// --- external store ----------------------------------------------------------------------------

export interface PrefsStoreOptions {
  storage: StorageLike
  /** Run `fn` once, later (a frame). Returns a cancel function. Default: setTimeout(0). */
  schedule?: (fn: () => void) => () => void
  key?: string
}

export interface PrefsStore {
  /** Stable reference until a pref actually changes (useSyncExternalStore contract) */
  getSnapshot(): UiPrefs
  subscribe(listener: () => void): () => void
  set<K extends UiPrefKey>(key: K, value: unknown): void
  reset(): void
  /** Write now if a write is pending */
  flush(): void
  /** Another tab wrote the key (`storage` event): adopt its value without writing back */
  applyExternal(newValue: string | null): void
  hasPendingWrite(): boolean
}

export function createPrefsStore(opts: PrefsStoreOptions): PrefsStore {
  const key = opts.key ?? UI_PREFS_STORAGE_KEY
  const schedule = opts.schedule ?? ((fn: () => void) => { const h = setTimeout(fn, 0); return () => clearTimeout(h) })
  const listeners = new Set<() => void>()
  let prefs: UiPrefs | null = null
  let cancelPending: (() => void) | null = null
  let removeOnFlush = false

  const current = (): UiPrefs => {
    if (!prefs) prefs = parsePrefs(opts.storage.getItem(key))
    return prefs
  }
  const emit = () => { for (const l of Array.from(listeners)) l() }
  const replace = (next: UiPrefs) => {
    if (prefsEqual(current(), next)) return false
    prefs = next
    emit()
    return true
  }
  const queueWrite = () => {
    if (cancelPending) return
    cancelPending = schedule(() => { cancelPending = null; flush() })
  }
  function flush() {
    if (cancelPending) { cancelPending(); cancelPending = null }
    if (removeOnFlush) { removeOnFlush = false; opts.storage.removeItem(key); return }
    if (prefs) opts.storage.setItem(key, serializePrefs(prefs))
  }

  return {
    getSnapshot: current,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set(k, value) {
      if (!UI_PREF_KEYS.includes(k)) return
      const next = { ...current(), [k]: sanitizePref(k, value) }
      if (replace(next)) { removeOnFlush = false; queueWrite() }
    },
    reset() {
      if (replace({ ...DEFAULT_UI_PREFS })) { removeOnFlush = true; queueWrite() }
    },
    flush() { if (cancelPending) flush() },
    applyExternal(newValue) {
      // The other tab's state wins: drop our not-yet-written change instead of overwriting it
      if (cancelPending) { cancelPending(); cancelPending = null }
      removeOnFlush = false
      replace(parsePrefs(newValue))
    },
    hasPendingWrite: () => cancelPending !== null,
  }
}
