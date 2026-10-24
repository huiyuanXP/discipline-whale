/**
 * Dedupe replay — how many report pushes the M3 rule would have saved.
 *
 * Replays every pair of consecutive `report_to_main` calls in the real worker
 * Session logs through `shouldPushReport` (imported from worker.js, so the
 * replay and the plugin decide with the same function). For each pair:
 *
 *   events   — the worker's own log records before the second call
 *   previous — the newest delivered report of the same dispatch, reported
 *              before the second call, from the report library
 *   target   — the main session the second report reached (or was routed to)
 *   outcome  — the second call's `status` argument, `done` when omitted
 *
 * A second report stored as orphaned (its dispatch was lost in a restart, so
 * no main session was recorded) is never pushed by the plugin, so it never
 * reaches `shouldPushReport`; the replay counts it on its own line. The last
 * section regroups the pairs the way the 2026-10-24 measurement did — no
 * `source.kind: 'user'` message between the two calls and the same status —
 * and shows how that class splits between the two non-push paths.
 *
 * Read-only: it reads `$DSH_HOME/discipline-whale/reports/` and
 * `$DSH_HOME/sessions/<project>/<workerSessionId>/session.v4.jsonl.zstd`
 * (decoded with `readSessionRecords`, which handles multi-frame zstd) and
 * writes nothing.
 *
 * Usage:
 *   node scripts/dedupe-replay.mjs           # summary
 *   node scripts/dedupe-replay.mjs --pairs   # plus one line per pair
 */

import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { shouldPushReport } from '../worker.js'
import { readSessionRecords } from './context-audit.mjs'

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const REPORTS = join(DSH_HOME, 'discipline-whale', 'reports')
const SESSIONS = join(DSH_HOME, 'sessions')

/** Every report in the library, keyed by id. */
async function loadReports() {
  const byId = new Map()
  for (const workspace of await readdir(REPORTS).catch(() => [])) {
    for (const entry of await readdir(join(REPORTS, workspace)).catch(() => [])) {
      if (!entry.endsWith('.json')) continue
      try {
        const report = JSON.parse(await readFile(join(REPORTS, workspace, entry), 'utf8'))
        if (typeof report?.id === 'string') byId.set(report.id, report)
      } catch {
        // A half-written file is skipped, as the plugin's own listing does.
      }
    }
  }
  return byId
}

/** The log path of one worker Session, or undefined when it is gone. */
async function logOf(workerSessionId) {
  for (const project of await readdir(SESSIONS).catch(() => [])) {
    const path = join(SESSIONS, project, workerSessionId, 'session.v4.jsonl.zstd')
    if (existsSync(path)) return path
  }
  return undefined
}

/** Parsed arguments of a tool/call record. */
function argsOf(call) {
  const raw = call.data?.arguments
  if (typeof raw !== 'string') return raw ?? {}
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

/** What the tool returned for one call: `{ isError, value }`, or undefined when no result was logged. */
function resultOf(records, call) {
  const result = records.find(
    (record) => record.type === 'tool/result' && record.data?.message?.toolCallId === call.data?.callId,
  )
  if (result === undefined) return undefined
  const text = (result.data.message.content ?? []).map((part) => part?.text ?? '').join('')
  let value
  try {
    value = JSON.parse(text)
  } catch {
    value = undefined
  }
  return { isError: result.data.message.isError === true, value }
}

/** `source.kind` of every user/message strictly between two records. */
function kindsBetween(records, left, right) {
  return records
    .filter((record) => record.type === 'user/message' && record.seq > left.seq && record.seq < right.seq)
    .map((record) => record.data?.source?.kind ?? 'none')
}

/** The same classes the 2026-10-24 measurement used. */
function betweenClass(kinds) {
  if (kinds.includes('user')) return 'new instruction'
  if (kinds.includes('dsh-doublecheck')) return 'only dsh-doublecheck nudge'
  if (kinds.length === 0) return 'same turn, no message between'
  return `other notices only (${[...new Set(kinds)].sort().join(', ')})`
}

/** A verdict reason with its ids replaced, so equal reasons group together. */
const reasonKey = (reason) => reason.replace(/r-[0-9a-f-]{36}/g, '<id>').replace(/session-[0-9a-f-]{36}/g, '<main>')

const count = (map, key) => map.set(key, (map.get(key) ?? 0) + 1)

async function main() {
  const showPairs = process.argv.includes('--pairs')
  const reports = await loadReports()
  const workers = [...new Set([...reports.values()].map((report) => report.workerSessionId).filter(Boolean))].sort()

  let logs = 0
  let pairs = 0
  let suppressed = 0
  let orphaned = 0
  const repeats = { total: 0, suppressed: 0, orphaned: 0, pushed: 0 }
  const reasons = new Map()
  const between = new Map()
  const resolved = new Map()
  const rows = []

  for (const workerSessionId of workers) {
    const path = await logOf(workerSessionId)
    if (path === undefined) continue
    logs += 1
    const records = readSessionRecords(path)
    const calls = records.filter((record) => record.type === 'tool/call' && record.data?.name === 'report_to_main')
    for (let index = 1; index < calls.length; index += 1) {
      const [left, right] = [calls[index - 1], calls[index]]
      pairs += 1
      const leftResult = resultOf(records, left)
      const rightResult = resultOf(records, right)
      const leftReport = reports.get(leftResult?.value?.reportId)
      const rightReport = reports.get(rightResult?.value?.reportId)
      const outcome = argsOf(right).status ?? 'done'
      const dispatchId = rightReport?.dispatchId ?? leftReport?.dispatchId
      const before = rightReport?.reportedAt ?? new Date(right.time).toISOString()

      // The library answers `previous` the way the plugin reads it; a pair whose
      // reports are gone falls back to what the first call's result said.
      let previous
      if (dispatchId !== undefined) {
        previous = [...reports.values()]
          .filter((report) => report.dispatchId === dispatchId && report.status === 'delivered' && String(report.reportedAt) < before)
          .sort((a, b) => String(b.reportedAt).localeCompare(String(a.reportedAt)))[0]
        count(resolved, 'previous from the report library')
      } else {
        count(resolved, 'previous from the first call\'s result (reports not in the library)')
      }
      const target = rightReport?.deliveredTo?.[0] ?? rightReport?.mainSessionId ?? previous?.deliveredTo?.[0] ?? leftReport?.deliveredTo?.[0]
      if (previous === undefined && dispatchId === undefined && leftResult?.value?.deliveredToMain === true) {
        previous = { id: leftResult.value.reportId, outcome: argsOf(left).status ?? 'done', deliveredTo: [target] }
      }

      const kinds = kindsBetween(records, left, right)
      const repeat = !kinds.includes('user') && (argsOf(left).status ?? 'done') === outcome
      if (repeat) repeats.total += 1
      let verdict
      if (rightReport?.orphaned === true) {
        orphaned += 1
        if (repeat) repeats.orphaned += 1
        verdict = { push: false, reason: 'orphaned, no main session recorded' }
        count(reasons, `not pushed: ${verdict.reason}`)
      } else {
        verdict = shouldPushReport({ previous, events: records.filter((record) => record.seq < right.seq), outcome, target })
        if (!verdict.push) suppressed += 1
        if (repeat) repeats[verdict.push ? 'pushed' : 'suppressed'] += 1
        count(reasons, `${verdict.push ? 'push' : 'suppress'}: ${reasonKey(verdict.reason)}`)
      }
      const path = rightReport?.orphaned === true ? 'orphaned' : verdict.push ? 'push' : 'suppress'
      count(between, `${betweenClass(kinds)} → ${path}`)
      rows.push(
        `  ${workerSessionId} seq ${left.seq}→${right.seq} ${argsOf(left).status ?? 'done'}→${outcome} ` +
          `${path.padEnd(8)} ${reasonKey(verdict.reason)}`,
      )
    }
  }

  const sorted = (map) => [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const lines = [
    '# Dedupe replay',
    '',
    `report library: ${REPORTS} (${reports.size} reports, ${workers.length} worker sessions)`,
    `worker logs read: ${logs}`,
    `consecutive report_to_main pairs: ${pairs}`,
    `suppressed (stored as a revision): ${suppressed}`,
    `orphaned second report (never pushed): ${orphaned}`,
    `pushed: ${pairs - suppressed - orphaned}`,
    '',
    'by verdict:',
    ...sorted(reasons).map(([key, value]) => `  ${String(value).padStart(3)}  ${key}`),
    '',
    'by what came between the two calls:',
    ...sorted(between).map(([key, value]) => `  ${String(value).padStart(3)}  ${key}`),
    '',
    'previous resolved:',
    ...sorted(resolved).map(([key, value]) => `  ${String(value).padStart(3)}  ${key}`),
    '',
    `no new instruction + same status (the 2026-10-24 class): ${repeats.total}`,
    `  ${String(repeats.suppressed).padStart(3)}  suppressed by shouldPushReport`,
    `  ${String(repeats.orphaned).padStart(3)}  orphaned, never pushed`,
    `  ${String(repeats.pushed).padStart(3)}  pushed`,
  ]
  if (showPairs) lines.push('', 'pairs:', ...rows)
  console.log(lines.join('\n'))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
