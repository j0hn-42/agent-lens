/**
 * useUiPreferences(): persisted UI toggles (#32), backed by localStorage.
 *
 * - SSR-safe: the server snapshot is always DEFAULT_UI_PREFS, so the first client render equals the
 *   server render; stored values are applied right after hydration (useSyncExternalStore re-renders).
 * - Cross-tab: a `storage` event from another tab updates every subscribed component.
 * - Batched: any number of setPref calls inside one tick/frame produce a single localStorage write;
 *   a pending write is flushed on `pagehide`.
 *
 * Integration (see components/agent-visualizer/index.tsx): the panel flags are read from `prefs` and written with
 * `setPref(key, value)` (a value, not an updater). The remembered session does NOT use a plain persist effect
 * plus a restore effect: that pair is racy (the startup null and the bridge's auto-selection overwrite the
 * stored id before it is read). Use the state machine of lib/ui-preferences.ts (initSessionMemory /
 * stepSessionMemory), seeded from `getPrefs()` and stepped when the session list or the selection changes.
 *
 * Already persisted elsewhere, do NOT add here: mute, hide-inactive, single-key shortcuts,
 * show-finished-sessions (SHOW_FINISHED_STORAGE_KEY). Speed is deliberately not persisted.
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react'
import {
  DEFAULT_UI_PREFS,
  UI_PREFS_STORAGE_KEY,
  createPrefsStore,
  createSafeStorage,
  type PrefsStore,
  type UiPrefKey,
  type UiPrefs,
} from '@/lib/ui-preferences'

function frameScheduler(fn: () => void): () => void {
  if (typeof requestAnimationFrame === 'function') {
    const id = requestAnimationFrame(() => fn())
    return () => cancelAnimationFrame(id)
  }
  const h = setTimeout(fn, 16)
  return () => clearTimeout(h)
}

/** Build a store on the window's localStorage (with in-memory fallback). Exported for tests. */
export function createBrowserPrefsStore(): PrefsStore {
  const storage = createSafeStorage(() => (typeof window === 'undefined' ? null : window.localStorage))
  return createPrefsStore({ storage, schedule: frameScheduler })
}

let defaultStore: PrefsStore | null = null
function getDefaultStore(): PrefsStore {
  if (!defaultStore) defaultStore = createBrowserPrefsStore()
  return defaultStore
}

const getServerSnapshot = (): UiPrefs => DEFAULT_UI_PREFS as UiPrefs

/**
 * Drop the shared store: for tests that mount the app several times in one process. By default what it wrote
 * is erased too; `{ keepStorage: true }` simulates a page reload (new store, same localStorage).
 */
export function resetDefaultUiPreferencesStore(opts: { keepStorage?: boolean } = {}): void {
  defaultStore?.flush()
  defaultStore = null
  if (opts.keepStorage) return
  try { window.localStorage.removeItem(UI_PREFS_STORAGE_KEY) } catch { /* storage unavailable */ }
}

export interface UseUiPreferences {
  prefs: UiPrefs
  /** The latest stored values, read now (not the render snapshot): for decisions taken inside effects */
  getPrefs: () => UiPrefs
  setPref: <K extends UiPrefKey>(key: K, value: UiPrefs[K]) => void
  resetPrefs: () => void
}

/** @param store injection point for tests; production code passes nothing */
export function useUiPreferences(store: PrefsStore = getDefaultStore()): UseUiPreferences {
  const prefs = useSyncExternalStore(store.subscribe, store.getSnapshot, getServerSnapshot)

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      // key === null: storage.clear() in the other tab
      if (e.key !== null && e.key !== UI_PREFS_STORAGE_KEY) return
      store.applyExternal(e.key === null ? null : e.newValue)
    }
    const onHide = () => store.flush()
    window.addEventListener('storage', onStorage)
    window.addEventListener('pagehide', onHide)
    return () => {
      window.removeEventListener('storage', onStorage)
      window.removeEventListener('pagehide', onHide)
    }
  }, [store])

  const setPref = useCallback(
    <K extends UiPrefKey>(key: K, value: UiPrefs[K]) => store.set(key, value),
    [store],
  )
  const resetPrefs = useCallback(() => store.reset(), [store])
  const getPrefs = useCallback(() => store.getSnapshot(), [store])
  return { prefs, getPrefs, setPref, resetPrefs }
}
