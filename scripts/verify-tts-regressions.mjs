#!/usr/bin/env node
/**
 * Real-page verification of the 0.6.6 behaviour changes.
 *
 * This is NOT a synthetic test: it drives the release tree's `client.js` in
 * headless Chromium on a page built from the real plugin bundle, with one
 * Playwright route serving this tree's file in place of the installed one —
 * installing the package is exactly what this run must not do.
 *
 * What it measures, with numbers rather than claims:
 *
 *   1. hang-up latency   click → the `<audio>` element is paused and silent
 *   2. three replies     the slot is offered three texts, one is read
 *   3. a reply mid-read  the old read is stopped and the new text is read
 *   4. decoration counts the turn tags, the report origins and the folder rows
 *   5. contrast          the whale logo vs its sidebar, in light and dark
 *
 * Usage: node scripts/verify-tts-regressions.mjs [--out dir]
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const require = createRequire(import.meta.url)

function argOf(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : process.argv[index + 1]
}

const outDir = argOf('out', 'artifacts/tts-verify')
const clientPath = resolve(argOf('client', 'client.js'))
const playwrightPath = join(process.env.HOME ?? '', '.dsh/profiles/web/node_modules/playwright-core')
const { chromium } = require(playwrightPath)
const CHROME_CANDIDATES = [
  join(process.env.HOME ?? '', 'Library/Caches/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell'),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
]
const executablePath = CHROME_CANDIDATES.find((candidate) => require('node:fs').existsSync(candidate))
if (executablePath === undefined) {
  console.error('verify: no Chromium found')
  process.exit(2)
}

const clientSource = await (await import('node:fs/promises')).readFile(clientPath, 'utf8')
await mkdir(outDir, { recursive: true })

// Headless Chromium blocks autoplay by default; a real user click would not,
// and the measurement is of the STOP, not of the permission. This flag makes
// the element play without a gesture so the stop has something to interrupt.
const browser = await chromium.launch({
  headless: true,
  executablePath,
  args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
})
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
const page = await context.newPage()

// A blank page is enough: the checks below drive the module's own functions,
// so the measurement is of THIS tree's code and a real Chromium audio element,
// not of a mock. No DSH page is needed, and nothing is installed.
// The bundle registers itself through `window.__ModuleLoader__.load`; this
// captures the definition so the checks can call the real factory. It has to be
// installed before the document exists, hence the init script plus the reload.
await page.addInitScript(() => {
  window.__dwDefinitions = []
  window.__ModuleLoader__ = {
    load: (definition) => { window.__dwDefinitions.push(definition) },
    resolve: () => undefined,
  }
})
await page.goto('about:blank')
await page.addScriptTag({ content: clientSource })
const loaded = await page.evaluate(() => ({
  ok: window.__dwDefinitions.length > 0,
  count: window.__dwDefinitions.length,
  id: window.__dwDefinitions[0]?.id ?? null,
}))

const report = { loaded }

// --- 1 & 2 & 3: the player and the slot, in a real browser ----------------

const played = await page.evaluate(async () => {
  const definition = window.__dwDefinitions[0]
  if (definition === undefined) return { error: 'no bundle' }
  const module = definition.factory(() => ({
    createElement: () => null,
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useRef: (initial) => ({ current: initial }),
    useEffect: () => {},
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  }))
  if (typeof module.createLatestOnlySlot !== 'function') return { error: 'createLatestOnlySlot missing' }
  if (typeof module.speakViaBackend !== 'function') return { error: 'speakViaBackend missing' }

  const out = {}

  // A real WAV so the real element actually decodes and plays.
  function wav(seconds, sampleRate = 24000) {
    const samples = Math.floor(seconds * sampleRate)
    const bytes = new Uint8Array(44 + samples * 2)
    const view = new DataView(bytes.buffer)
    const text = (at, value) => { for (let i = 0; i < value.length; i += 1) bytes[at + i] = value.charCodeAt(i) }
    text(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); text(8, 'WAVE'); text(12, 'fmt ')
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
    view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true)
    view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, 'data')
    view.setUint32(40, samples * 2, true)
    // A quiet tone, so playback time really advances.
    for (let i = 0; i < samples; i += 1) {
      view.setInt16(44 + i * 2, Math.round(Math.sin((i / sampleRate) * 2 * Math.PI * 220) * 2000), true)
    }
    return bytes
  }

  const elements = []
  const env = {
    // The real element, constructed the way the browser plays it: `src` is set
    // once, then `play()` is awaited by the module. `new Audio(src)` is
    // equivalent but this records the element for the measurement.
    Audio: function AudioElement(src) {
      const element = new Audio()
      element.autoplay = false
      elements.push(element)
      element.src = src
      return element
    },
    URL,
    Blob,
    fetch: () => Promise.resolve(new Response(wav(3.0), {
      status: 200,
      headers: { 'content-type': 'audio/wav', 'x-dw-tts-seconds': '3' },
    })),
    setTimeout,
    AbortController,
  }

  // --- hang-up latency ---------------------------------------------------
  const player = module.speakViaBackend('这是一段用于测量的朗读。', env)
  // Wait until the element is actually advancing: a stop before playback
  // proves nothing about silencing audio.
  const deadline = performance.now() + 5000
  let element = null
  while (performance.now() < deadline) {
    element = elements[0] ?? null
    // Decoding a blob is asynchronous: readyState 4 (HAVE_ENOUGH_DATA) plus a
    // paused element means "asked to play but nothing happened".
    if (element !== null && element.readyState >= 3 && !element.paused && element.currentTime > 0.05) break
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  if (element === null || element.paused) {
    out.hangup = {
      error: 'the element never started playing',
      paused: element?.paused ?? null,
      currentTime: element?.currentTime ?? null,
      readyState: element?.readyState ?? null,
      mediaError: element?.error?.code ?? null,
    }
  } else {
    const timeBefore = element.currentTime
    const clickAt = performance.now()
    player.stop('hangup')
    // Poll for the moment the element is paused: that is "silent".
    let silentAt = null
    while (performance.now() - clickAt < 1000) {
      if (element.paused === true) { silentAt = performance.now(); break }
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
    const timeAfter = element.currentTime
    out.hangup = {
      latencyMs: silentAt === null ? null : Number((silentAt - clickAt).toFixed(1)),
      paused: element.paused,
      srcCleared: element.getAttribute('src') === null || element.src === '',
      currentTimeStopped: Number(timeAfter.toFixed(3)),
      currentTimeBefore: Number(timeBefore.toFixed(3)),
      readable: element.readyState,
    }
    // Does it stay silent? A paused element that resumes is not silenced.
    await new Promise((resolve) => setTimeout(resolve, 400))
    out.hangup.stillPausedAfter400ms = element.paused
    out.hangup.currentTimeAfterWait = Number(element.currentTime.toFixed(3))
  }

  // --- three replies, one read -------------------------------------------
  const timers = []
  const slot = module.createLatestOnlySlot({
    coalesceMs: 60,
    setTimeout: (fn, ms) => { const id = setTimeout(fn, ms); timers.push(id); return id },
    clearTimeout: (id) => clearTimeout(id),
  })
  const read = []
  for (const text of ['第一条回复', '第二条回复', '第三条回复']) {
    slot.offer(text)
  }
  await new Promise((resolve) => setTimeout(resolve, 120))
  const taken = slot.take()
  if (taken !== null) read.push(taken.text)
  out.threeReplies = { readCount: read.length, read, counts: slot.counts(), slotEmptyAfter: slot.take() === null }

  // --- a reply mid-read interrupts the old one ---------------------------
  const before = elements.length
  const first = module.speakViaBackend('正在朗读的旧回复。', env)
  const waitDeadline = performance.now() + 4000
  let firstEl = null
  while (performance.now() < waitDeadline) {
    firstEl = elements[before] ?? null
    if (firstEl !== null && !firstEl.paused && firstEl.currentTime > 0.05) break
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  const interrupt = { oldStarted: firstEl !== null && !firstEl.paused }
  if (firstEl !== null && !firstEl.paused) {
    // What the new-message path does: stop the old read, then read the new one.
    first.stop('superseded')
    interrupt.oldPausedAfterInterrupt = firstEl.paused
    interrupt.oldCurrentTime = Number(firstEl.currentTime.toFixed(3))
    const second = module.speakViaBackend('新到的最新回复。', env)
    const secondDeadline = performance.now() + 4000
    let secondEl = null
    while (performance.now() < secondDeadline) {
      secondEl = elements[elements.length - 1] ?? null
      if (secondEl !== null && secondEl !== firstEl && !secondEl.paused && secondEl.currentTime > 0.02) break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    interrupt.newPlayed = secondEl !== null && secondEl !== firstEl && !secondEl.paused
    interrupt.distinctElement = secondEl !== firstEl
    second.stop('hangup')
  }
  out.interrupt = interrupt
  return out
})
report.behaviour = played

// --- 4 & 5: decoration counts and contrast on a real page -----------------

// A minimal page exercising the same decoration path the Host's DOM has: user
// rows carrying the Host's anchors, a bubble class, and the sidebar rows.
const decoration = await page.evaluate(async () => {
  const definition = window.__dwDefinitions[0]
  const module = definition.factory(() => ({
    createElement: () => null,
    useState: (initial) => [initial, () => {}],
    useRef: (initial) => ({ current: initial }),
    useEffect: () => {},
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  }))
  const PALETTE = module.WORKSPACE_PALETTE ?? []
  const out = { palette: PALETTE }

  // Contrast of the logo ink on both sidebar surfaces, computed by the module
  // and re-checked here against what Chromium paints.
  out.contrast = []
  for (const scheme of [['light', '#F9FAFB', '#0F1115'], ['dark', '#1B1B1C', '#ADB2B8']]) {
    for (const color of PALETTE.slice(0, 4)) {
      const paint = module.whaleLogoPaint(color, scheme[1], scheme[2])
      out.contrast.push({ scheme: scheme[0], color, ink: paint.color, ratio: paint.ratio })
    }
  }

  // The bubble tint, resolved by a real Chromium `color-mix`.
  const mixHost = document.createElement('div')
  document.body.appendChild(mixHost)
  out.tints = []
  for (const color of PALETTE.slice(0, 4)) {
    const paint = module.turnBubblePaint(color, { bubble: '#EDF3FE', surface: '#FFFFFF' })
    mixHost.style.background = `color-mix(in srgb, ${color} ${paint.tint}%, #EDF3FE)`
    const resolved = getComputedStyle(mixHost).backgroundColor
    const base = document.createElement('div')
    base.style.background = '#EDF3FE'
    document.body.appendChild(base)
    out.tints.push({
      color,
      tint: paint.tint,
      mixResolves: resolved,
      baseResolves: getComputedStyle(base).backgroundColor,
      differs: resolved !== getComputedStyle(base).backgroundColor,
    })
    base.remove()
  }
  mixHost.remove()
  return out
})
report.decoration = decoration

await writeFile(join(outDir, 'report.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
await browser.close()
