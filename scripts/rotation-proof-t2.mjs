/**
 * T2 — replay A2 / A3 / A5 against a `$DSH_HOME` and print one verdict each.
 *
 * A2  every workspace's `home/index/<key>.md` header `count` equals the number
 *     of `reports/<key>/*.json` files. Checked twice: as found on disk, and
 *     after `ensureReportIndex` has been allowed to self-heal. The second pass
 *     is the one that proves the writer, not just the file.
 * A3  `scripts/dedupe-replay.mjs` replayed over the same home: how many pairs of
 *     consecutive `report_to_main` calls exist, and how many would be
 *     suppressed. Read from that script's own output, so the two can never
 *     disagree.
 * A5  the workspace note: with a real 8-turn window, which workspaces keep a
 *     full block and which are reduced to their name.
 *
 * Read-only against the home it is pointed at EXCEPT for the A2 self-heal pass,
 * which writes index pages. Run it against an isolated `DSH_HOME` (or pass
 * `--no-repair` to keep even that read-only).
 *
 * Usage:
 *   DSH_HOME=/tmp/dw-demo node scripts/rotation-proof-t2.mjs
 *   node scripts/rotation-proof-t2.mjs --home ~/.dsh --no-repair
 *   node scripts/rotation-proof-t2.mjs --json
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import {
  INDEX_SUMMARY_FILENAME,
  countReportFiles,
  ensureReportIndex,
  readReportIndex,
  reportIndexPath,
  listReports,
  workspaceKey,
} from '../store.js'

const run = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))

function argOf(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : process.argv[index + 1]
}

const home = argOf('home', process.env.DSH_HOME ?? join(homedir(), '.dsh'))
const asJson = process.argv.includes('--json')
const repair = !process.argv.includes('--no-repair')
const dataDir = join(home, 'discipline-whale')
const indexPath = join(dataDir, 'home', 'index')

/** Every workspace id that has a report folder on disk. */
async function reportWorkspaces() {
  const entries = await readdir(join(dataDir, 'reports')).catch(() => [])
  return entries.filter((entry) => !entry.startsWith('.')).sort()
}

/** The `count` a written index page claims, or undefined. */
async function indexCount(workspaceId) {
  const read = await readReportIndex(home, workspaceId)
  return read?.count
}

/** The `workspaces: N` line in ALL.md, or undefined. */
async function summaryRows() {
  try {
    const text = await readFile(join(indexPath, INDEX_SUMMARY_FILENAME), 'utf8')
    const rows = text.split('\n').filter((line) => line.startsWith('- '))
    return { exists: true, rows: rows.length, lines: rows }
  } catch {
    return { exists: false, rows: 0, lines: [] }
  }
}

/**
 * A2 — the header count against the folder, per workspace.
 *
 * `before` is the state this home was found in; `after` is what remains once
 * `ensureReportIndex` has run. A workspace with no page at all is `missing`
 * before and `rebuilt` after — that difference is what makes a dead pointer in
 * a workspace note visible.
 */
async function checkA2() {
  const workspaces = await reportWorkspaces()
  const rows = []
  for (const workspaceId of workspaces) {
    const files = await countReportFiles(home, workspaceId)
    const before = await indexCount(workspaceId)
    const page = reportIndexPath(home, workspaceId)
    const pageExists = existsSync(page)
    let after = before
    let rebuilt
    if (repair) {
      const healed = await ensureReportIndex(home, workspaceId, workspaceId)
      after = healed.count
      rebuilt = healed.rebuilt
    }
    rows.push({
      workspaceId,
      key: workspaceKey(workspaceId),
      files,
      pageExists,
      before,
      after,
      rebuilt,
      ok: after === files,
    })
  }
  const summary = await summaryRows()
  return {
    workspaces: rows.length,
    pagesMissing: rows.filter((row) => !row.pageExists).length,
    mismatchedBefore: rows.filter((row) => row.pageExists && row.before !== row.files).length,
    mismatchedAfter: rows.filter((row) => row.ok === false).length,
    ok: rows.every((row) => row.ok) && rows.length > 0,
    allMd: summary,
    rows,
  }
}

/** A3 — the dedupe replay's own numbers, so the two scripts cannot disagree. */
async function checkA3() {
  const script = join(HERE, 'dedupe-replay.mjs')
  let stdout
  try {
    const result = await run(process.execPath, [script], { env: { ...process.env, DSH_HOME: home }, maxBuffer: 8 * 1024 * 1024 })
    stdout = result.stdout
  } catch (error) {
    return { ran: false, problem: String(error?.message ?? error) }
  }
  const grab = (label) => {
    const match = new RegExp(`${label}:\\s*([0-9]+)`).exec(stdout)
    return match === null ? undefined : Number(match[1])
  }
  const pairs = grab('consecutive report_to_main pairs')
  const suppressed = grab('suppressed \\(stored as a revision\\)')
  const orphaned = grab('orphaned second report \\(never pushed\\)')
  const pushed = grab('pushed')
  return {
    ran: true,
    pairs,
    suppressed,
    orphaned,
    pushed,
    ok: Number.isInteger(pairs) && Number.isInteger(suppressed) && pairs === (suppressed ?? 0) + (orphaned ?? 0) + (pushed ?? 0),
    stdout,
  }
}

/**
 * A5 — the board's own arithmetic over the real registry and report library.
 *
 * The window is 8 human turns and at most 4 active workspaces, which is what
 * `renderWorkspaceNote` is given in production; a workspace that fell out of
 * the window keeps its name and loses its block.
 */
async function checkA5() {
  const { activeWorkspaces, workspaceFacts, renderWorkspaceNote } = await import('../activity.js')
  const workspaces = await reportWorkspaces()
  const records = []
  for (const workspaceId of workspaces) {
    for (const report of await listReports(home, workspaceId)) records.push(report)
  }
  // Every report is a touch; the registry is the report folders themselves.
  const registry = workspaces.map((id) => ({ id, title: id }))
  const { active, inactive } = activeWorkspaces({ workspaces: registry, reports: records, windowTurns: 8, maxActive: 4 })
  const facts = workspaceFacts({ workspaces: registry, reports: records })
  const sample = active[0] === undefined ? undefined : renderWorkspaceNote(active[0], facts.get(String(active[0].id)))
  return {
    workspaces: registry.length,
    active: active.map((workspace) => String(workspace.id)),
    inactive: inactive.map((workspace) => String(workspace.id)),
    ok: active.length > 0 && active.length + inactive.length === registry.length,
    sampleChars: sample === undefined ? 0 : [...sample].length,
  }
}

const a2 = await checkA2()
const a3 = await checkA3()
const a5 = await checkA5()

if (asJson) {
  console.log(JSON.stringify({ home, a2, a3: { ...a3, stdout: undefined }, a5 }, null, 2))
} else {
  const lines = [
    '# T2 — A2 / A3 / A5 against one DSH_HOME',
    '',
    `home: ${home}`,
    `repair pass: ${repair ? 'on (writes index pages)' : 'off (read-only)'}`,
    '',
    `A2  index count == report files`,
    `    workspaces with a report folder : ${a2.workspaces}`,
    `    pages missing before this run    : ${a2.pagesMissing}`,
    `    count mismatched before          : ${a2.mismatchedBefore}`,
    `    count mismatched after self-heal : ${a2.mismatchedAfter}`,
    `    ALL.md                          : ${a2.allMd.exists ? `${a2.allMd.rows} workspace rows` : 'absent'}`,
    `    verdict                         : ${a2.ok ? 'ok' : 'FAIL'}`,
    ...a2.rows.map(
      (row) =>
        `      ${row.key}  files ${String(row.files).padStart(3)}  before ${String(row.before ?? 'missing').padStart(7)}  ` +
        `after ${String(row.after).padStart(3)}  ${row.rebuilt === true ? 'rebuilt' : row.rebuilt === false ? 'fresh' : 'read-only'}`,
    ),
    '',
    `A3  dedupe replay`,
    a3.ran
      ? `    pairs ${a3.pairs} · suppressed ${a3.suppressed} · orphaned ${a3.orphaned} · pushed ${a3.pushed} · verdict ${a3.ok ? 'ok' : 'FAIL'}`
      : `    could not run: ${a3.problem}`,
    '',
    `A5  workspace note scope`,
    `    workspaces ${a5.workspaces} · active ${a5.active.length} · inactive (name only) ${a5.inactive.length} · verdict ${a5.ok ? 'ok' : 'FAIL'}`,
    ...a5.active.map((id) => `      active    ${id}`),
    ...a5.inactive.map((id) => `      name only ${id}`),
    '',
    `overall: ${a2.ok && a3.ok && a5.ok ? 'ok' : 'NOT ALL OK'}`,
  ]
  console.log(lines.join('\n'))
}

process.exit(a2.ok && a3.ok && a5.ok ? 0 : 1)
