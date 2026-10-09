export interface TourState { active: boolean; index: number }
export const INACTIVE_TOUR: TourState = { active: false, index: 0 }

export const startTour = (): TourState => ({ active: true, index: 0 })
export const exitTour = (): TourState => INACTIVE_TOUR

export function goToStep(state: TourState, index: number, total: number): TourState {
  if (!state.active || total <= 0) return state
  return { active: true, index: Math.min(Math.max(index, 0), total - 1) }
}
export const nextStep = (state: TourState, total: number): TourState => goToStep(state, state.index + 1, total)
export const prevStep = (state: TourState, total: number): TourState => goToStep(state, state.index - 1, total)
