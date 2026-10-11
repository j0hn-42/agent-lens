import { test } from 'node:test'
import assert from 'node:assert/strict'
import { THEME_IDS, extraVars } from '../web/lib/theme-tokens'
import { readFileSync } from 'node:fs'
import { parseAnsi, stripAnsi, sliceAnsiSegments, ansiStyle, ansi256 } from '../web/lib/ansi'

const E = '\x1b'
const texts = (s: string) => parseAnsi(s).map(x => x.text)

test('plain text gives a single unstyled segment', () => {
  assert.deepEqual(parseAnsi('hello\nworld'), [{ text: 'hello\nworld' }])
  assert.deepEqual(parseAnsi(''), [])
})

test('16 colors, bright colors and backgrounds', () => {
  const [a, b, c] = parseAnsi(`${E}[34mℹ${E}[39m ok ${E}[91;102mx${E}[0m`)
  assert.deepEqual(a, { fg: 'var(--ansi-4)', text: 'ℹ' })
  assert.deepEqual(b, { text: ' ok ' })
  assert.deepEqual(c, { fg: 'var(--ansi-9)', bg: 'var(--ansi-10)', text: 'x' })
})

test('256 colors and truecolor', () => {
  assert.equal(parseAnsi(`${E}[38;5;1mx`)[0].fg, 'var(--ansi-1)')
  assert.equal(parseAnsi(`${E}[38;5;196mx`)[0].fg, '#ff0000')
  assert.equal(parseAnsi(`${E}[48;5;244mx`)[0].bg, '#808080')
  assert.equal(parseAnsi(`${E}[38;2;18;52;86mx`)[0].fg, '#123456')
  assert.equal(parseAnsi(`${E}[38;2;300;0;0mx`)[0].fg, '#ff0000')
  assert.equal(ansi256(256), undefined)
  // the parameters after an extended color still apply
  assert.deepEqual(parseAnsi(`${E}[38;5;196;1mx`)[0], { fg: '#ff0000', bold: true, text: 'x' })
})

test('bold, dim, italic, underline, inverse, strike and their resets', () => {
  const [s] = parseAnsi(`${E}[1;2;3;4;7;9mx`)
  assert.deepEqual(s, { bold: true, dim: true, italic: true, underline: true, inverse: true, strike: true, text: 'x' })
  const r = parseAnsi(`${E}[1;2;3;4;7;9mx${E}[22;23;24;27;29my`)
  assert.deepEqual(r[1], { text: 'y' })
  assert.deepEqual(parseAnsi(`${E}[1;31mx${E}[my`)[1], { text: 'y' })
})

test('state carries over line breaks and nested codes combine', () => {
  const segs = parseAnsi(`${E}[31mred\nstill red${E}[1m bold${E}[22m red${E}[0m\nplain`)
  assert.equal(segs.map(s => s.text).join(''), 'red\nstill red bold red\nplain')
  assert.deepEqual(segs[0], { fg: 'var(--ansi-1)', text: 'red\nstill red' })
  assert.deepEqual(segs[1], { fg: 'var(--ansi-1)', bold: true, text: ' bold' })
  assert.deepEqual(segs[2], { fg: 'var(--ansi-1)', text: ' red' })
  assert.deepEqual(segs[3], { text: '\nplain' })
})

test('unknown codes are ignored without breaking known ones', () => {
  assert.deepEqual(parseAnsi(`${E}[999;31;12345mx`)[0], { fg: 'var(--ansi-1)', text: 'x' })
  assert.equal(parseAnsi(`${E}[38;9;1mx`)[0].fg, undefined)
})

test('lost ESC: a bare [34m is removed, the style still applies', () => {
  const segs = parseAnsi('[34mℹ [39mdone')
  assert.deepEqual(segs.map(s => s.text), ['ℹ ', 'done'])
  assert.equal(segs[0].fg, 'var(--ansi-4)')
  assert.equal(stripAnsi('[1m[0m'), '')
  // brackets that are not an SGR code stay
  assert.equal(stripAnsi('arr[3] [x] [12;3H'), 'arr[3] [x] [12;3H')
})

test('other control sequences are stripped with no side effect', () => {
  assert.equal(stripAnsi(`a${E}[2Kb${E}[1;1Hc${E}[?25ld${E}[3Ae`), 'abcde')
  assert.equal(stripAnsi(`a${E}]0;title\x07b${E}]8;;http://x${E}\\c`), 'abc')
  assert.equal(stripAnsi(`a${E}(Bb${E}c${E}`), 'abc')
  assert.deepEqual(texts(`${E}[31m${E}[0m`), [])
})

test('no raw sequence is left in the output', () => {
  const out = stripAnsi(`${E}[31mred${E}[0m ${E}[38;2;1;2;3mz${E}[K${E}[`)
  assert.ok(!out.includes(E))
  assert.equal(out, 'red z')
})

test('sliceAnsiSegments cuts on visible characters', () => {
  const segs = parseAnsi(`${E}[31mabcd${E}[32mefgh`)
  assert.deepEqual(sliceAnsiSegments(segs, 6).map(s => s.text), ['abcd', 'ef'])
  assert.deepEqual(sliceAnsiSegments(segs, 2).map(s => s.text), ['ab'])
  assert.deepEqual(sliceAnsiSegments(segs, 0), [])
})

test('ansiStyle: inverse swaps colors, defaults come from the theme', () => {
  assert.equal(ansiStyle({}), undefined)
  assert.deepEqual(ansiStyle({ fg: 'var(--ansi-1)', inverse: true }), { color: 'var(--ansi-bg)', backgroundColor: 'var(--ansi-1)' })
  assert.deepEqual(ansiStyle({ fg: '#fff', bg: '#000', inverse: true }), { color: '#000', backgroundColor: '#fff' })
  assert.deepEqual(ansiStyle({ bold: true, italic: true, underline: true, strike: true, dim: true }), {
    fontWeight: 700, opacity: 0.8, fontStyle: 'italic', textDecoration: 'underline line-through',
  })
})

// ─── Palette contrast (WCAG 1.4.3) in every theme ───────────────────────────

const css = readFileSync(new URL('../web/app/themes.css', import.meta.url), 'utf8')
function palette(selector: string): Record<string, string> {
  const block = css.split(selector + ' {')[1].split('}')[0]
  return Object.fromEntries([...block.matchAll(/--ansi-([\w-]+):\s*(#[0-9a-f]{6})/g)].map(m => [m[1], m[2]]))
}
const lum = (hex: string) => {
  const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}
const ratio = (a: string, b: string) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}
for (const name of THEME_IDS) {
  const selector = `[data-theme="${name}"]`
  test(`ANSI palette keeps >= 4.5:1 in the ${name} theme, even dimmed`, () => {
    const p = palette(selector)
    for (let i = 0; i < 16; i++) assert.ok(p[String(i)], `--ansi-${i} defined`)
    for (let i = 0; i < 16; i++) {
      const c = p[String(i)]
      assert.ok(ratio(c, p.bg) >= 4.5, `--ansi-${i} ${c} on ${p.bg}: ${ratio(c, p.bg).toFixed(2)}`)
      // dim = opacity .8: blend toward the background
      const mix = '#' + [1, 3, 5].map(k => Math.round(parseInt(c.slice(k, k + 2), 16) * 0.8 + parseInt(p.bg.slice(k, k + 2), 16) * 0.2).toString(16).padStart(2, '0')).join('')
      assert.ok(ratio(mix, p.bg) >= 4.5, `--ansi-${i} dimmed: ${ratio(mix, p.bg).toFixed(2)}`)
    }
    assert.ok(ratio(p.fg, p.bg) >= 7)
  })
}

// #193: backgrounds and 256/truecolor foregrounds are corrected to >= 4.5:1 (ansiStyle receives the theme variables)
for (const name of THEME_IDS) {
  const vars = extraVars(name)
  const resolve = (c: unknown): string => {
    assert.equal(typeof c, 'string', 'color set')
    const m = /^var\((--[\w-]+)\)$/.exec(c as string)
    return m ? vars[m[1]] : (c as string)
  }
  const dimmed = (fg: string, bg: string) => '#' + [1, 3, 5].map(k => Math.round(parseInt(fg.slice(k, k + 2), 16) * 0.8 + parseInt(bg.slice(k, k + 2), 16) * 0.2).toString(16).padStart(2, '0')).join('')
  test(`#193: text on an ANSI background keeps >= 4.5:1 in the ${name} theme`, () => {
    for (let n = 0; n < 16; n++) {
      const code = n < 8 ? 40 + n : 100 + n - 8
      // no explicit fg: the text color is chosen from the background
      const st = ansiStyle(parseAnsi(`${E}[${code}mx`)[0], vars)!
      const bg = resolve(st.backgroundColor), fg = resolve(st.color)
      assert.ok(ratio(fg, bg) >= 4.5, `bg ${n}: ${fg} on ${bg} ${ratio(fg, bg).toFixed(2)}`)
      // named fg + bg combinations, also dimmed
      for (let f = 0; f < 16; f++) {
        const fcode = f < 8 ? 30 + f : 90 + f - 8
        for (const dim of [false, true]) {
          const st2 = ansiStyle(parseAnsi(`${E}[${fcode};${code}${dim ? ';2' : ''}mx`)[0], vars)!
          const b2 = resolve(st2.backgroundColor), f2 = resolve(st2.color)
          const eff = dim ? dimmed(f2, b2) : f2
          assert.ok(ratio(eff, b2) >= 4.5, `fg ${f} on bg ${n}${dim ? ' dim' : ''}: ${eff} on ${b2} ${ratio(eff, b2).toFixed(2)}`)
        }
      }
    }
  })
  test(`#193: dark 256/truecolor foregrounds are lightened on the ${name} background`, () => {
    for (const seq of ['38;5;16', '38;5;232', '38;5;17', '38;2;0;0;0', '38;2;10;10;10']) {
      const st = ansiStyle(parseAnsi(`${E}[${seq}mx`)[0], vars)!
      const fg = resolve(st.color), bg = vars['--ansi-bg']
      assert.ok(ratio(fg, bg) >= 4.5, `${seq}: ${fg} on ${bg} ${ratio(fg, bg).toFixed(2)}`)
    }
  })
  test(`#193: readable colors are kept and the copied text is untouched (${name})`, () => {
    assert.equal(ansiStyle(parseAnsi(`${E}[31mx`)[0], vars)!.color, 'var(--ansi-1)')
    assert.equal(stripAnsi(`${E}[30;42m PASS ${E}[0m ok`), ' PASS  ok')
  })
}
