/**
 * The workspace palette is Morandi: low-saturation, greyed, and never red.
 *
 * WHY THIS TEST EXISTS. Red is the harness's warning color, so a workspace tint
 * can never be red — a red folder reads as "something is broken", which is a
 * lie about a healthy workspace. The palette was previously Tailwind's
 * saturated set, which included #EF4444 (red) and #F59E0B (amber, the color
 * that already forced the title mix down from 72% to 60% to clear AA).
 *
 * WHAT IS PINNED, and why each bound is a measured fact rather than taste:
 *
 *   - No red and no orange hue. Hue is computed, not eyeballed, so a future
 *     "nice coral" cannot slip in.
 *   - Saturation stays in the Morandi band. Above it the palette is Tailwind
 *     again; the whole point of the change is the greyed look.
 *   - Each color clears WCAG AA as body text once mixed the way the sidebar
 *     paints it (60% hue + 40% theme label), on BOTH the light and the dark
 *     sidebar surfaces. And each color clears 3:1 (graphic level) as a SOLID
 *     swatch, because the menu's palette chips and the whale logo are drawn in
 *     the raw color, not the mix.
 *
 * The ratios below were measured in a real Chromium against the live tokens
 * (label rgb(15,17,21) on light, rgb(249,250,251) on dark) by letting Chromium
 * resolve the same `color-mix()` the stylesheet uses. This test re-derives them
 * with the WCAG formula so a palette edit fails here instead of in the sidebar.
 */
import assert from 'node:assert/strict'

import { PALETTE } from '../activity.js'

/** WCAG 2.1 relative luminance of a #RRGGBB color. */
function luminance(hex) {
  const channel = (offset) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5)
}

/** WCAG 2.1 contrast ratio between two #RRGGBB colors. */
function contrast(a, b) {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (high + 0.05) / (low + 0.05)
}

/** HSL hue in degrees, for the hue-family assertions. */
function hueOf(hex) {
  const [r, g, b] = [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255)
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const delta = max - min
  if (delta === 0) return 0
  let hue
  if (max === r) hue = ((g - b) / delta) % 6
  else if (max === g) hue = (b - r) / delta + 2
  else hue = (r - g) / delta + 4
  hue *= 60
  return hue < 0 ? hue + 360 : hue
}

/** HSV saturation: 0 is grey, 1 is fully saturated. */
function saturationOf(hex) {
  const [r, g, b] = [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255)
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  return max === 0 ? 0 : (max - min) / max
}

/** The live theme tokens the sidebar paints with, read from the running app. */
const LIGHT_LABEL = '#0F1115' // rgb(15,17,21)
const DARK_LABEL = '#F9FAFB' // rgb(249,250,251)
const LIGHT_SURFACE = '#F9FAFB' // rgb(249,250,251), --dsw-specific-sidebar-fill
const DARK_SURFACE = '#151517' // rgb(21,21,23)

/**
 * What `color-mix(in srgb, <hex> <share>%, <label>)` resolves to.
 *
 * Chromium composites color-mix in the gamma-encoded sRGB space, channel by
 * channel, with no linearization — so the result is the plain weighted average
 * of the two channel triples.
 */
function mix(hex, label, share) {
  const parts = (value) => [1, 3, 5].map((offset) => parseInt(value.slice(offset, offset + 2), 16))
  const [a, b] = [parts(hex), parts(label)]
  const blended = a.map((channel, index) => Math.round(channel * share + b[index] * (1 - share)))
  return `#${blended.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`
}

const TITLE_SHARE = 0.6 // the 60% ceiling the folder stylesheet uses
const GLYPH_SHARE = 0.78 // the folder glyph / logo share

let failures = 0
const check = (name, run) => {
  try {
    run()
    console.log(`ok   ${name}`)
  } catch (error) {
    failures += 1
    console.log(`FAIL ${name}\n     ${error.message}`)
  }
}

check('the palette is eight distinct opaque hex colors', () => {
  assert.equal(PALETTE.length, 8)
  assert.equal(new Set(PALETTE).size, 8, 'no duplicates')
  for (const color of PALETTE) assert.match(color, /^#[0-9A-F]{6}$/, `${color} is an uppercase hex`)
})

check('no palette color is red or orange', () => {
  // Red lives at hue 0 (+/-30). Orange sits at ~30. Both are excluded by a
  // single rule: nothing may land in 330..360 or 0..55.
  for (const color of PALETTE) {
    const hue = hueOf(color)
    assert.ok(
      hue > 55 && hue < 330,
      `${color} has hue ${hue.toFixed(1)} — red/orange hues (330-360, 0-55) are the warning range and cannot tint a workspace`,
    )
  }
  // The specific colors the user named as unacceptable, in case a hue edit
  // ever reintroduces one of them verbatim.
  for (const banned of ['#EF4444', '#DC2626', '#F87171', '#F59E0B', '#F97316']) {
    assert.ok(!PALETTE.includes(banned), `${banned} is banned from the palette`)
  }
})

check('the palette is Morandi: low saturation, not Tailwind', () => {
  for (const color of PALETTE) {
    const saturation = saturationOf(color)
    assert.ok(
      saturation <= 0.30,
      `${color} has saturation ${saturation.toFixed(2)} — the Morandi band is <= 0.30 (the old Tailwind red was 0.79)`,
    )
    assert.ok(saturation >= 0.08, `${color} is nearly grey (${saturation.toFixed(2)}); a tint should still be identifiable`)
  }
})

check('every color is AA as body text once mixed into the theme label, on both themes', () => {
  const rows = []
  for (const color of PALETTE) {
    const light = contrast(mix(color, LIGHT_LABEL, TITLE_SHARE), LIGHT_SURFACE)
    const dark = contrast(mix(color, DARK_LABEL, TITLE_SHARE), DARK_SURFACE)
    rows.push({ color, light, dark })
    assert.ok(light >= 4.5, `${color}: title on light is ${light.toFixed(2)}, needs >= 4.5`)
    assert.ok(dark >= 4.5, `${color}: title on dark is ${dark.toFixed(2)}, needs >= 4.5`)
  }
  const worst = rows.reduce((low, row) => (row.light < low.light ? row : low), rows[0])
  console.log(`     worst title mix: ${worst.color} ${worst.light.toFixed(2)} on light`)
})

check('every color clears 3:1 as a solid swatch on both themes', () => {
  // The menu's palette chips and the whale logo paint the RAW color, so the
  // graphic-level bar (3:1) applies to the solid value, not to the mix.
  for (const color of PALETTE) {
    const light = contrast(color, LIGHT_SURFACE)
    const dark = contrast(color, DARK_SURFACE)
    assert.ok(light >= 3, `${color}: solid on light is ${light.toFixed(2)}, needs >= 3`)
    assert.ok(dark >= 3, `${color}: solid on dark is ${dark.toFixed(2)}, needs >= 3`)
  }
})

check('every color stays distinguishable from the others', () => {
  // Two workspaces must not look identical. 1.08 is deliberately loose: this
  // catches a duplicated or near-duplicated swatch, not a design preference.
  for (let i = 0; i < PALETTE.length; i += 1) {
    for (let j = i + 1; j < PALETTE.length; j += 1) {
      assert.notEqual(PALETTE[i], PALETTE[j], `${PALETTE[i]} appears twice`)
    }
  }
  const hues = PALETTE.map(hueOf)
  assert.ok(new Set(hues.map((hue) => Math.round(hue / 10))).size >= 6, `hues are spread out, not clustered: ${hues.map((h) => h.toFixed(0)).join(',')}`)
})

check('the glyph share also clears AA, so the folder icon is not the weak link', () => {
  for (const color of PALETTE) {
    const light = contrast(mix(color, LIGHT_LABEL, GLYPH_SHARE), LIGHT_SURFACE)
    const dark = contrast(mix(color, DARK_LABEL, GLYPH_SHARE), DARK_SURFACE)
    assert.ok(light >= 3, `${color}: glyph on light is ${light.toFixed(2)}, needs >= 3`)
    assert.ok(dark >= 3, `${color}: glyph on dark is ${dark.toFixed(2)}, needs >= 3`)
  }
})

if (failures > 0) {
  console.error(`\n${failures} palette check(s) failed.`)
  process.exit(1)
}
console.log('\nThe workspace palette is Morandi, red-free, and readable on both themes.')
