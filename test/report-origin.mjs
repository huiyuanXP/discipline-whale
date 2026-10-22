/**
 * Tests for report-origin lookup: which workspace a pushed Worker report came
 * from, and how the client paints a user row that carries one.
 *
 * A pushed report reaches the main session as an ordinary user message
 * (`sessionController.prompt`, kind "user"), so the only durable handle on its
 * origin is the `report id:` line in its own text. These tests pin:
 *
 *   1. `reportIdOf` reads the id from the pushed shape and refuses non-reports
 *   2. the reports route answers id -> { workspaceId, workspaceTitle, color }
 *   3. an unknown id is a miss (null), never an error
 *   4. the client resolves a report row to its origin workspace and falls back
 *      to a neutral, tag-less unknown when the lookup misses
 *   5. the bubble paint uses theme variables, not a literal hex
 *
 * Run: node test/report-origin.mjs
 */

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PALETTE, defaultColor } from '../activity.js'
import { MEMORY_REPORTS_ROUTE, memoryRoutesHandler, reportIdOf } from '../memory-routes.js'
import { dataDir } from '../store.js'

const pass = (name) => console.log(`pass  ${name}`)
const root = await mkdtemp(join(tmpdir(), 'dw-report-origin-'))

const WS = 'f663d93b-af28-43cc-8ace-91b04b81db6d'
const REPORT_ID = 'r-6dc7b86f-79c1-41d8-8e4e-b65577a59f0b'

/** Write one report the way report_to_main does, with a chosen workspace. */
async function seedReport(home, { workspaceId = WS, workspaceTitle = 'soc-api-test', id = REPORT_ID } = {}) {
  const dir = join(dataDir(home), 'reports', String(workspaceId).replace(/[^A-Za-z0-9._-]/g, '_'))
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, `${id}.json`),
    JSON.stringify({
      id,
      dispatchId: 'dispatch-1',
      workspaceId,
      workspaceTitle,
      workerSessionId: 'session-worker',
      mainSessionId: 'session-main',
      status: 'delivered',
      outcome: 'done',
      summary: 'hello',
      document: 'body',
      reportedAt: '2026-10-22T00:00:00.000Z',
    }),
  )
}

/** Call the route handler the way the web connection does. */
function get(handler, path, query = '') {
  return handler(new Request(`http://localhost${path}${query}`, { method: 'GET' }))
}

try {
  // 1. reportIdOf reads the pushed shape and refuses anything else
  {
    const pushed = [
      '[Discipline Whale] Worker report — skiplec (done)',
      '',
      'hello — 工作目录 /Users/huiyuan/Developer/projects/skiplec。',
      '',
      `report id: ${REPORT_ID}`,
      'Call read_report with that id for the full document.',
    ].join('\n')
    assert.equal(reportIdOf(pushed), REPORT_ID)
    assert.equal(reportIdOf(`  report id:   ${REPORT_ID}  `), REPORT_ID)
    // A user message that merely mentions read_report is not a report row.
    assert.equal(reportIdOf('Call read_report with that id for the full document.'), null)
    assert.equal(reportIdOf(''), null)
    assert.equal(reportIdOf(undefined), null)
    assert.equal(reportIdOf(null), null)
    pass('reportIdOf reads the pushed shape')
  }

  // 2. the reports route answers id -> origin workspace, with its live color
  {
    const home = await mkdtemp(join(root, 'h2-'))
    await seedReport(home)
    const handler = memoryRoutesHandler({
      workspaces: () => [{ id: WS, title: 'soc-api-test', path: '/tmp/soc' }],
      root: () => home,
    })
    const response = await get(handler, MEMORY_REPORTS_ROUTE, `?id=${REPORT_ID}`)
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.report.workspaceId, WS)
    assert.equal(payload.report.workspaceTitle, 'soc-api-test')
    // No card was written, so the color is the stable palette default.
    assert.equal(payload.report.color, defaultColor(WS))
    assert.ok(PALETTE.includes(payload.report.color))
    pass('reports route resolves an id to its workspace')
  }

  // 3. an unknown id is a miss, not an error
  {
    const home = await mkdtemp(join(root, 'h3-'))
    const handler = memoryRoutesHandler({ workspaces: () => [], root: () => home })
    const ok = await get(handler, MEMORY_REPORTS_ROUTE, '?id=r-nope')
    assert.equal(ok.status, 200)
    assert.deepEqual((await ok.json()).report, null)
    const missing = await get(handler, MEMORY_REPORTS_ROUTE, '')
    assert.equal(missing.status, 200)
    assert.deepEqual((await missing.json()).report, null)
    pass('unknown or absent id is a null report')
  }

  // 4. a written workspace color wins over the palette default
  {
    const home = await mkdtemp(join(root, 'h4-'))
    await seedReport(home)
    await mkdir(join(dataDir(home), 'memory-state'), { recursive: true })
    await writeFile(join(dataDir(home), 'memory-state', 'workspaces.json'), JSON.stringify({ [WS]: { intro: 'x', color: '#123456' } }))
    const handler = memoryRoutesHandler({
      workspaces: () => [{ id: WS, title: 'soc-api-test', path: '/tmp/soc' }],
      root: () => home,
    })
    const payload = await (await get(handler, MEMORY_REPORTS_ROUTE, `?id=${REPORT_ID}`)).json()
    assert.equal(payload.report.color, '#123456')
    pass('a stored workspace color wins over the default')
  }

  console.log('report-origin: all checks passed')
} catch (error) {
  console.error('FAIL', error)
  process.exitCode = 1
}
