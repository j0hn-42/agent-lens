'use client'

import { createContext, useContext, type MutableRefObject } from 'react'

export interface TourBridge {
  /** The guided tour wants the graph legend open (the saved preference is left alone) */
  legendOpen: boolean
  /** Filled by the canvas: world point to client coordinates (the tour ring follows agents) */
  canvasToScreenRef: MutableRefObject<((worldX: number, worldY: number) => { x: number; y: number }) | null>
  /** Set when the tour can be started (guided demo, tour not running): the legend shows a "Guided tour" button beside its own */
  startTour?: () => void
}

export const TourBridgeContext = createContext<TourBridge>({ legendOpen: false, canvasToScreenRef: { current: null } })
export const useTourBridge = () => useContext(TourBridgeContext)
