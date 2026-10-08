import { useEffect, useState } from 'react'
import { loadIssueLinks, ISSUE_LINKS_CACHE_TTL_MS, type IssueLink } from '@/lib/issue-links'

const CACHE_MAX_ROLES = 32
const cache = new Map<string, { at: number; links: IssueLink[] }>()

/**
 * Issues / PRs labelled `agent:<role>`, from the relay. `origin` null (no relay) or no role: nothing is
 * requested. Failures give an empty list; there is no error state to show (silent degradation).
 */
export function useIssueLinks(origin: string | null | undefined, role: string | undefined): IssueLink[] {
  const [links, setLinks] = useState<IssueLink[]>([])

  useEffect(() => {
    if (origin == null || !role) { setLinks([]); return }
    const key = `${origin}|${role}`
    const hit = cache.get(key)
    if (hit && Date.now() - hit.at < ISSUE_LINKS_CACHE_TTL_MS) { setLinks(hit.links); return }
    setLinks([])
    const ctrl = new AbortController()
    void loadIssueLinks(origin, role, (url, init) => fetch(url, init), ctrl.signal).then(found => {
      if (ctrl.signal.aborted) return
      if (cache.size >= CACHE_MAX_ROLES) {
        const oldest = cache.keys().next().value
        if (oldest !== undefined) cache.delete(oldest)
      }
      cache.set(key, { at: Date.now(), links: found })
      setLinks(found)
    })
    return () => ctrl.abort()
  }, [origin, role])

  return links
}
