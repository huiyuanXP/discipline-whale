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
 * Each workspace also has a one-line-per-report index file in the whale's
 * home, rewritten after every report and rebuilt by a reader that finds it
 * stale, so listing a workspace reads one small file.
 *
 * @module discipline-whale/store
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Directory name under $DSH_HOME that holds all of the plugin's data. */
export const STORE_DIRNAME = 'discipline-whale'

/** The main session's private working directory: backend storage, never a registered workspace. */
export const HOME_DIRNAME = 'home'

/** Every workspace's report folders live under this directory. */
export const REPORTS_DIRNAME = 'reports'

/** The report index files live under this directory inside the whale's home. */
export const INDEX_DIRNAME = 'index'

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

/**
 * How much of a document the default `head` read shows, in characters.
 *
 * The head exists so a main session can decide "is the detail worth it?"
 * without paying for a 12K-character document in every turn's context.
 */
export const PREVIEW_CHARS = 2000

/** Reports shorter than this come back whole instead of as a head preview. */
export const SMALL_REPORT_CHARS = 3000

/** The Host token meter's coarse basis: one token per four characters. */
export const CHARS_PER_TOKEN = 4

/** Estimate tokens for a character count on the same basis as the Host meter. */
export function estimateTokens(chars) {
  const value = Number(chars)
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.ceil(value / CHARS_PER_TOKEN)
}

/* ------------------------------------------------------------------ *
 * The `head` read: what a main session pays for when it asks for a report
 * ------------------------------------------------------------------ */

/** Opening or closing line of a fenced code block. */
const FENCE_LINE = /^\s*(`{3,}|~{3,})/

/** An ATX heading, captured down to the closing hashes. */
const ATX_HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/

/**
 * Read one line's fence marker, or undefined when it is not a fence line.
 *
 * A backtick fence's info string cannot contain a backtick, so ``` in prose
 * after the marker does not count; the marker itself is enough for the head.
 */
function fenceMarkerOf(line) {
  const match = FENCE_LINE.exec(line)
  if (match === null) return undefined
  const marker = match[1]
  if (marker[0] === '`' && line.slice(line.indexOf(marker) + marker.length).includes('`')) return undefined
  return { char: marker[0], length: marker.length }
}

/** The lines of a document, with the fence state after each one. */
function scanLines(document) {
  const lines = String(document ?? '').split('\n')
  let open
  // Line index of the fence that is still open at the end, when there is one.
  let openingLine = -1
  const state = lines.map((line, index) => {
    const marker = fenceMarkerOf(line)
    if (marker !== undefined && open === undefined) {
      open = marker
      openingLine = index
    } else if (
      marker !== undefined &&
      open !== undefined &&
      marker.char === open.char &&
      marker.length >= open.length &&
      line.trim() === marker.char.repeat(line.trim().length)
    ) {
      open = undefined
      openingLine = -1
    }
    return { line, inFence: open !== undefined }
  })
  return { lines, state, open, openingLine }
}

/**
 * The ATX h1-h3 headings of a document, outside code fences.
 *
 * Deeper headings (h4-h6) are detail, not structure: they cost context without
 * helping the "do I need the whole thing?" decision the head exists for.
 */
export function sectionHeadings(document) {
  const { state } = scanLines(document)
  const headings = []
  for (const entry of state) {
    if (entry.inFence) continue
    const match = ATX_HEADING.exec(entry.line)
    if (match === null) continue
    const level = match[1].length
    if (level > 3) continue
    const title = match[2].trim()
    if (title === '') continue
    headings.push({ level, title })
  }
  return headings
}

/**
 * Cut a document to a bounded preview that is still renderable Markdown.
 *
 * The cut has to respect three boundaries:
 *
 *   1. Surrogate pairs: cutting between a high and a low surrogate leaves a
 *      lone half, which JSON round-trips into a replacement character. Back off
 *      one unit so the pair stays whole.
 *   2. Open code fences: a preview that ends inside a fence swallows the rest
 *      of the message into a code block. Back off to the start of the opening
 *      fence line. When that fence starts at offset 0 there is nothing left to
 *      show, so keep the cut and append a closing fence of the same marker
 *      (`fenceClosed: true` marks that).
 *   3. A trailing newline: the appended fence has to start on its own line.
 */
export function previewDocument(document, limit = PREVIEW_CHARS) {
  const full = String(document ?? '')
  const bound = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.floor(Number(limit)) : PREVIEW_CHARS
  if (full.length <= bound) {
    return { text: full, truncated: false, fenceSafe: true, fenceClosed: false, cutAt: full.length }
  }

  let cutAt = bound
  const code = full.charCodeAt(cutAt - 1)
  if (code >= 0xd800 && code <= 0xdbff) cutAt -= 1

  let text = full.slice(0, cutAt)
  let fenceClosed = false

  // Walk the previewed lines only: fence state before the cut decides the cut.
  const { lines, open, openingLine } = scanLines(text)
  if (open !== undefined) {
    if (openingLine > 0) {
      // Back off to the start of the opening fence line. The kept text ends with
      // a newline (a single line keeps none), so the preview still ends cleanly.
      const kept = lines.slice(0, openingLine).join('\n')
      cutAt = kept === '' ? 0 : `${kept}\n`.length
      text = full.slice(0, cutAt)
    } else {
      // The fence opens at offset 0, so backing off would leave nothing: keep the
      // cut and close the fence with the same marker so Markdown still renders.
      text = `${text}${text.endsWith('\n') ? '' : '\n'}${open.char.repeat(open.length)}`
      fenceClosed = true
    }
  }

  return { text, truncated: true, fenceSafe: true, fenceClosed, cutAt }
}

/** How much of a summary an index line exposes: one line, never a paragraph. */
export const INDEX_SUMMARY_CHARS = 120

/** First line of a summary, bounded, for the one-line index. */
function summaryLine(summary, limit = INDEX_SUMMARY_CHARS) {
  const first = String(summary ?? '').split('\n')[0].replace(/\s+/g, ' ').trim()
  if (first.length <= limit) return first
  const slice = first.slice(0, limit - 1)
  const code = slice.charCodeAt(slice.length - 1)
  const safe = code >= 0xd800 && code <= 0xdbff ? slice.slice(0, -1) : slice
  return `${safe}…`
}

/**
 * The `head` payload for one report: everything a main session needs to decide
 * whether the document is worth reading, and nothing more.
 *
 * `document` is a preview, never the whole thing, unless the report is short
 * enough that a preview would cost more attention than it saves.
 */
export function summarizeReport(report, options = {}) {
  const document = String(report?.document ?? '')
  const chars = document.length
  const preview = previewDocument(document, options.previewChars ?? PREVIEW_CHARS)
  const small = chars < (options.smallChars ?? SMALL_REPORT_CHARS)
  // `sectionHeadings` is a head-only field: it is added in the head branch below,
  // never here, so the small-report branch cannot repeat what it already returns.
  const base = {
    id: report?.id,
    status: report?.status,
    outcome: report?.outcome,
    reportedAt: report?.reportedAt,
    workerSessionId: report?.workerSessionId,
    workspaceId: report?.workspaceId,
    workspaceTitle: report?.workspaceTitle,
    summary: report?.summary,
    chars,
    estimatedTokens: estimateTokens(chars),
  }

  if (small) {
    // A short report comes back whole, and a whole document already shows its
    // own headings. Repeating them (plus the preview bookkeeping) made this
    // branch cost 8-15% MORE than `mode:"full"` on six real reports — the exact
    // opposite of the shortcut's intent, which is "no extra round trip and no
    // penalty". So this branch carries the document and nothing redundant.
    // `test/report-head.mjs` ok 5 compares the two rendered payloads.
    return {
      report: { ...base, document, documentTruncated: false },
      returned: 'full (small report)',
    }
  }

  const hint =
    `This is a head: ${chars} characters (about ${estimateTokens(chars)} tokens) are behind it. ` +
    `To read the whole document call read_report(report_id="${report?.id}", mode="full"). ` +
    'Ask for it only when this preview and the headings do not answer the question.'

  return {
    report: {
      ...base,
      sectionHeadings: sectionHeadings(document),
      document: preview.text,
      documentTruncated: true,
      fenceClosed: preview.fenceClosed,
      previewChars: preview.text.length,
    },
    howToReadFull: hint,
    returned: 'head',
  }
}

/**
 * One line of a workspace's report index file.
 *
 * `- <reportedAt> [<status>/<outcome>] (revision of <id>) <label> · <summary> — <id>`.
 * The revision marker appears only on a report stored as a revision; the label
 * (what the main session called the dispatch) appears only when the report
 * carries one, and otherwise the summary's first line stands in for it.
 */
export function indexReportLine(report) {
  const reportedAt = String(report?.reportedAt ?? 'unknown')
  const status = String(report?.status ?? 'unknown')
  const outcome = String(report?.outcome ?? 'unknown')
  const revision = typeof report?.revisionOf === 'string' ? `(revision of ${report.revisionOf}) ` : ''
  const label = summaryLine(report?.label)
  const text = label === '' ? summaryLine(report?.summary) : `${label} · ${summaryLine(report?.summary)}`
  return `- ${reportedAt} [${status}/${outcome}] ${revision}${text} — ${report?.id}`
}

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

/** One workspace's report index file: `$DSH_HOME/discipline-whale/home/index/<key>.md`. */
export function reportIndexPath(homeDir, workspaceId) {
  return join(whaleHomeDir(homeDir), INDEX_DIRNAME, `${workspaceKey(workspaceId)}.md`)
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

/* ------------------------------------------------------------------ *
 * report index files: one Markdown page per workspace, in the whale's home
 * ------------------------------------------------------------------ */

/** Bound on the report lines one index file lists. */
export const INDEX_MAX_LINES = 100

/** How a long index splits: the newest reports first, then the oldest. */
const INDEX_HEAD_LINES = 75
const INDEX_TAIL_LINES = INDEX_MAX_LINES - INDEX_HEAD_LINES

/** The cross-workspace summary file next to the per-workspace index files. */
export const INDEX_SUMMARY_FILENAME = 'ALL.md'

/** The header comment every index file opens with; `count` is what self-healing checks. */
const INDEX_HEADER = /^<!-- generated by discipline-whale; count: (\d+); rebuilt: [^ ]+ -->$/m

/** The title line of a workspace index file. */
const INDEX_TITLE = /^# 报告索引 · (.*) \(([^()]*)\)$/m

/** The cross-workspace summary: `$DSH_HOME/discipline-whale/home/index/ALL.md`. */
export function indexSummaryPath(homeDir) {
  return join(whaleHomeDir(homeDir), INDEX_DIRNAME, INDEX_SUMMARY_FILENAME)
}

/** Write a text file atomically (temp file then rename). */
async function writeTextAtomic(target, text) {
  await mkdir(dirname(target), { recursive: true })
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temp, text, 'utf8')
  await rename(temp, target)
  return target
}

/** How many `*.json` report files one workspace's report folder holds. */
export async function countReportFiles(homeDir, workspaceId) {
  try {
    const entries = await readdir(reportDir(homeDir, workspaceId))
    return entries.filter((entry) => entry.endsWith('.json')).length
  } catch (error) {
    if (error?.code === 'ENOENT') return 0
    throw error
  }
}

/**
 * Render one workspace's report index. Pure.
 *
 * Newest first, one `indexReportLine` per report. Past `INDEX_MAX_LINES` the
 * page keeps the newest 75 and the oldest 25 around one 「… 省略 N 份 …」 line, so
 * both the current work and where the workspace started stay visible.
 */
export function renderReportIndex({ workspaceId, workspaceTitle, reports, rebuiltAt }) {
  const sorted = [...(reports ?? [])].sort((left, right) =>
    String(right?.reportedAt ?? '').localeCompare(String(left?.reportedAt ?? '')),
  )
  const lines = sorted.map((report) => indexReportLine(report))
  const body =
    lines.length <= INDEX_MAX_LINES
      ? lines
      : [
          ...lines.slice(0, INDEX_HEAD_LINES),
          `… 省略 ${lines.length - INDEX_MAX_LINES} 份 …`,
          ...lines.slice(lines.length - INDEX_TAIL_LINES),
        ]
  const title = workspaceTitle === undefined || workspaceTitle === '' ? String(workspaceId) : String(workspaceTitle)
  const stamp = rebuiltAt instanceof Date ? rebuiltAt.toISOString() : String(rebuiltAt)
  return [
    `# 报告索引 · ${title} (${workspaceId})`,
    `<!-- generated by discipline-whale; count: ${sorted.length}; rebuilt: ${stamp} -->`,
    ...body,
    '',
  ].join('\n')
}

/** Rebuild one workspace's index file from its report folder. Returns the file path. */
export async function writeReportIndex(homeDir, workspaceId, workspaceTitle) {
  const reports = await listReports(homeDir, workspaceId)
  const text = renderReportIndex({ workspaceId, workspaceTitle, reports, rebuiltAt: new Date() })
  return writeTextAtomic(reportIndexPath(homeDir, workspaceId), text)
}

/** Read one workspace's index file: `{ text, count }`, or undefined when there is none. */
export async function readReportIndex(homeDir, workspaceId) {
  let text
  try {
    text = await readFile(reportIndexPath(homeDir, workspaceId), 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
  const header = INDEX_HEADER.exec(text)
  return { text, count: header === null ? undefined : Number(header[1]) }
}

/**
 * Read one workspace's index file, rebuilding it first when it cannot be trusted.
 *
 * The file is trusted when it exists and its header `count` equals the number
 * of `*.json` files in the report folder. A missing file, a hand-edited one, or
 * one written before the newest report landed is rebuilt, and `rebuilt: true`
 * says so.
 */
export async function ensureReportIndex(homeDir, workspaceId, workspaceTitle) {
  const path = reportIndexPath(homeDir, workspaceId)
  const files = await countReportFiles(homeDir, workspaceId)
  const current = await readReportIndex(homeDir, workspaceId)
  if (current !== undefined && current.count === files) return { ...current, path, rebuilt: false }
  await writeReportIndex(homeDir, workspaceId, workspaceTitle)
  return { ...(await readReportIndex(homeDir, workspaceId)), path, rebuilt: true }
}

/**
 * Write `ALL.md`: one line per workspace with its report count and index path.
 *
 * Covers the workspaces passed in plus every workspace that already has an
 * index file, so a caller that knows only its own workspace keeps the other
 * lines. Counts come from the report folders themselves.
 */
export async function writeIndexSummary(homeDir, workspaces = []) {
  const indexDir = join(whaleHomeDir(homeDir), INDEX_DIRNAME)
  const rows = new Map()
  for (const workspace of workspaces) {
    if (workspace?.id === undefined) continue
    const key = workspaceKey(workspace.id)
    if (!rows.has(key)) rows.set(key, { id: String(workspace.id), title: workspace.title || String(workspace.id) })
  }
  let entries = []
  try {
    entries = await readdir(indexDir)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  for (const entry of entries) {
    if (!entry.endsWith('.md') || entry === INDEX_SUMMARY_FILENAME) continue
    const key = entry.slice(0, -'.md'.length)
    if (rows.has(key)) continue
    const title = INDEX_TITLE.exec(await readFile(join(indexDir, entry), 'utf8').catch(() => ''))
    rows.set(key, title === null ? { id: key, title: key } : { id: title[2], title: title[1] })
  }
  const ordered = [...rows.values()].sort((left, right) => left.title.localeCompare(right.title))
  const lines = []
  for (const row of ordered) {
    const count = await countReportFiles(homeDir, row.id)
    lines.push(`- ${row.title} (${row.id}) · ${count} 份 — ${reportIndexPath(homeDir, row.id)}`)
  }
  const text = [
    '# 报告索引 · 全部工作区',
    `<!-- generated by discipline-whale; workspaces: ${lines.length}; rebuilt: ${new Date().toISOString()} -->`,
    ...lines,
    '',
  ].join('\n')
  return writeTextAtomic(indexSummaryPath(homeDir), text)
}
