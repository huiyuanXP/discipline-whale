/**
 * discipline-whale — shared domain: the report store and its on-disk layout.
 *
 * A worker finishing a task must leave a report the main session can consume.
 * Two halves, deliberately separated:
 *
 *   summary  — one short line, pushed into the main session's context so it can
 *              react immediately without calling a tool
 *   document — the long form, written to disk and read only when needed, so a
 *              detailed write-up cannot blow up the main session's context
 *
 * Storage is a per-workspace directory of one JSON value per report. The store
 * is append-mostly: a report is created once, then only its status changes.
 *
 * @module discipline-whale/store
 */

import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Directory name under $DSH_HOME that holds all of the plugin's data. */
export const STORE_DIRNAME = 'discipline-whale'

/** The main session's private working directory: backend storage, never a registered workspace. */
export const HOME_DIRNAME = 'home'

/** Every workspace's report folders live under this directory. */
export const REPORTS_DIRNAME = 'reports'

/** Set once a caller pins the store root, so late resolution cannot clobber it. */
let pinnedRoot

/**
 * The directory that holds every workspace's report folder.
 *
 * `$DSH_HOME` is the Harness home when the launcher sets it; otherwise the
 * conventional `~/.dsh`. A pinned root (config or test hook) wins over both.
 */
export function storeRoot() {
  if (pinnedRoot !== undefined) return pinnedRoot
  const env = process.env.DSH_HOME
  if (typeof env === 'string' && env !== '') return env
  return join(homedir(), '.dsh')
}

/** Pin the store root explicitly. Used by configuration and tests. */
export function setStoreRoot(path) {
  pinnedRoot = path
}

/** Drop a pinned root; the next read resolves from the environment again. */
export function clearStoreRoot() {
  pinnedRoot = undefined
}

/** Report lifecycle. `pending` means the worker has not reported yet. */
export const REPORT_STATUSES = ['pending', 'reported', 'delivered', 'abandoned']

/** Bound on the summary push so a runaway worker cannot flood the main session. */
export const MAX_SUMMARY_CHARS = 1200

/** Bound on a detailed document, in characters. */
export const MAX_DOCUMENT_CHARS = 200000

/** A stable, filesystem-safe key for one workspace. */
export function workspaceKey(workspaceId) {
  return String(workspaceId).replace(/[^A-Za-z0-9._-]/g, '_')
}

/** The plugin's data directory: `$DSH_HOME/discipline-whale`. */
export function dataDir(homeDir) {
  return join(homeDir, STORE_DIRNAME)
}

/** The main session's private working directory: `$DSH_HOME/discipline-whale/home`. */
export function whaleHomeDir(homeDir) {
  return join(dataDir(homeDir), HOME_DIRNAME)
}

/** The report directory for one workspace. */
export function reportDir(homeDir, workspaceId) {
  return join(dataDir(homeDir), REPORTS_DIRNAME, workspaceKey(workspaceId))
}

/** One report's file path. */
export function reportPath(homeDir, workspaceId, reportId) {
  return join(reportDir(homeDir, workspaceId), `${reportId}.json`)
}

/** Bound a summary to the push limit without cutting a surrogate pair. */
export function boundSummary(text) {
  const value = String(text ?? '').trim()
  if (value.length <= MAX_SUMMARY_CHARS) return value
  return `${value.slice(0, MAX_SUMMARY_CHARS - 1)}…`
}

/** Validate a report id: opaque, but must be filename-safe. */
export function isReportId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value)
}

/** Write one report atomically (temp file then rename). */
export async function writeReport(homeDir, report) {
  const dir = reportDir(homeDir, report.workspaceId)
  await mkdir(dir, { recursive: true })
  const target = reportPath(homeDir, report.workspaceId, report.id)
  const temp = `${target}.${process.pid}.tmp`
  await writeFile(temp, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  await rename(temp, target)
  return target
}

/** Read one report, or undefined when it is not there. */
export async function readReport(homeDir, workspaceId, reportId) {
  if (!isReportId(reportId)) return undefined
  try {
    const text = await readFile(reportPath(homeDir, workspaceId, reportId), 'utf8')
    return JSON.parse(text)
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

/** List every report in one workspace, newest first. */
export async function listReports(homeDir, workspaceId) {
  const dir = reportDir(homeDir, workspaceId)
  let entries
  try {
    entries = await readdir(dir)
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const reports = []
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    try {
      const text = await readFile(join(dir, entry), 'utf8')
      reports.push(JSON.parse(text))
    } catch {
      // A half-written or hand-edited file must not break the whole listing.
      continue
    }
  }
  reports.sort((left, right) => String(right.reportedAt ?? '').localeCompare(String(left.reportedAt ?? '')))
  return reports
}

/** Remove one report file. Used only by tests and explicit cleanup. */
export async function deleteReport(homeDir, workspaceId, reportId) {
  if (!isReportId(reportId)) return false
  try {
    await rm(reportPath(homeDir, workspaceId, reportId), { force: false })
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

/**
 * Track which reports already reached a main session.
 *
 * Delivery is "at most once per report per main session": a report is pushed
 * when it is first reported, and the delivery marker prevents a later drain
 * from pushing the same summary again.
 */
export function notYetDeliveredTo(reports, mainSessionId) {
  return reports.filter((report) => {
    if (report.status !== 'reported') return false
    const delivered = Array.isArray(report.deliveredTo) ? report.deliveredTo : []
    return !delivered.includes(mainSessionId)
  })
}
