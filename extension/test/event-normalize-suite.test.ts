/** The shared behaviour suite of the normalization module, run against the extension copy. */
import * as mod from '../src/event-normalize'
import * as caps from '../src/constants'
import { normalizeSuite, type NormalizeApi } from './helpers/normalize-suite'

normalizeSuite('extension', {
  ...(mod as unknown as NormalizeApi),
  caps: Object.fromEntries(Object.entries(caps).filter(([k]) => k.startsWith('NORM_'))) as Record<string, number>,
})
