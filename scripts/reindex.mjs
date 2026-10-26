#!/usr/bin/env node
/**
 * One-shot backfill of the report index files (T5).
 *
 * The index pages under `<DSH_HOME>/discipline-whale/home/index/` are written by
 * `worker.js` right after `report_to_main` stores a report — nothing writes them
 * for reports that predate that code. An instance upgraded to 0.7.0 therefore
 * keeps a notes pointer (`索引：index/<key>.md`) aimed at a file that does not
 * exist until the *next* report lands.
 *
 * This script runs the same idempotent `ensureReportIndex` over every workspace
 * that has a report folder, then rewrites `ALL.md`. It never reads or writes
 * anything outside `<DSH_HOME>/discipline-whale/{reports,home/index}` and
 * `<DSH_HOME>/storages/workspace.json` (titles only).
 *
 *   node scripts/reindex.mjs                 # dry-run: report only, no writes
 *   node scripts/reindex.mjs --apply         # write the index pages
 *   node scripts/reindex.mjs --home /tmp/x   # operate on another DSH_HOME
 *   node scripts/reindex.mjs --json          # machine-readable result
 *
 * Idempotent by construction: `ensureReportIndex` compares the header `count`
 * with the number of readable reports and returns `rebuilt: false` when they
 * agree, so a second `--apply` writes nothing.
 *
 * Exit codes: 0 success, 1 hard failure, 2 nothing to do / drift found in
 * dry-run (so a caller can tell "already consistent" from "would change").
 */

import { readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import {
  countReportFiles,
  dataDir,
  ensureReportIndex,
  indexSummaryPath,
  listReports,
  readReportIndex,
  reportIndexPath,
  setStoreRoot,
  whaleHomeDir,
  writeIndexSummary,
  REPORTS_DIRNAME,
} from '../store.js'

/** Parse `--flag`, `--key value` pairs. */
function parseArgs(argv) {
  const options = { apply: false, json: false, home: undefined, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--apply') options.apply = true
    else if (arg === '--json') options.json = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--home') {
      options.home = argv[index + 1]
      index += 1
    } else if (arg.startsWith('--home=')) options.home = arg.slice('--home='.length)
    else throw new Error(`unknown argument "${arg}" (try --help)`)
  }
  return options
}

function usage() {
  return [
    'Usage: node scripts/reindex.mjs [--apply] [--home <DSH_HOME>] [--json]',
    '',
    '  (no flag)   dry-run: list what would be rebuilt, write nothing',
    '  --apply     rewrite the index pages and ALL.md',
    '  --home DIR  operate on DIR instead of $DSH_HOME (default ~/.dsh)',
    '  --json      print the result as JSON',
  ].join('\n')
}

/** The home directory to operate on, resolved the same way the plugin does. */
function resolveHome(options) {
  if (options.home !== undefined && options.home !== '') return options.home
  const env = process.env.DSH_HOME
  if (typeof env === 'string' && env !== '') return env
  return join(homedir(), '.dsh')
}

/**
 * Workspace ids to backfill: report folders, existing index pages, and the Host's
 * registry.
 *
 * All three matter. A folder with no index is the case this script exists to
 * heal; a workspace with an index but no folder keeps its (0-report) page; and a
 * registered workspace with neither is still listed in `ALL.md` as `0 份` — the
 * main session's summary — so dropping it would silently shrink that summary.
 */
async function discoverWorkspaceIds(home, registryTitles) {
  const ids = new Set(registryTitles.keys())
  try {
    for (const entry of await readdir(join(dataDir(home), REPORTS_DIRNAME), { withFileTypes: true })) {
      if (entry.isDirectory()) ids.add(entry.name)
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  try {
    for (const entry of await readdir(join(whaleHomeDir(home), 'index'))) {
      if (entry.endsWith('.md') && entry !== 'ALL.md') ids.add(entry.slice(0, -'.md'.length))
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  return [...ids].sort()
}

/**
 * Titles by workspace id, from the Host's workspace registry.
 *
 * `storages/workspace.json` is the Host's own table file (`tables.workspaces`
 * keyed by id). It is read for display only: a missing or reshaped file must
 * not stop the backfill, so every failure here degrades to "no titles".
 */
async function readWorkspaceTitles(home) {
  const titles = new Map()
  let raw
  try {
    raw = JSON.parse(await readFile(join(home, 'storages', 'workspace.json'), 'utf8'))
  } catch {
    return titles
  }
  const table = raw?.tables?.workspaces
  if (table === null || typeof table !== 'object') return titles
  for (const [id, value] of Object.entries(table)) {
    const title = value?.title
    if (typeof title === 'string' && title !== '') titles.set(id, title)
  }
  return titles
}

/** The title of an existing index page, or undefined. */
async function indexTitle(home, workspaceId) {
  const current = await readReportIndex(home, workspaceId)
  if (current === undefined) return undefined
  const match = /^# 报告索引 · (.*) \([^()]*\)$/m.exec(current.text)
  return match === null ? undefined : match[1]
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(`${usage()}\n`)
    return 0
  }

  const home = resolveHome(options)
  setStoreRoot(home)

  const registryTitles = await readWorkspaceTitles(home)
  const ids = await discoverWorkspaceIds(home, registryTitles)
  if (ids.length === 0) {
    process.stderr.write(`reindex: no workspaces found under ${join(dataDir(home), REPORTS_DIRNAME)}\n`)
    return 1
  }

  const rows = []
  for (const id of ids) {
    const title = registryTitles.get(id) ?? (await indexTitle(home, id)) ?? id
    const files = await countReportFiles(home, id)
    const readable = (await listReports(home, id)).length
    const current = await readReportIndex(home, id)
    // What `ensureReportIndex` would decide, computed without writing.
    const stale = current === undefined || current.count !== readable
    const row = {
      workspaceId: id,
      title,
      files,
      readable,
      before: current?.count ?? null,
      after: readable,
      path: reportIndexPath(home, id),
      action: stale ? (current === undefined ? 'create' : 'rebuild') : 'keep',
    }
    if (options.apply) {
      // Always run the real backfill, even for a page that looks current: the
      // call itself is idempotent (it returns `rebuilt: false` without writing
      // when the header count already matches) and running it unconditionally
      // is what makes the second call below a proof for every workspace rather
      // than only for the ones this run happened to touch.
      const written = await ensureReportIndex(home, id, title)
      row.after = written.count ?? readable
      // A second call is the idempotence proof for this workspace: nothing was
      // written between the two, so `rebuilt` must be false now.
      const again = await ensureReportIndex(home, id, title)
      row.rebuiltAgain = again.rebuilt
      if (again.rebuilt) row.action = 'rebuild'
    }
    rows.push(row)
  }

  const changed = rows.filter((row) => row.action !== 'keep')
  let summaryPath
  let summaryRebuilt = false
  if (options.apply) {
    summaryPath = await writeIndexSummary(home, rows.map((row) => ({ id: row.workspaceId, title: row.title })))
    summaryRebuilt = true
  } else {
    summaryPath = indexSummaryPath(home)
  }

  const result = {
    home,
    mode: options.apply ? 'apply' : 'dry-run',
    workspaces: rows.length,
    reportsTotal: rows.reduce((total, row) => total + row.readable, 0),
    filesTotal: rows.reduce((total, row) => total + row.files, 0),
    wouldChange: changed.length,
    summaryPath,
    summaryRebuilt,
    rows,
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } else {
    const lines = [
      `reindex ${result.mode} · home=${home}`,
      `workspaces=${result.workspaces} reports=${result.reportsTotal} files=${result.filesTotal} would-change=${result.wouldChange}`,
      '',
    ]
    for (const row of rows) {
      const before = row.before === null ? 'missing' : `count=${row.before}`
      const extra = row.rebuiltAgain === undefined ? '' : ` rebuiltAgain=${row.rebuiltAgain}`
      lines.push(`- ${row.title} (${row.workspaceId}) files=${row.files} ${before} -> count=${row.after} ${row.action}${extra}`)
    }
    lines.push('', `${options.apply ? 'wrote' : 'would write'}: ${summaryPath}`)
    if (!options.apply && changed.length > 0) lines.push('', 'dry-run only: re-run with --apply to write these pages')
    process.stdout.write(`${lines.join('\n')}\n`)
  }

  if (!options.apply) return changed.length === 0 ? 0 : 2
  return 0
}

main().then(
  (code) => {
    process.exitCode = code
  },
  (error) => {
    process.stderr.write(`reindex: ${error?.stack ?? error}\n`)
    process.exitCode = 1
  },
)
