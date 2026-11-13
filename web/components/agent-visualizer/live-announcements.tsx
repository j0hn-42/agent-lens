import type { AnnouncementItem } from './canvas/a11y-model'

/**
 * The live regions that read agent state changes (#379): calm changes politely; actionable states (failure,
 * permission request) interrupt in their own alert region, never summarised. Shared by the node graph and the
 * Burrow view, so both read the same text at the same announcement level.
 */
export function LiveAnnouncements({ announcements }: { announcements: AnnouncementItem[] }) {
  return (
    <>
      <div role="status" aria-live="polite" aria-atomic="false" className="sr-only">
        {announcements.filter(a => !a.urgent).map(a => <p key={a.id}>{a.text}</p>)}
      </div>
      <div role="alert" aria-atomic="false" className="sr-only" data-testid="graph-urgent-announcer">
        {announcements.filter(a => a.urgent).map(a => <p key={a.id}>{a.text}</p>)}
      </div>
    </>
  )
}
