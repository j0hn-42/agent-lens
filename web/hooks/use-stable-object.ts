import { useRef } from 'react'

/** True when both objects have the same keys with `Object.is` equal values. */
export function shallowEqualFields<T extends object>(a: T, b: T): boolean {
  const keys = Object.keys(b) as (keyof T)[]
  return Object.keys(a).length === keys.length && keys.every(k => Object.is(a[k], b[k]))
}

/**
 * The previous object while no field changed (#658): a hook that returns a fresh literal at each render would otherwise
 * invalidate every memo and dependency list that receives it whole.
 */
export function useStableObject<T extends object>(value: T): T {
  const stable = useRef(value)
  if (!shallowEqualFields(stable.current, value)) stable.current = value
  return stable.current
}
