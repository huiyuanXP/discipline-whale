/**
 * Real-page verification of the turn tag, the clickable chip, and the sidebar
 * folder color.
 *
 * This is NOT a synthetic-DOM test: it drives the actual DSH web GUI in
 * headless Chromium, against the actual Host, better-display, React and the
 * real transcript. The only thing it substitutes is `discipline-whale/client.js`
 * — served from the release tree through one Playwright route instead of from
 * the installed package — because installing the package under test is exactly
 * what this run must not do.
 *
 * Phase 1 (before): the installed 0.6.2 client, measured. The tag count is 0.
 * Phase 2 (after):  the release tree's client, measured in the same browser,
 *                   on the same page, against the same server.
 *
 * Usage: node scripts/verify-dom.mjs --token <gui token> [--out dir]
 */

import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const require = createRequire(import.meta.url)

function argOf(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : process.argv[index + 1]
}

const token = argOf('token', process.env.DW_GUI_TOKEN)
if (token === undefined) {
  console.error('verify: pass --token <gui token> (the ?token= value from the dsh web URL)')
  process.exit(2)
}
const base = argOf('base', 'http://127.0.0.1:3080')
const url = `${base}/?token=${token}`
const outDir = argOf('out', 'artifacts/dom-verify')
// The main session: its user rows are the ones carrying dispatch tags.
const sessionId = argOf('session', 'session-44431ff2-3cf7-4755-ad0f-0a000e0266ee')
// The chip to click, chosen because its target is a session the sidebar lists
// today (a released session cannot be opened, and the Host says so).
const clickTarget = argOf('click-target', 'session-6fae8d6f-70cb-4535-a4da-4f6e0346ce29')
const clientPath = resolve(argOf('client', 'client.js'))
const waitMs = Number(argOf('wait', '11000'))

const playwrightPath = argOf('playwright', join(process.env.HOME ?? '', '.dsh/profiles/web/node_modules/playwright-core'))
const { chromium } = require(playwrightPath)
const CHROME_CANDIDATES = [
  join(process.env.HOME ?? '', 'Library/Caches/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell'),
  join(process.env.HOME ?? '', 'Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
]
const executablePath = argOf('chrome', CHROME_CANDIDATES.find((candidate) => require('node:fs').existsSync(candidate)))

const clientSource = await readFile(clientPath, 'utf8')
await mkdir(outDir, { recursive: true })

/**
 * Everything the measurements need, evaluated on the live page.
 */
function measure() {
  const count = (selector) => document.querySelectorAll(selector).length
  const userRows = Array.from(document.querySelectorAll('[data-chat-flow-kind="user"]'))
  const chips = Array.from(document.querySelectorAll('[data-dw-turn-chip]'))
  const firstRow = userRows[0] ?? null
  const tint = firstRow === null ? null : getComputedStyle(firstRow).getPropertyValue('--dw-msg-ws').trim()
  const bubbleEl = document.querySelector('[data-dw-turn-bubble]')
  const bubbleBg = bubbleEl === null ? null : getComputedStyle(bubbleEl).backgroundColor
  const chipComputed = chips.length === 0 ? null : getComputedStyle(chips[0]).cursor
  return {
    counts: {
      userRows: userRows.length,
      'data-chat-turn': count('[data-chat-turn]'),
      'data-dw-turn-ws': count('[data-dw-turn-ws]'),
      'data-dw-turn-bubble': count('[data-dw-turn-bubble]'),
      'data-dw-turn-chip': chips.length,
      'data-dw-ws-folder': count('[data-dw-ws-folder]'),
      workspaceRows: count('[data-row-key^="workspace:"]'),
      'data-dw-report-origin': count('[data-dw-report-origin]'),
      whaleMarks: count('[data-dw-whale]'),
    },
    rowTint: tint === '' ? null : tint,
    bubbleBackground: bubbleBg,
    chipCursor: chipComputed,
    chipSessions: chips.map((chip) => chip.getAttribute('data-dw-session')),
    chipInert: chips.filter((chip) => chip.getAttribute('data-dw-inert') !== null).length,
    folderColors: Array.from(document.querySelectorAll('[data-row-key^="workspace:"][data-dw-ws-folder]'))
      .slice(0, 4)
      .map((row) => [row.getAttribute('data-row-key'), row.getAttribute('data-dw-ws-folder')]),
    apiCalls: window.__dwApiCalls ?? [],
  }
}

/**
 * One browser journey. `overrideClient` decides whether the plugin asset is
 * answered from the release tree or by the server.
 */
async function journey({ label, overrideClient }) {
  const browser = await chromium.launch({ headless: true, executablePath })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  const consoleMessages = []
  const apiCalls = []
  page.on('console', (message) => {
    const text = message.text()
    if (message.type() === 'warning' || message.type() === 'error') consoleMessages.push(`[${message.type()}] ${text.slice(0, 200)}`)
  })
  page.on('pageerror', (error) => consoleMessages.push(`[pageerror] ${error.message.slice(0, 200)}`))
  page.on('response', (response) => {
    const target = response.url()
    if (target.includes('/api/discipline-whale/')) apiCalls.push(`${target.replace(base, '')} ${response.status()}`)
  })
  // Record the plugin's own API traffic for the report.
  await page.addInitScript(() => {
    window.__dwApiCalls = []
    const original = window.fetch
    window.fetch = (input, init) => {
      const target = typeof input === 'string' ? input : String(input?.url ?? '')
      if (target.includes('/api/discipline-whale/')) window.__dwApiCalls.push(target.replace(location.origin, ''))
      return original(input, init)
    }
  })
  if (overrideClient) {
    await page.route('**/plugins/**', async (route) => {
      const target = route.request().url()
      if (!target.includes('discipline-whale/client.js')) return route.continue()
      return route.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: clientSource })
    })
  }

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 })
  await page.waitForTimeout(6000)
  // Folders start collapsed; a session inside one is not in the DOM until its
  // folder opens, so open them all before looking for the row.
  for (const folder of await page.$$('[data-row-key^="workspace:"][aria-expanded="false"]')) {
    await folder.click({ timeout: 4000 }).catch(() => {})
    await page.waitForTimeout(350)
  }
  await page.waitForTimeout(1200)
  // Open a real session with tagged turns.
  const row = await page.$(`[data-row-key="session:${sessionId}"]`)
  if (row !== null) {
    await row.click()
  } else {
    const more = await page.$('[data-row-key^="overflow:"]')
    if (more !== null) {
      await more.click()
      await page.waitForTimeout(1500)
      const again = await page.$(`[data-row-key="session:${sessionId}"]`)
      if (again !== null) await again.click()
    }
  }
  await page.waitForTimeout(waitMs)

  const measured = await page.evaluate(measure)

  // Click the first chip that has a session and record what the page did.
  let clickEffect = null
  // Every session the sidebar lists right now: only these can be opened, since
  // the Host has released everything it no longer lists. The first chip whose
  // target is one of them is the one to click.
  const listedNow = await page.evaluate(() => Array.from(document.querySelectorAll('[data-row-key^="session:"]'))
    .map((row) => String(row.getAttribute('data-row-key')).slice('session:'.length)))
  const chipTargets = await page.evaluate(() => Array.from(document.querySelectorAll('[data-dw-turn-chip][data-dw-session]'))
    .map((chip) => chip.getAttribute('data-dw-session')))
  const liveTarget = chipTargets.find((target) => listedNow.includes(target)) ?? null
  const chipHandle = (liveTarget === null ? null : await page.$(`[data-dw-turn-chip][data-dw-session="${liveTarget}"]`))
    ?? (await page.$('[data-dw-turn-chip][data-dw-session]'))
  if (chipHandle !== null) {
    const targetSession = await chipHandle.getAttribute('data-dw-session')
    const beforeUrl = page.url()
    const beforeSelected = await page.evaluate(() => document.querySelector('[data-row-key^="session:"][class*="selected"]')?.getAttribute('data-row-key') ?? null)
    await chipHandle.click()
    await page.waitForTimeout(3500)
    const afterSelected = await page.evaluate(() => document.querySelector('[data-row-key^="session:"][class*="selected"]')?.getAttribute('data-row-key') ?? null)
    const afterHeading = await page.evaluate(() => {
      const main = document.querySelector('[data-reader-turn]')?.closest('[class]')
      return main === null || main === undefined ? null : String(main.className ?? '').slice(0, 60)
    })
    clickEffect = {
      listedSessionsNow: listedNow.length,
      chipTargets,
      targetIsListed: listedNow.includes(targetSession),
      targetSession,
      beforeSelected,
      afterSelected,
      selectedChanged: beforeSelected !== afterSelected,
      selectedIsTarget: afterSelected === `session:${targetSession}`,
      urlChanged: page.url() !== beforeUrl,
      afterHeading,
    }
  }

  const shot = join(outDir, `${label}-${overrideClient ? 'after' : 'before'}.png`)
  await page.screenshot({ path: shot, fullPage: false }).catch(() => {})

  await browser.close()
  return { label, measured: { ...measured, apiCalls }, clickEffect, consoleMessages: consoleMessages.slice(0, 10), screenshot: shot }
}

const before = await journey({ label: 'installed-0.6.2', overrideClient: false })
const after = await journey({ label: 'release-tree', overrideClient: true })

const verdict = {
  tagsBefore: before.measured.counts['data-dw-turn-ws'],
  tagsAfter: after.measured.counts['data-dw-turn-ws'],
  chipsBefore: before.measured.counts['data-dw-turn-chip'],
  chipsAfter: after.measured.counts['data-dw-turn-chip'],
  folderBefore: before.measured.counts['data-dw-ws-folder'],
  folderAfter: after.measured.counts['data-dw-ws-folder'],
  workspaceRows: after.measured.counts.workspaceRows,
  chatTurnAttrAfter: after.measured.counts['data-chat-turn'],
  clickNavigated: after.clickEffect?.selectedIsTarget === true,
}

const payload = { verifiedAt: new Date().toISOString(), url: `${base}/?token=<redacted>`, clientPath, sessionId, verdict, before, after }
await writeFile(join(outDir, 'verify.json'), JSON.stringify(payload, null, 2))
console.log(JSON.stringify(payload, null, 2))

const ok =
  verdict.tagsAfter > 0 &&
  verdict.chipsAfter > 0 &&
  verdict.folderAfter > 0 &&
  verdict.chatTurnAttrAfter === 0 &&
  verdict.clickNavigated === true
process.exitCode = ok ? 0 : 1
