import { COLORS } from '@/lib/colors'
import { FOCUS_RING } from '@/lib/chrome-utils'
import { DOCS_READING_THE_UI_URL } from '@/lib/docs-links'

/** Link to the "Reading the UI" guide: what Observed / Not observed, at least, estimated and unattributed mean (#129). */
/** `palette`: pass SCENE when the link sits directly on the scene ground (it then keeps the scene text colour in every theme). */
export function LearnMoreLink({ className = '', palette = COLORS }: { className?: string; palette?: Readonly<Record<'textPrimary', string>> }) {
  return (
    <a
      href={DOCS_READING_THE_UI_URL}
      target="_blank"
      rel="noopener noreferrer"
      className={`inline-flex min-h-6 items-center underline ${FOCUS_RING} ${className}`}
      style={{ color: palette.textPrimary }}
    >
      Learn more<span className="sr-only"> about reading this view (opens in a new tab)</span>
    </a>
  )
}
