/**
 * `scripts/reindex.mjs`: the one-shot index backfill for reports that predate 0.7.0.
 *
 *   1. dry-run on a home with no index writes nothing and reports every page as
 *      `create` (exit 2, so a caller can tell "would change" from "consistent")
 *   2. --apply: one page per workspace, header `count` equals the report-file
 *      count, and every path in ALL.md exists (a dead ALL.md link is the bug)
 *   3. a second --apply changes nothing: every page reports `rebuiltAgain: false`
 *      and the exit code is 0
 *   4. a missing page is re-created and a stale page (a report landed after it
 *      was written) is rebuilt — the same two cases `ensureReportIndex` heals
 *   5. the notes pointer `索引：index/<key>.md` resolves to a real file
 *
 * Run: node test/reindex.mjs
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import {
  clearStoreRoot,
  dataDir,
  indexSummaryPath,
  readReportIndex,
  reportDir,
  reportIndexPath,
  setStoreRoot,
  whaleHomeDir,
  writeReport,
} from '../store.js'

const run = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, '..', 'scripts', 'reindex.mjs')

const root = await mkdtemp(join(tmpdir(), 'whale-reindex-'))
setStoreRoot(root)

/** The two workspaces: the 77-report one that matches production, and a small one. */
const BIG = { id: '98db8004-16c6-4198-9acd-03275e2860f4', title: 'discipline-whale' }
const SMALL = { id: 'fc579797-178c-4c96-be3d-a55865032994', title: 'deepseek-harness' }

/** A report at minute `index` of one fixed hour, so order is by construction. */
function makeReport(workspace, index) {
  const minute = String(Math.floor(index / 60)).padStart(2, '0')
  const second = String(index % 60).padStart(2, '0')
  return {
    id: `r-${workspace.id.slice(0, 8)}-${String(index).padStart(3, '0')}`,
    dispatchId: `dispatch-${index}`,
    workspaceId: workspace.id,
    workspaceTitle: workspace.title,
    workerSessionId: `worker-${index}`,
    mainSessionId: 'main-1',
    status: 'delivered',
    outcome: 'done',
    summary: `Report number ${index} of ${workspace.title}.`,
    document: '',
    reportedAt: `2026-10-24T06:${minute}:${second}.000Z`,
    deliveredTo: ['main-1'],
  }
}

/** Run the script against `root`; never throws on a non-zero exit. */
async function reindex(...args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [SCRIPT, '--home', root, '--json', ...args], {
      encoding: 'utf8',
      env: { ...process.env, DSH_HOME: root },
    })
    return { code: 0, stdout, stderr }
  } catch (error) {
    return { code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }
  }
}

/** The `--json` payload, with the process result alongside it. */
async function reindexJson(...args) {
  const result = await reindex(...args)
  assert.notEqual(result.stdout.trim(), '', `no JSON on stdout (stderr: ${result.stderr})`)
  return { ...result, body: JSON.parse(result.stdout) }
}

const indexDir = join(whaleHomeDir(root), 'index')
const reportCount = async (workspace) => (await readdir(reportDir(root, workspace.id))).filter((e) => e.endsWith('.json')).length
/** The `count:` a page's header claims. */
const headerCount = async (workspace) => (await readReportIndex(root, workspace.id))?.count

try {
  // Production shape: 77 old reports in one workspace, 4 in another, no index at all,
  // and the Host's workspace table (the script's only source of display titles).
  await mkdir(join(root, 'storages'), { recursive: true })
  await writeFile(
    join(root, 'storages', 'workspace.json'),
    JSON.stringify({
      unit: 0,
      global: {},
      tables: {
        workspaces: {
          [BIG.id]: { path: '/Users/huiyuan/Developer/projects/discipline-whale', title: BIG.title, sessionIds: [] },
          [SMALL.id]: { path: '/Users/huiyuan/Developer/projects/deepseek-harness', title: SMALL.title, sessionIds: [] },
        },
      },
    }),
    'utf8',
  )
  for (let index = 0; index < 77; index += 1) await writeReport(root, makeReport(BIG, index))
  for (let index = 0; index < 4; index += 1) await writeReport(root, makeReport(SMALL, index))
  assert.equal(await reportCount(BIG), 77)
  assert.equal(await reportCount(SMALL), 4)
  assert.equal(existsSync(indexDir), false, 'the fixture starts with no index directory')

  // 1 — dry-run writes nothing.
  {
    const { code, body } = await reindexJson()
    assert.equal(code, 2, 'a dry-run that would change something exits 2')
    assert.equal(body.mode, 'dry-run')
    assert.equal(body.workspaces, 2)
    assert.equal(body.reportsTotal, 81, '77 + 4')
    assert.equal(body.wouldChange, 2)
    assert.deepEqual(body.rows.map((row) => row.action), ['create', 'create'])
    assert.deepEqual(body.rows.map((row) => row.before), [null, null], 'no page exists yet')
    assert.equal(existsSync(indexDir), false, 'dry-run must not create the index directory')
    console.log('ok 1 — dry-run: 81 reports across 2 workspaces, both `create`, nothing written, exit 2')
  }

  // 2 — --apply writes one page per workspace with a truthful count.
  {
    const { code, body } = await reindexJson('--apply')
    assert.equal(code, 0, 'apply exits 0')
    assert.equal(body.mode, 'apply')
    assert.equal(body.wouldChange, 2)
    for (const workspace of [BIG, SMALL]) {
      const path = reportIndexPath(root, workspace.id)
      assert.ok(existsSync(path), `index page written for ${workspace.title}`)
      assert.equal(await headerCount(workspace), await reportCount(workspace), `${workspace.title}: count equals the file count`)
      assert.match(await readFile(path, 'utf8'), new RegExp(`^# 报告索引 · ${workspace.title} \\(${workspace.id}\\)$`, 'm'))
    }
    assert.equal(await headerCount(BIG), 77, 'the production-shaped workspace counts 77')
    const summary = await readFile(indexSummaryPath(root), 'utf8')
    assert.match(summary, /workspaces: 2/)
    for (const line of summary.split('\n').filter((entry) => entry.startsWith('- '))) {
      const path = line.split(' — ').at(-1)
      assert.ok(existsSync(path), `every ALL.md line points at a real file: ${path}`)
    }
    console.log('ok 2 — apply: count 77 = 77 and 4 = 4, ALL.md rows all resolve')
  }

  // 3 — idempotence: a second --apply writes nothing.
  {
    const before = await readdir(indexDir)
    const mtimes = await Promise.all(before.map((entry) => readFile(join(indexDir, entry), 'utf8')))
    const { code, body } = await reindexJson('--apply')
    assert.equal(code, 0)
    assert.equal(body.wouldChange, 0, 'nothing left to change')
    assert.deepEqual(body.rows.map((row) => row.action), ['keep', 'keep'])
    assert.deepEqual(body.rows.map((row) => row.rebuiltAgain), [false, false], 'ensureReportIndex reports rebuilt:false')
    const after = await readdir(indexDir)
    assert.deepEqual(after.sort(), before.sort(), 'no page appeared or vanished')
    const texts = await Promise.all(after.map((entry) => readFile(join(indexDir, entry), 'utf8')))
    for (const [index, text] of texts.entries()) {
      if (after[index] === 'ALL.md') continue
      assert.equal(text, mtimes[before.indexOf(after[index])], `${after[index]} was not rewritten`)
    }
    console.log('ok 3 — second --apply: rebuiltAgain false everywhere, byte-identical pages, exit 0')
  }

  // 4 — a deleted page is re-created; a page older than its folder is rebuilt.
  {
    await rm(reportIndexPath(root, BIG.id))
    const dry = await reindexJson()
    assert.equal(dry.code, 2)
    assert.equal(dry.body.rows.find((row) => row.workspaceId === BIG.id).action, 'create')

    await writeReport(root, makeReport(BIG, 90))
    await reindexJson('--apply')
    assert.equal(await headerCount(BIG), 78, 'the new report is in the count')
    await writeReport(root, makeReport(BIG, 91))
    const stale = await reindexJson()
    assert.equal(stale.body.rows.find((row) => row.workspaceId === BIG.id).action, 'rebuild', 'count 78 vs 79 files is stale')
    assert.equal(stale.body.rows.find((row) => row.workspaceId === BIG.id).before, 78)
    await reindexJson('--apply')
    assert.equal(await headerCount(BIG), 79)
    console.log('ok 4 — a deleted page is `create`, a page behind its folder is `rebuild`')
  }

  // 5 — the notes pointer the model follows resolves to a page.
  {
    const note = ['<!-- generated by discipline-whale -->', `# ${BIG.title} (${BIG.id})`, '## 更早', `- 共 79 份报告，索引：index/${BIG.id}.md`, ''].join('\n')
    await mkdir(join(whaleHomeDir(root), 'notes'), { recursive: true })
    await writeFile(join(whaleHomeDir(root), 'notes', `${BIG.id}.md`), note, 'utf8')
    const pointer = /索引：(index\/[^\s]+\.md)/.exec(await readFile(join(whaleHomeDir(root), 'notes', `${BIG.id}.md`), 'utf8'))
    assert.notEqual(pointer, null, 'the note carries a pointer')
    const target = join(whaleHomeDir(root), pointer[1])
    assert.ok(existsSync(target), `the pointer resolves: ${target}`)
    assert.equal(await headerCount(BIG), 79)
    console.log('ok 5 — the notes pointer `index/<key>.md` resolves and its count is 79')
  }

  // 6 — a registered workspace with no report folder keeps its ALL.md row.
  //
  // Production has 8 registered workspaces and only 6 report folders. Scanning
  // folders alone would drop the two empty ones from ALL.md, which is the
  // summary the main session reads; they must stay visible with `0 份`.
  {
    const EMPTY = { id: 'feade39e-22a2-4469-b683-0b1bde76b4eb', title: 'cs5446-projects' }
    const table = JSON.parse(await readFile(join(root, 'storages', 'workspace.json'), 'utf8'))
    table.tables.workspaces[EMPTY.id] = { path: '/tmp/cs5446', title: EMPTY.title, sessionIds: [] }
    await writeFile(join(root, 'storages', 'workspace.json'), JSON.stringify(table), 'utf8')

    const { body } = await reindexJson()
    assert.equal(body.workspaces, 3, 'the empty registered workspace is scanned too')
    assert.equal(existsSync(reportIndexPath(root, EMPTY.id)), false, 'dry-run still writes nothing')
    await reindexJson('--apply')
    const summary = await readFile(indexSummaryPath(root), 'utf8')
    assert.match(summary, /workspaces: 3/)
    const emptyRow = summary.split('\n').find((line) => line.includes(EMPTY.id))
    assert.notEqual(emptyRow, undefined, 'the empty workspace keeps its ALL.md row')
    assert.ok(emptyRow.includes('· 0 份'), emptyRow)
    assert.ok(existsSync(emptyRow.split(' — ').at(-1)), 'its index page exists and is reachable')
    console.log('ok 6 — a registered workspace with no reports keeps a `0 份` ALL.md row')
  }

  // The script must refuse to invent work on a home with nothing in it.
  {
    const empty = await mkdtemp(join(tmpdir(), 'whale-reindex-empty-'))
    try {
      const { code } = await run(process.execPath, [SCRIPT, '--home', empty, '--json'], { encoding: 'utf8' }).then(
        (ok) => ({ code: 0 }),
        (error) => ({ code: error.code }),
      )
      assert.equal(code, 1, 'a home with no report folders is a hard error, not a silent success')
    } finally {
      await rm(empty, { recursive: true, force: true })
    }
    console.log('ok 7 — a home with no reports exits 1 instead of pretending to have reindexed')
  }

  console.log('all checks passed — scripts/reindex.mjs')
} finally {
  clearStoreRoot()
  await rm(root, { recursive: true, force: true })
}
