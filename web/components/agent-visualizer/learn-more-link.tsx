import { COLORS } from '@/lib/colors'
import { FOCUS_RING } from '@/lib/focus-ring'
import { DOCS_READING_THE_UI_URL } from '@/lib/docs-links'
import { translate, type Locale } from '@/lib/messages'

/** Link to the "Reading the UI" guide: what Observed / Not observed, at least, estimated and unattributed mean (#129). */
/** `palette`: pass SCENE when the link sits directly on the scene ground (it then keeps the scene text colour in every theme). */
/** `locale`: the language of the surface that holds the link (English where the surface is not translated yet, #503). */
export function LearnMoreLink({ className = '', palette = COLORS, locale = 'en' }: { className?: string; palette?: Readonly<Record<'textPrimary', string>>; locale?: Locale }) {
  return (
    <a
      href={DOCS_READING_THE_UI_URL}
      target="_blank"
      rel="noopener noreferrer"
      className={`inline-flex min-h-6 items-center underline ${FOCUS_RING} ${className}`}
      style={{ color: palette.textPrimary }}
    >
      {translate(locale, 'learnMore.text')}<span className="sr-only"> {translate(locale, 'learnMore.sr')}</span>
    </a>
  )
}
