'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { TIMING } from '@/lib/agent-types'

interface GlassCardProps {
  children: ReactNode
  className?: string
  style?: React.CSSProperties
  visible: boolean
  /** The card's own box, for a caller that must measure or scroll it (the agent card's scroll container). */
  ref?: React.Ref<HTMLDivElement>
}

export function GlassCard({ children, className = '', style, visible, ref }: GlassCardProps) {
  const [mounted, setMounted] = useState(visible)
  const [animating, setAnimating] = useState(false)

  useEffect(() => {
    if (visible) {
      setMounted(true)
      requestAnimationFrame(() => setAnimating(true))
    } else {
      setAnimating(false)
      const timer = setTimeout(() => setMounted(false), TIMING.glassAnimMs)
      return () => clearTimeout(timer)
    }
  }, [visible])

  if (!mounted) return null

  return (
    <div
      ref={ref}
      className={`glass-card motion-reduce:transition-none! ${className}`}
      style={{
        ...style,
        opacity: animating ? 1 : 0,
        transform: animating ? 'scale(1)' : 'scale(0.95)',
        transition: 'opacity 0.2s ease-out, transform 0.2s ease-out',
      }}
    >
      {children}
    </div>
  )
}
