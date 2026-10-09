/**
 * Regenerates web/app/themes.css from web/lib/theme-tokens.json (see web/lib/theme-tokens.ts).
 * Run with `pnpm run gen:themes`; scripts/theme-tokens.test.ts fails when the committed file is stale.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { themesCss } from '../web/lib/theme-tokens'

const target = join(__dirname, '..', 'web', 'app', 'themes.css')
writeFileSync(target, themesCss())
console.log(`wrote ${target}`)
