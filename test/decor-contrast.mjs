/**
 * Sidebar and transcript decoration, measured rather than eyeballed.
 *
 * WHY THIS TEST EXISTS. The feature was reported as "the bubble color is back
 * to the default pale blue, the tag is gone, the shark logo is there but not
 * colored". A live check found the tag and the logo painted correctly — and the
 * BUBBLE tinted by 14%, which on the Host's `#edf3fe` bubble resolves to
 * `#dce3e8`: a two-point shift the eye reads as no color at all. "Ran" and
 * "visible" are different facts, and only the second one is the deliverable.
 *
 * What is pinned here:
 *
 *   1. The bubble tint is perceptible: the resolved fill differs from the
 *      Host's own bubble by enough that the two do not read as the same color.
 *   2. The whale logo clears the WCAG 3:1 graphic floor on BOTH the light and
 *      the dark sidebar, and stays recognisably the workspace hue (it is never
 *      replaced by plain white or plain black to buy contrast).
 *   3. The folder title clears 4.5:1 as body text on both surfaces.
 *
 * Run: node test/decor-contrast.mjs
 */

import assert from 'node:assert/strict'

import { PALETTE } from '../activity.js'

// --- load the browser half ------------------------------------------------

let definition
globalThis.window = {
  __ModuleLoader__: {
    load: (next) => {
      definition = next
    },
  },
}
await import('../client.js')
const React = {
  createElement: (type, props, ...children) => ({ type, props, children: children.flat() }),
  useState: (initial) => [initial, () => {}],
  useRef: (initial) => ({ current: initial }),
  useEffect: () => {},
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
}
const client = definition.factory(() => React)
delete globalThis.window

// --- fixtures -------------------------------------------------------------

/** The Host's own user-bubble background, light and dark, read off the live page. */
const BUBBLE = { light: '#EDF3FE', dark: '#2C2C2E' }
/** The sidebar surface, light and dark, read off the live page. */
const SIDEBAR = { light: '#F9FAFB', dark: '#1B1B1C' }
/** The theme's label color, light and dark. */
const LABEL = { light: '#0F1115', dark: '#ADB2B8' }

/**
 * The color a `color-mix(in srgb, hue X%, base)` resolves to.
 *
 * The same arithmetic Chromium performs, so a test number and a live number can
 * be compared directly.
 */
function mix(hue, base, percent) {
  const parse = (hex, offset) => Number.parseInt(hex.slice(offset, offset + 2), 16)
  const channel = (offset) => {
    const value = Math.round(parse(hue, offset) * (percent / 100) + parse(base, offset) * (1 - percent / 100))
    return Math.max(0, Math.min(255, value))
  }
  return `#${[1, 3, 5].map((offset) => channel(offset).toString(16).padStart(2, '0')).join('')}`.toUpperCase()
}

/** Perceptual distance between two #RRGGBB colors, in CIE76 ΔE (approximate). */
function deltaE(a, b) {
  const lab = (hex) => {
    const channel = (offset) => {
      const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
    }
    const [r, g, bl] = [channel(1), channel(3), channel(5)]
    const x = (r * 0.4124 + g * 0.3576 + bl * 0.1805) / 0.95047
    const y = r * 0.2126 + g * 0.7152 + bl * 0.0722
    const z = (r * 0.0193 + g * 0.1192 + bl * 0.9505) / 1.08883
    const f = (value) => (value > 0.008856 ? Math.cbrt(value) : 7.787 * value + 16 / 116)
    return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))]
  }
  const [l1, a1, b1] = lab(a)
  const [l2, a2, b2] = lab(b)
  return Math.sqrt((l1 - l2) ** 2 + (a1 - a2) ** 2 + (b1 - b2) ** 2)
}

// --- 1. the bubble tint is perceptible ------------------------------------

{
  assert.equal(typeof client.turnBubblePaint, 'function')
  // ΔE 3 is the commonly used "a naive observer can see it side by side" floor;
  // the old flat 14% measured well under it on the pale default bubble.
  const floor = 3
  const rows = []
  for (const scheme of ['light', 'dark']) {
    for (const color of PALETTE) {
      const paint = client.turnBubblePaint(color, { bubble: BUBBLE[scheme], surface: SIDEBAR[scheme] })
      const painted = mix(color, BUBBLE[scheme], paint.tint)
      const distance = deltaE(painted, BUBBLE[scheme])
      rows.push({ scheme, color, tint: paint.tint, painted, distance: Number(distance.toFixed(2)) })
    }
  }
  const invisible = rows.filter((row) => row.distance < floor)
  assert.deepEqual(invisible, [],
    `every workspace tint must be visible against the Host's bubble (ΔE >= ${floor}):\n${JSON.stringify(invisible, null, 2)}`)
  // A single number for the report.
  const worst = rows.reduce((low, row) => (row.distance < low.distance ? row : low))
  console.log(`ok 1 — every palette hue tints its bubble perceptibly (worst ΔE ${worst.distance} for ${worst.color} on ${worst.scheme}; tint ${worst.tint}%)`)
  // The old rule, measured for the record. It was NOT invisible in ΔE terms —
  // it was TOO WEAK: ΔE 6.6 on the pale default bubble, less than half of what
  // the new rule produces, and the Host's blue still dominated the hue, which
  // is how a tinted bubble was reported as "the default pale blue again".
  const oldDistance = deltaE(mix('#748162', BUBBLE.light, 14), BUBBLE.light)
  assert.ok(oldDistance < worst.distance / 1.5, `the new tint must be substantially stronger than the old flat 14% (old ΔE ${oldDistance.toFixed(2)})`)
  console.log(`     the previous flat 14% measured ΔE ${oldDistance.toFixed(2)} versus ${worst.distance} at its weakest — it was too weak, not absent`)
}

// --- 2. the whale logo clears the graphic floor on both themes ------------

{
  assert.equal(typeof client.whaleLogoPaint, 'function')
  const results = []
  for (const scheme of ['light', 'dark']) {
    for (const color of PALETTE) {
      const paint = client.whaleLogoPaint(color, SIDEBAR[scheme], LABEL[scheme])
      results.push({ scheme, color, ink: paint.color, ratio: paint.ratio, mixed: paint.mixed })
    }
  }
  const failing = results.filter((row) => !(row.ratio >= 3))
  assert.deepEqual(failing, [], `the logo must clear 3:1 as a graphic on both sidebars:\n${JSON.stringify(failing, null, 2)}`)
  // It must still be a workspace color, not white or black bought for contrast.
  const gray = results.filter((row) => {
    const [r, g, b] = [1, 3, 5].map((offset) => Number.parseInt(row.ink.slice(offset, offset + 2), 16))
    return Math.max(r, g, b) - Math.min(r, g, b) < 8
  })
  assert.deepEqual(gray, [], 'the logo keeps the hue: it is never flattened to grey to buy contrast')
  const tightest = results.reduce((low, row) => (row.ratio < low.ratio ? row : low))
  console.log(`ok 2 — the whale logo clears 3:1 on both sidebars and keeps its hue (tightest ${tightest.ratio}:1 for ${tightest.color} on ${tightest.scheme}${tightest.mixed ? ', mixed toward the label' : ', raw hue'})`)
}

// --- 3. the folder title clears AA as body text --------------------------

{
  const results = []
  for (const scheme of ['light', 'dark']) {
    for (const color of PALETTE) {
      // The stylesheet mixes 60% of the hue into the theme label, and that
      // resolved to `color(srgb 0.633 0.696 0.711)` on the dark sidebar — which
      // is 1.22:1 against `#1B1B1C`, unreadable. The direction of the mix has
      // to follow the surface: toward the label on a light background (the
      // label is dark ink), and toward the label on a dark one (lighter ink).
      // Either way the ink must move AWAY from the surface, which is what
      // `folderTitlePaint` decides.
      const paint = client.folderTitlePaint(color, SIDEBAR[scheme], LABEL[scheme])
      const ratio = client.contrastOf(paint.color, SIDEBAR[scheme])
      results.push({ scheme, color, ratio: Number(ratio.toFixed(2)), paint: paint.color, share: paint.share })
    }
  }
  const failing = results.filter((row) => row.ratio < 4.5)
  assert.deepEqual(failing, [], `the folder title must clear AA 4.5:1 on both sidebars:\n${JSON.stringify(failing, null, 2)}`)
  const tightest = results.reduce((low, row) => (row.ratio < low.ratio ? row : low))
  console.log(`ok 3 — the folder title clears AA 4.5:1 on both sidebars (tightest ${tightest.ratio}:1 for ${tightest.color} on ${tightest.scheme}, mix share ${tightest.share}%)`)
}

console.log('\ndecor-contrast: all checks passed')
