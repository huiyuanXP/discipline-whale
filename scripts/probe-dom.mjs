/**
 * Read-only DOM probe against the real running DSH web GUI.
 *
 * Answers the questions the fix depends on, from the live page rather than a
 * synthetic DOM:
 *
 *   - how many user rows carry `data-chat-turn`, and what a user row actually
 *     looks like when it does not
 *   - whether a bubble class convention (`<hash>_bubble`) is present, and what
 *     the row structure around it is
 *   - how the sidebar folder rows are marked
 *   - whether `data-dw-turn-ws` / `data-dw-ws-folder` appear at all today
 *
 * Usage: node scripts/probe-dom.mjs [--url http://127.0.0.1:3080/?token=...] [--out dir]
 * Exits non-zero only on an unreachable page; a page with no conversation is a
 * reported state, not a failure.
 */

import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const require = createRequire(import.meta.url)

function argOf(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : process.argv[index + 1]
}

const url = argOf('url', process.env.DW_GUI_URL ?? 'http://127.0.0.1:3080/')
const outDir = argOf('out', 'artifacts/dom-probe')
const waitMs = Number(argOf('wait', '9000'))

// playwright-core lives in the DSH profile, not in this package: the probe is
// a diagnostic, not a shipped dependency.
const playwrightPath = argOf('playwright', join(process.env.HOME ?? '', '.dsh/profiles/web/node_modules/playwright-core'))
const { chromium } = require(playwrightPath)

// The browser build the installed playwright-core expects may be missing; use
// a locally cached Chromium when it is. Only a diagnostic, so falling back to
// a slightly older build is fine and better than "please run npx playwright
// install" on a machine that already has one.
const CANDIDATES = [
  join(process.env.HOME ?? '', 'Library/Caches/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell'),
  join(process.env.HOME ?? '', 'Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
]
const executablePath = argOf('chrome', CANDIDATES.find((candidate) => existsSync(candidate)) ?? undefined)
if (executablePath === undefined) {
  console.error('probe: no Chromium found; pass --chrome <path>')
  process.exit(2)
}

await mkdir(outDir, { recursive: true })

const browser = await chromium.launch({ headless: true, executablePath })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await context.newPage()
const consoleErrors = []
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text())
})
page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`))

let navigationOk = true
try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 })
} catch (error) {
  navigationOk = false
  console.error(`probe: navigation failed: ${error.message}`)
}

if (navigationOk) await page.waitForTimeout(waitMs)

const report = navigationOk
  ? await page.evaluate(() => {
      const count = (selector) => document.querySelectorAll(selector).length
      const bubbleLike = (element) => /(^|_)bubble$/i.test(String(element.className ?? ''))

      // Every distinct class token that looks like a CSS-modules `*_bubble`.
      const bubbleClasses = new Map()
      for (const element of document.querySelectorAll('[class*="_bubble"]')) {
        const cls = String(element.className ?? '')
        bubbleClasses.set(cls, (bubbleClasses.get(cls) ?? 0) + 1)
      }

      // A user flow row, described shallowly: its own attributes, its bubble
      // child (if any), and its text.
      const describe = (row) => {
        const bubble = row.querySelector('[class*="_bubble"]')
        return {
          tag: row.tagName.toLowerCase(),
          className: String(row.className ?? ''),
          attributes: Array.from(row.attributes, (attribute) => [attribute.name, attribute.value.slice(0, 80)]),
          text: String(row.textContent ?? '').slice(0, 60),
          bubble: bubble === null ? null : { className: String(bubble.className ?? '') },
          hasChatTurn: row.hasAttribute('data-chat-turn'),
        }
      }

      const userRows = Array.from(document.querySelectorAll('[data-chat-flow-kind="user"]'))
      // Any ancestor chain one level up from a user row: what actually holds
      // the turn identity, if not the row.
      const ancestorChains = userRows.slice(0, 4).map((row) => {
        const chain = []
        let node = row
        for (let depth = 0; depth < 6 && node !== null && node !== document.body; depth += 1) {
          chain.push({
            depth,
            tag: node.tagName?.toLowerCase?.() ?? null,
            className: String(node.className ?? '').slice(0, 120),
            attributes: node.getAttributeNames?.()
              .filter((name) => name.startsWith('data-'))
              .map((name) => [name, String(node.getAttribute(name)).slice(0, 60)]) ?? [],
          })
          node = node.parentElement
        }
        return chain
      })

      const turns = new Set()
      for (const element of document.querySelectorAll('[data-chat-turn]')) {
        turns.add(element.getAttribute('data-chat-turn'))
      }

      return {
        url: location.href,
        title: document.title,
        counts: {
          'data-chat-flow-kind=user': count('[data-chat-flow-kind="user"]'),
          'data-chat-turn': count('[data-chat-turn]'),
          '[class*=_bubble]': count('[class*="_bubble"]'),
          'data-dw-report-origin': count('[data-dw-report-origin]'),
          'data-dw-turn-ws': count('[data-dw-turn-ws]'),
          'data-dw-ws-folder': count('[data-dw-ws-folder]'),
          'data-row-key^=workspace:': count('[data-row-key^="workspace:"]'),
          'data-row-key^=session:': count('[data-row-key^="session:"]'),
          'role=menu': count('[role="menu"]'),
        },
        turnValues: [...turns].slice(0, 20),
        bubbleClasses: [...bubbleClasses.entries()].slice(0, 12),
        userRowSamples: userRows.slice(0, 4).map(describe),
        ancestorChains,
        firstWorkspaceRow: (() => {
          const row = document.querySelector('[data-row-key^="workspace:"]')
          if (row === null) return null
          return {
            className: String(row.className ?? ''),
            attributes: Array.from(row.attributes, (attribute) => [attribute.name, attribute.value.slice(0, 80)]),
            text: String(row.textContent ?? '').slice(0, 60),
            childClasses: Array.from(row.querySelectorAll('[class]')).slice(0, 8).map((element) => String(element.className ?? '')),
          }
        })(),
      }
    })
  : { navigationOk: false }

const screenshotPath = join(outDir, 'page.png')
if (navigationOk) {
  await page.screenshot({ path: screenshotPath, fullPage: false }).catch(() => {})
}

const payload = { probedAt: new Date().toISOString(), url, consoleErrors: consoleErrors.slice(0, 12), report }
await writeFile(join(outDir, 'probe.json'), JSON.stringify(payload, null, 2))
console.log(JSON.stringify(payload, null, 2))

await browser.close()
process.exitCode = navigationOk ? 0 : 2
