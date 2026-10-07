// Single SVG icon set for feed, transcript and tool content (all decorative: aria-hidden).

interface IconProps { size?: number; className?: string }

function Svg({ size = 12, className, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`inline-block shrink-0 ${className ?? ''}`}
    >
      {children}
    </svg>
  )
}

export type ChevronDirection = 'up' | 'down' | 'left' | 'right'

const CHEVRON_PATH: Record<ChevronDirection, string> = {
  down: 'M3 6l5 5 5-5',
  up: 'M3 10l5-5 5 5',
  left: 'M10 3L5 8l5 5',
  right: 'M6 3l5 5-5 5',
}

export function ChevronIcon({ direction = 'down', ...p }: IconProps & { direction?: ChevronDirection }) {
  return <Svg {...p}><path d={CHEVRON_PATH[direction]} /></Svg>
}

export function ArrowDownIcon(p: IconProps) {
  return <Svg {...p}><path d="M8 2v11M3 8.5l5 5 5-5" /></Svg>
}

export function SearchIcon(p: IconProps) {
  return <Svg {...p}><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5L14 14" /></Svg>
}

export function GlobeIcon(p: IconProps) {
  return <Svg {...p}><circle cx="8" cy="8" r="6" /><path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12" /></Svg>
}

export function CheckIcon(p: IconProps) {
  return <Svg {...p}><path d="M3 8.5l3.5 3.5L13 4.5" /></Svg>
}

export function GearIcon(p: IconProps) {
  return <Svg {...p}><circle cx="8" cy="8" r="2.2" /><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" /></Svg>
}
